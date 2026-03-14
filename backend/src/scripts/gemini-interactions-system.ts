import {Socket} from 'socket.io';
import {GoogleGenAI, Modality, type Schema, type Session, Type, StartSensitivity, EndSensitivity} from "@google/genai"
import {MediaSearchService} from './media-search-service.js'
import { db } from './firebase.js';

// constants
const LIVE_PROMPT = `You are a warm, gentle, and encouraging learning companion for little ones aged 2 to 6. You interact through real-time audio and video, meaning you share their world, see what they see, and chat with them just like a supportive, friendly playmate. 
### Your Heart and Boundaries
* Be a gentle guide: Be an active, patient listener. Instead of just handing out answers, gently guide the child to discover things on their own, sparking their natural curiosity and wonder. 
* Speak their language: Talk with the warmth, patience, and simplicity of a caring helper. Keep your words and tone easy for a toddler or preschooler to grasp.
* Respect the parents' role: Remember, you are a companion, not a parent or guardian. Never step into a parental role, and leave discipline, safety interventions, and deep personal guidance to the real-life grown-ups in the room. 
* Read the room: Pay close attention to their physical world and their feelings. Notice if a tower of blocks is getting wobbly, or if a child's face looks frustrated. 
* Embrace quiet moments: Know when to just watch and smile. If the child is deeply focused on a puzzle, chatting with a sibling, or having a tough emotional moment, give them space. Do not interrupt; just be a quiet, supportive presence.

### Seeing and Sharing Their World
* Notice the little things: Use your "eyes" (the video feed) to truly see their environment. If they pick up a crunchy autumn leaf, feel a fuzzy blanket, or draw a squiggly blue line, use those details to start a fun conversation.
* Ask playful questions: Spark dialogue based on what they are doing right in that moment. Try open-ended questions like, "Wow, how many blocks did you stack there?" or "Can you tell me a story about your wonderful drawing?"
* Build a friendship: Remember what makes them unique. Keep track of their favorite colors, the names of their stuffed animals, and the topics they love, using these details to make your time together feel special and personalized over time.

### Your Guiding Principles
1. Always be present: Watch and listen closely at all times.
2. Add value, not noise: Chime in only when your words bring a smile, a comforting thought, or a fun learning moment.
3. Bring ideas to life: Use your Augmented Reality (AR) tools like magic to make tricky or abstract ideas visual, playful, and interactive.
4. Tidy up: Clear away your AR visuals and playful graphics when the activity is over so their view stays clean and focused. 
5. Safety first: Above all else, let the child's safety, happiness, and current developmental stage guide every single thing you do.`;
const HELPER_PROMPT = "";

type ToolData = {
    handler: Function,
    description: string,
    schema: Schema
}

class Tools {
    private static readonly HELPER_MODEL = "gemini-2.5-flash-lite";
    private tools: Record<string, ToolData>;
    constructor(AI: GoogleGenAI, user_socket: Socket) {
        this.tools = {};
    }

    public register(name: string, description: string, properties: Record<string, Schema>, handler: Function) {
        this.tools[name] = {handler, description, schema: properties};
    }

    public get_tools_schema() {
        const declarations = Object.entries(this.tools).map(([name, tool]) => ({
            name,
            description: tool.description,
            parameters: {
                type: Type.OBJECT,
                properties: tool.schema as Record<string, Schema>,
                // Assume all defined parameters are required for simplicity,
                // or filter based on a 'required' flag in metadata.
                required: Object.keys(tool.schema),
            },
        }));

        if (declarations.length === 0) return [];
        return [{ functionDeclarations: declarations }];
    }
}

// the analogy I like is we're giving Gemini a driver seat, and teaching it how to drive.
// Gemini will obviously make mistakes driving the vehicle from time-to-time, so it's up to us
// (the developers) to build a safe vehicle, potentially with some nice self driving.
export class GeminiInteractionSystem {
    private static readonly LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
    private static readonly LIVE_VOICE_NAME = "Aoede";
    private AI: GoogleGenAI;
    private socket: Socket;
    private session: Session | null = null;
    private tools: Tools;
    private mediaSearch: MediaSearchService;
    private audioBuffer: Int16Array = new Int16Array(0);

    private sessionId: string;
    private sessionMessages: { role: 'user' | 'model', text: string, timestamp: number }[] = [];
    private sessionRef: FirebaseFirestore.DocumentReference;

    
    constructor(api_key: string, user_socket: Socket) {
        this.AI = new GoogleGenAI({apiKey: api_key, httpOptions: {"apiVersion": "v1alpha"}});
        this.socket = user_socket;
        this.tools = new Tools(this.AI, user_socket);
        this.mediaSearch = new MediaSearchService();
        
        this.sessionId = Date.now().toString();
        this.sessionRef = db.collection('families').doc('default').collection('children').doc('default').collection('sessions').doc(this.sessionId);
        
        // Cannot use 'await' in constructor, but firestore writes are optimistic
        this.sessionRef.set({
            startedAt: Date.now(),
            summary: "",
            messages: []
        });

        this.initialize_tools();
        this.AI.live.connect({
            model: GeminiInteractionSystem.LIVE_MODEL,
            callbacks: {
                onopen: () => {
                    console.log("A user has connected to the Gemini Live API!")
                },
                onclose: () => {
                    this.session?.close();
                    this.shutdown_sockets();
                },
                onmessage: (message) => {
                    const content = message.serverContent;
                    if (content?.modelTurn?.parts) {
                        for (const part of content.modelTurn.parts) {
                            if (part.inlineData?.data) {
                                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                                this.socket.emit('audio-out', audioBuffer);
                            }
                        }
                    }
                    if (content?.interrupted) {
                        this.socket.emit('interrupted');
                    }
                    if (content?.inputTranscription) {
                        this.socket.emit('transcription', { type: 'user', text: content.inputTranscription.text });
                        this.sessionMessages.push({ role: 'user', text: content.inputTranscription.text || "", timestamp: Date.now() });
                        this.sessionRef.update({ messages: this.sessionMessages }).catch(console.error);
                    }
                    if (content?.outputTranscription) {
                        this.socket.emit('transcription', { type: 'model', text: content.outputTranscription.text });
                        this.sessionMessages.push({ role: 'model', text: content.outputTranscription.text || "", timestamp: Date.now() });
                        this.sessionRef.update({ messages: this.sessionMessages }).catch(console.error);
                    }
                    if (message.toolCall) {
                        console.log("Tools to call:", message.toolCall.functionCalls);
                        this.handle_tool_calls(message.toolCall.functionCalls || []);
                    }
                },
                onerror: (error) => {
                    console.error("Error connecting to Gemini Live API (non catch):\n", error);
                    this.session?.close();
                    this.shutdown_sockets();
                }
            },
            config: {
                systemInstruction: { parts: [{ text: LIVE_PROMPT }] },
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: GeminiInteractionSystem.LIVE_VOICE_NAME,
                        },
                    },
                },
                enableAffectiveDialog: true,
                tools: this.tools?.get_tools_schema() || [],
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: false,
                        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                        prefixPaddingMs: 20,
                        silenceDurationMs: 100,
                    }
                }
            }
        }).then(session => {
            this.session = session;
            this.initialize_sockets();
        }).catch(error => {
            console.error("There was an error connecting to Gemini Live API:\n", error);
            this.shutdown_sockets();
        });
    }

    private initialize_sockets() {
        this.socket.on('video-frame', (data: string) => {
            this.handle_video_frame(data);
        });

        this.socket.on("audio-chunk", (data: any) => {
            this.handle_audio_chunk(data);
        });

        this.socket.on("disconnect", () => {
            console.log("Client disconnected");
            this.generateSummary().finally(() => {
                this.shutdown_sockets();
                this.session?.close();
            });
        });
    }

    private async generateSummary() {
        if (this.sessionMessages.length === 0) return;
        
        try {
            console.log("Generating session summary...");
            const transcript = this.sessionMessages.map(m => `${m.role}: ${m.text}`).join('\n');
            const response = await this.AI.models.generateContent({
                model: 'gemini-2.5-flash-lite',
                contents: `Summarize the following conversation between a child (user) and an AI companion (model). Keep it to 2-3 sentences. Focus on what the child was interested in or learning about:\n\n${transcript}`
            });
            const summary = response.text || "No summary available.";
            
            await this.sessionRef.update({
                endedAt: Date.now(),
                summary: summary
            });
            console.log("Session summary saved.");
        } catch (error) {
            console.error("Error generating or saving summary:", error);
        }
    }

    private shutdown_sockets() {
        this.socket.removeAllListeners();
        this.socket.disconnect();
    }

    private initialize_tools() {
        this.tools.register("add_memory", "adds a memory that can be recalled in the future",
            {
                "memory": {
                    type: Type.STRING,
                    description: "The memory to be remembered."
                }
            }, (memory: string) => {
                console.log("add_memory called with memory:", memory);
            })

        this.tools.register("show_visual",
            "Shows the child an image or video when they ask about or mention something visual, like a place, animal, object, or concept. Use this to bring their curiosity to life with a picture or a short video.",
            {
                "query": {
                    type: Type.STRING,
                    description: "A short search query for the visual, e.g. 'Eiffel Tower', 'dinosaur', 'solar system'"
                },
                "type": {
                    type: Type.STRING,
                    description: "The type of media to show: 'image' or 'video'"
                }
            },
            async (args: { query: string, type: string }) => {
                console.log(`show_visual called: query="${args.query}", type="${args.type}"`);
                await this.fetch_and_emit_media(args.query, args.type);
            }
        );
    }

    /**
     * Fetches media from Google APIs and emits the result to the frontend.
     */
    private async fetch_and_emit_media(query: string, type: string) {
        try {
            if (type === 'video') {
                const result = await this.mediaSearch.searchVideo(query);
                if (result) {
                    this.socket.emit('tool-call', {
                        name: 'show_visual',
                        args: {
                            type: 'video',
                            videoId: result.videoId,
                            title: result.title,
                            thumbnail: result.thumbnail,
                        }
                    });
                    console.log(`Sent video to client: ${result.title}`);
                }
            } else {
                const result = await this.mediaSearch.searchImage(query);
                if (result) {
                    this.socket.emit('tool-call', {
                        name: 'show_visual',
                        args: {
                            type: 'image',
                            url: result.url,
                            title: result.title,
                            source: result.source,
                        }
                    });
                    console.log(`Sent image to client: ${result.title}`);
                }
            }
        } catch (error) {
            console.error('Error fetching media:', error);
        }
    }

    /**
     * Executes tool calls received from Gemini and sends responses back to the session.
     */
    private async handle_tool_calls(functionCalls: any[]) {
        if (!functionCalls || !this.session) return;

        const responses = [];
        for (const call of functionCalls) {
            const toolName = call.name;
            const toolArgs = call.args;
            const toolData = (this.tools as any).tools[toolName];

            if (toolData) {
                try {
                    await toolData.handler(toolArgs);
                    responses.push({
                        id: call.id,
                        name: toolName,
                        response: { success: true },
                    });
                } catch (error) {
                    console.error(`Error executing tool ${toolName}:`, error);
                    responses.push({
                        id: call.id,
                        name: toolName,
                        response: { success: false, error: String(error) },
                    });
                }
            }
        }

        // Send tool responses back to Gemini so it can continue the conversation
        if (responses.length > 0) {
            try {
                await this.session.sendToolResponse({
                    functionResponses: responses,
                });
            } catch (error) {
                console.error('Error sending tool response:', error);
            }
        }
    }

    private handle_video_frame(data: string) {
        // data is base64 string with header: data:image/jpeg;base64,...
        const base64Data = data.split(',')[1];
        if (!base64Data) return;
        
        this.session?.sendRealtimeInput({
          video: { data: base64Data, mimeType: 'image/jpeg' }
        });
    }

    private handle_audio_chunk(data: any) {
        let pcmData: Int16Array;

        if (Buffer.isBuffer(data)) {
            // Socket.io in Node.js often delivers ArrayBuffer as Buffer.
            // If the buffer is unaligned to 2 bytes, we must copy it to a new ArrayBuffer
            // to avoid "RangeError: start offset of Int16Array should be a multiple of 2".
            if (data.byteOffset % 2 !== 0) {
                const aligned = new Uint8Array(data.byteLength);
                aligned.set(data);
                pcmData = new Int16Array(aligned.buffer, 0, data.byteLength >> 1);
            } else {
                pcmData = new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
            }
        } else if (data instanceof ArrayBuffer) {
            pcmData = new Int16Array(data);
        } else if (data instanceof Int16Array) {
            pcmData = data;
        } else {
            pcmData = new Int16Array(data);
        }

        if (pcmData.length === 0) return;

        // Buffer audio to send larger chunks (e.g., ~100ms / 1600 samples)
        const newBuffer = new Int16Array(this.audioBuffer.length + pcmData.length);
        newBuffer.set(this.audioBuffer);
        newBuffer.set(pcmData, this.audioBuffer.length);
        this.audioBuffer = newBuffer;

        if (this.audioBuffer.length >= 1600) {
            const base64Audio = Buffer.from(this.audioBuffer.buffer, this.audioBuffer.byteOffset, this.audioBuffer.byteLength).toString('base64');
            this.session?.sendRealtimeInput({
                audio: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' }
            });
            this.audioBuffer = new Int16Array(0);
        }
    }
}
