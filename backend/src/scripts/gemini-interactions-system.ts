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
const LIVE_COPLAY_GUIDANCE = `
### AR Teaching and Co-Play
* When the child shows you a flower, machine, animal, toy, shape, or color-rich object, use AR teaching tools to make the moment visual and interactive.
* Keep co-play loops short, concrete, and playful. One task at a time.
* Good AR teaching examples:
  - flower -> petals, colors, counting
  - machine -> wheel, button, handle, gear
  - animal -> ears, tail, paws, colors
* If you start a scavenger hunt, clearly say what to find and keep watching the camera until the child finds it.
* When the child succeeds, celebrate briefly with the success tool and then either ask one follow-up or end the activity.
* If the child loses interest or switches topics, clear the overlay and return to normal conversation.
* Do not stack many activities at once. Finish or end the current one first.`;
const LIVE_GENERATED_AR_GUIDANCE = `
### Generated AR Objects
* If the child asks you to show a creature or object on a real surface, like "show me a dinosaur on my table", use the generated AR object tool.
* Use generated AR objects for magical demo moments: dinosaurs on tables, stars on a pillow, a tiny robot on a desk.
* Prefer clear flat anchors like table, desk, floor, book, or wall.
* If the child changes subjects, remove the generated AR object.`;
const HELPER_PROMPT = "";

type ToolData = {
    handler: Function,
    description: string,
    schema: Schema
}

type CoPlayMode = 'idle' | 'teaching' | 'scavenger_hunt';

type CoPlayState = {
    mode: CoPlayMode;
    objectType?: string;
    focus?: string;
    targetType?: string;
    targetValue?: string;
    prompt?: string;
};

type SessionActivity = {
    type: string;
    title: string;
    detail: string;
    timestamp: number;
};

type ArOverlayPayload = {
    mode: 'teaching' | 'hunt' | 'success';
    badge: string;
    title: string;
    subtitle?: string;
    prompt?: string;
    accent?: string;
    items?: string[];
    celebration?: boolean;
};

type AnchorBox = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

type GeneratedArObjectState = {
    objectName: string;
    anchorTarget: string;
    imageDataUrl: string;
    prompt?: string;
    accent: string;
};

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
    private VertexAI: GoogleGenAI;
    private socket: Socket;
    private session: Session | null = null;
    private tools: Tools;
    private mediaSearch: MediaSearchService;
    private audioBuffer: Int16Array = new Int16Array(0);

    private sessionId: string;
    private sessionMessages: { role: 'user' | 'model', text: string, timestamp: number }[] = [];
    private sessionRef: FirebaseFirestore.DocumentReference;
    private coPlayState: CoPlayState = { mode: 'idle' };
    private sessionActivities: SessionActivity[] = [];
    private latestFrameBase64: string | null = null;
    private activeGeneratedArObject: GeneratedArObjectState | null = null;
    private generatedSpriteCache = new Map<string, string>();

    
    constructor(api_key: string, user_socket: Socket) {
        this.AI = new GoogleGenAI({apiKey: api_key, httpOptions: {"apiVersion": "v1alpha"}});
        this.VertexAI = new GoogleGenAI({
            vertexai: true,
            project: process.env.GOOGLE_PROJECT_ID || "",
            location: process.env.GOOGLE_LOCATION || "us-central1"
        });
        this.socket = user_socket;
        this.tools = new Tools(this.AI, user_socket);
        this.mediaSearch = new MediaSearchService();
        
        this.sessionId = Date.now().toString();
        this.sessionRef = db.collection('families').doc('default').collection('children').doc('default').collection('sessions').doc(this.sessionId);
        
        // Cannot use 'await' in constructor, but firestore writes are optimistic
        this.sessionRef.set({
            startedAt: Date.now(),
            summary: "",
            messages: [],
            activities: [],
            coPlayState: this.coPlayState,
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
                systemInstruction: { parts: [{ text: `${LIVE_PROMPT}\n${LIVE_COPLAY_GUIDANCE}\n${LIVE_GENERATED_AR_GUIDANCE}` }] },
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

        this.socket.on('request-ar-anchor-refresh', async () => {
            await this.refreshGeneratedArAnchor();
        });

        this.socket.on('clear-generated-ar-object', () => {
            this.activeGeneratedArObject = null;
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
                contents: `Summarize the following conversation between a child (user) and an AI companion (model). Keep it to 2-3 sentences. Focus on what the child was interested in or learning about. If helpful, mention the short AR or co-play activities Janus guided.

Activities:
${this.sessionActivities.map(activity => `- ${activity.title}: ${activity.detail}`).join('\n') || '- None'}

Transcript:
${transcript}`
            });
            const summary = response.text || "No summary available.";
            
            await this.sessionRef.update({
                endedAt: Date.now(),
                summary: summary,
                activities: this.sessionActivities,
                coPlayState: this.coPlayState,
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
                return { remembered: true };
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
                return await this.fetch_and_emit_media(args.query, args.type);
            }
        );

        this.tools.register("start_ar_teaching",
            "Starts a grounded AR teaching moment for an object the child is showing, like a flower, machine, animal, shape, or toy.",
            {
                "objectType": {
                    type: Type.STRING,
                    description: "The object category, such as flower, machine, animal, car, or star."
                },
                "focus": {
                    type: Type.STRING,
                    description: "A short teaching focus, such as count petals, name colors, or find the wheels."
                },
                "prompt": {
                    type: Type.STRING,
                    description: "A very short next instruction for the child."
                }
            },
            async (args: { objectType: string, focus: string, prompt: string }) => {
                const objectType = args.objectType.trim();
                const focus = args.focus.trim();
                const prompt = args.prompt.trim();
                const items = this.buildTeachingItems(objectType, focus);

                this.coPlayState = {
                    mode: 'teaching',
                    objectType,
                    focus,
                    prompt,
                };
                this.persistSessionMetadata();
                this.recordActivity('teaching_started', `AR Teaching: ${objectType}`, focus || prompt);

                this.emitArOverlay({
                    mode: 'teaching',
                    badge: 'AR Teaching',
                    title: `Let's learn about the ${objectType}`,
                    subtitle: focus,
                    prompt,
                    accent: this.pickAccent(objectType),
                    items,
                });

                return {
                    success: true,
                    state: this.coPlayState,
                    items,
                };
            }
        );

        this.tools.register("update_ar_overlay",
            "Updates the active AR overlay with a new title, prompt, labels, or teaching step.",
            {
                "mode": {
                    type: Type.STRING,
                    description: "Overlay mode: teaching, hunt, or success."
                },
                "title": {
                    type: Type.STRING,
                    description: "Short overlay title."
                },
                "subtitle": {
                    type: Type.STRING,
                    description: "Short helper text."
                },
                "prompt": {
                    type: Type.STRING,
                    description: "Short next instruction."
                },
                "items": {
                    type: Type.STRING,
                    description: "Comma-separated overlay labels or hints."
                }
            },
            async (args: { mode: string, title: string, subtitle: string, prompt: string, items: string }) => {
                const items = args.items
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean);

                this.emitArOverlay({
                    mode: this.normalizeOverlayMode(args.mode),
                    badge: this.modeBadge(this.normalizeOverlayMode(args.mode)),
                    title: args.title.trim(),
                    subtitle: args.subtitle.trim(),
                    prompt: args.prompt.trim(),
                    items,
                    accent: this.pickAccent(this.coPlayState.objectType || this.coPlayState.targetValue || args.title),
                });

                return {
                    success: true,
                    items,
                };
            }
        );

        this.tools.register("start_scavenger_hunt",
            "Starts a short scavenger hunt, such as finding a color, flower, machine, or other easy object in view.",
            {
                "targetType": {
                    type: Type.STRING,
                    description: "What kind of thing the child should find, such as color, shape, or object."
                },
                "targetValue": {
                    type: Type.STRING,
                    description: "The specific target, such as red, flower, circle, or machine."
                },
                "prompt": {
                    type: Type.STRING,
                    description: "Short spoken hunt instruction."
                }
            },
            async (args: { targetType: string, targetValue: string, prompt: string }) => {
                const targetType = args.targetType.trim();
                const targetValue = args.targetValue.trim();
                const prompt = args.prompt.trim();

                this.coPlayState = {
                    mode: 'scavenger_hunt',
                    targetType,
                    targetValue,
                    prompt,
                };
                this.persistSessionMetadata();
                this.recordActivity('hunt_started', `Scavenger Hunt: ${targetValue}`, prompt || targetType);

                this.emitArOverlay({
                    mode: 'hunt',
                    badge: 'Scavenger Hunt',
                    title: `Find ${this.withIndefiniteArticle(targetValue)}`,
                    ...(targetType ? { subtitle: `Looking for a ${targetType}` } : {}),
                    prompt,
                    accent: this.pickAccent(targetValue),
                    items: this.buildHuntHints(targetType, targetValue),
                });

                return {
                    success: true,
                    state: this.coPlayState,
                };
            }
        );

        this.tools.register("celebrate_hunt_success",
            "Celebrates when the child finds the scavenger hunt target or completes an AR task.",
            {
                "title": {
                    type: Type.STRING,
                    description: "Short success title."
                },
                "prompt": {
                    type: Type.STRING,
                    description: "Short follow-up or praise."
                }
            },
            async (args: { title: string, prompt: string }) => {
                const title = args.title.trim() || 'You found it!';
                const prompt = args.prompt.trim();

                this.recordActivity('hunt_success', title, prompt || 'Completed co-play step');
                this.emitArOverlay({
                    mode: 'success',
                    badge: 'Great Job',
                    title,
                    prompt,
                    accent: '#ffd166',
                    celebration: true,
                    items: ['sparkles', 'stars', 'success'],
                });

                return { success: true };
            }
        );

        this.tools.register("end_coplay_mode",
            "Ends the current AR teaching or scavenger hunt activity and clears the overlay.",
            {
                "summary": {
                    type: Type.STRING,
                    description: "A short reason or wrap-up for ending the activity."
                }
            },
            async (args: { summary: string }) => {
                const summary = args.summary.trim();
                if (this.coPlayState.mode !== 'idle') {
                    this.recordActivity('coplay_ended', `Ended ${this.coPlayState.mode}`, summary || 'Activity completed');
                }

                this.coPlayState = { mode: 'idle' };
                this.persistSessionMetadata();
                this.clearArOverlay();
                return { success: true };
            }
        );

        this.tools.register("place_generated_ar_object",
            "Creates a generated character or object, like a dinosaur, and places it approximately on a real surface in view such as a table or desk.",
            {
                "objectName": {
                    type: Type.STRING,
                    description: "The magical object to generate, such as dinosaur, robot, dragon, or rocket."
                },
                "anchorTarget": {
                    type: Type.STRING,
                    description: "The real surface to place it on, such as table, desk, floor, or wall."
                },
                "prompt": {
                    type: Type.STRING,
                    description: "Optional short line to show in the AR card."
                }
            },
            async (args: { objectName: string, anchorTarget: string, prompt: string }) => {
                const objectName = args.objectName.trim();
                const anchorTarget = args.anchorTarget.trim() || 'table';
                const prompt = args.prompt.trim();

                this.emitGeneratedArStatus(`Making ${this.withIndefiniteArticle(objectName)} for your ${anchorTarget}...`);

                try {
                    const anchorBox = await this.detectAnchorBox(anchorTarget);
                    if (!anchorBox) {
                        return {
                            success: false,
                            reason: `I could not find a ${anchorTarget} to place it on.`,
                        };
                    }

                    const imageDataUrl = await this.getOrGenerateSprite(objectName);
                    const accent = this.pickAccent(objectName);

                    this.activeGeneratedArObject = {
                        objectName,
                        anchorTarget,
                        imageDataUrl,
                        prompt,
                        accent,
                    };

                    this.recordActivity(
                        'generated_ar_object',
                        `Magic AR: ${objectName}`,
                        `Placed on ${anchorTarget}`,
                    );

                    this.emitArOverlay({
                        mode: 'teaching',
                        badge: 'Magic AR',
                        title: `Look, a ${objectName}!`,
                        subtitle: `Sitting on your ${anchorTarget}`,
                        prompt: prompt || `Can you see the ${objectName}?`,
                        accent,
                        items: [objectName, anchorTarget, 'magic'],
                    });

                    this.emitGeneratedArObject({
                        objectName,
                        anchorTarget,
                        imageDataUrl,
                        anchorBox,
                        title: `A ${objectName} on your ${anchorTarget}`,
                        ...(prompt ? { prompt } : {}),
                        accent,
                    });

                    return {
                        success: true,
                        objectName,
                        anchorTarget,
                    };
                } finally {
                    this.emitGeneratedArStatus('');
                }
            }
        );

        this.tools.register("clear_generated_ar_object",
            "Removes the currently placed generated AR creature or object from the scene.",
            {},
            async () => {
                this.activeGeneratedArObject = null;
                this.socket.emit('tool-call', {
                    name: 'clear_generated_ar_object',
                    args: {},
                });
                return { success: true };
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
                    return {
                        success: true,
                        mediaType: 'video',
                        title: result.title,
                    };
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
                    return {
                        success: true,
                        mediaType: 'image',
                        title: result.title,
                    };
                }
            }
        } catch (error) {
            console.error('Error fetching media:', error);
        }

        return { success: false };
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
                    const toolResult = await toolData.handler(toolArgs);
                    responses.push({
                        id: call.id,
                        name: toolName,
                        response: toolResult ?? { success: true },
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
        this.latestFrameBase64 = base64Data;
        
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

    private emitArOverlay(payload: ArOverlayPayload) {
        this.socket.emit('tool-call', {
            name: 'ar_overlay',
            args: payload,
        });
    }

    private clearArOverlay() {
        this.socket.emit('tool-call', {
            name: 'clear_ar_overlay',
            args: {},
        });
    }

    private buildTeachingItems(objectType: string, focus: string) {
        const haystack = `${objectType} ${focus}`.toLowerCase();
        if (haystack.includes('flower')) {
            return ['petals', 'colors', 'count'];
        }
        if (haystack.includes('machine') || haystack.includes('car') || haystack.includes('truck')) {
            return ['wheel', 'button', 'handle'];
        }
        if (haystack.includes('animal') || haystack.includes('dinosaur')) {
            return ['ears', 'tail', 'colors'];
        }
        return [objectType, focus].filter(Boolean);
    }

    private buildHuntHints(targetType: string, targetValue: string) {
        if (targetType.toLowerCase().includes('color')) {
            return ['look around', 'show it to me', targetValue];
        }

        return [targetValue, 'bring it close', 'hold it steady'];
    }

    private normalizeOverlayMode(value: string): ArOverlayPayload['mode'] {
        if (value === 'hunt' || value === 'success') {
            return value;
        }

        return 'teaching';
    }

    private modeBadge(mode: ArOverlayPayload['mode']) {
        if (mode === 'hunt') return 'Scavenger Hunt';
        if (mode === 'success') return 'Great Job';
        return 'AR Teaching';
    }

    private pickAccent(seed: string) {
        const value = seed.toLowerCase();
        if (value.includes('flower') || value.includes('leaf') || value.includes('plant')) return '#7bd389';
        if (value.includes('machine') || value.includes('car') || value.includes('truck')) return '#7aa2ff';
        if (value.includes('star') || value.includes('sun')) return '#ffd166';
        if (value.includes('red')) return '#ff6b6b';
        if (value.includes('blue')) return '#63b3ff';
        return '#b794f4';
    }

    private withIndefiniteArticle(value: string) {
        const trimmed = value.trim();
        if (!trimmed) return 'something fun';
        return /^[aeiou]/i.test(trimmed) ? `an ${trimmed}` : `a ${trimmed}`;
    }

    private recordActivity(type: string, title: string, detail: string) {
        this.sessionActivities.push({
            type,
            title,
            detail,
            timestamp: Date.now(),
        });
        this.persistSessionMetadata();
    }

    private persistSessionMetadata() {
        this.sessionRef.update({
            activities: this.sessionActivities,
            coPlayState: this.coPlayState,
        }).catch(console.error);
    }

    private emitGeneratedArStatus(message: string) {
        this.socket.emit('tool-call', {
            name: 'generated_ar_status',
            args: { message },
        });
    }

    private emitGeneratedArObject(args: {
        objectName: string;
        anchorTarget: string;
        imageDataUrl: string;
        anchorBox: AnchorBox;
        title: string;
        prompt?: string;
        accent: string;
    }) {
        this.socket.emit('tool-call', {
            name: 'generated_ar_object',
            args,
        });
    }

    private async refreshGeneratedArAnchor() {
        if (!this.activeGeneratedArObject) {
            return;
        }

        const anchorBox = await this.detectAnchorBox(this.activeGeneratedArObject.anchorTarget);
        if (!anchorBox) {
            return;
        }

        this.emitGeneratedArObject({
            objectName: this.activeGeneratedArObject.objectName,
            anchorTarget: this.activeGeneratedArObject.anchorTarget,
            imageDataUrl: this.activeGeneratedArObject.imageDataUrl,
            anchorBox,
            title: `A ${this.activeGeneratedArObject.objectName} on your ${this.activeGeneratedArObject.anchorTarget}`,
            ...(this.activeGeneratedArObject.prompt ? { prompt: this.activeGeneratedArObject.prompt } : {}),
            accent: this.activeGeneratedArObject.accent,
        });
    }

    private async detectAnchorBox(anchorTarget: string): Promise<AnchorBox | null> {
        if (!this.latestFrameBase64) {
            return null;
        }

        try {
            const response = await this.AI.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        text: `Find the best bounding box for the visible ${anchorTarget} where a small toy-sized object could sit.

Return JSON with:
- found: boolean
- x1, y1, x2, y2 as integers normalized from 0 to 1000

Rules:
- Focus on the most obvious visible ${anchorTarget}.
- If the ${anchorTarget} is a table or desk, prefer the top surface area.
- If you are uncertain but a flat surface is clearly visible, return the best likely surface.
- Return only JSON.`,
                    },
                    {
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: this.latestFrameBase64,
                        },
                    },
                ],
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            found: { type: Type.BOOLEAN },
                            x1: { type: Type.INTEGER },
                            y1: { type: Type.INTEGER },
                            x2: { type: Type.INTEGER },
                            y2: { type: Type.INTEGER },
                        },
                        required: ['found', 'x1', 'y1', 'x2', 'y2'],
                    },
                },
            });

            const parsed = JSON.parse(response.text || '{}') as Partial<{ found: boolean, x1: number, y1: number, x2: number, y2: number }>;
            if (!parsed.found) {
                return this.fallbackAnchorBox(anchorTarget);
            }

            return this.normalizeAnchorBox({
                x1: parsed.x1 ?? 120,
                y1: parsed.y1 ?? 620,
                x2: parsed.x2 ?? 880,
                y2: parsed.y2 ?? 960,
            });
        } catch (error) {
            console.error('Failed to detect anchor box:', error);
            return this.fallbackAnchorBox(anchorTarget);
        }
    }

    private fallbackAnchorBox(anchorTarget: string): AnchorBox {
        const normalizedTarget = anchorTarget.toLowerCase();
        if (normalizedTarget.includes('wall')) {
            return { x1: 230, y1: 140, x2: 770, y2: 620 };
        }
        if (normalizedTarget.includes('floor')) {
            return { x1: 120, y1: 700, x2: 880, y2: 980 };
        }

        return { x1: 120, y1: 650, x2: 880, y2: 965 };
    }

    private normalizeAnchorBox(box: AnchorBox): AnchorBox {
        return {
            x1: Math.max(0, Math.min(1000, Math.round(box.x1))),
            y1: Math.max(0, Math.min(1000, Math.round(box.y1))),
            x2: Math.max(0, Math.min(1000, Math.round(box.x2))),
            y2: Math.max(0, Math.min(1000, Math.round(box.y2))),
        };
    }

    private async getOrGenerateSprite(objectName: string) {
        const cacheKey = objectName.toLowerCase();
        const cached = this.generatedSpriteCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const response = await this.VertexAI.models.generateImages({
            model: 'imagen-3.0-generate-001',
            prompt: `Create a cute, friendly, children's-book style ${objectName} sticker.
Full body.
Centered.
Pure white background.
No scenery.
No frame.
No text.
No shadow.
Bright colors.
Appealing for ages 2 to 6.`,
            config: {
                numberOfImages: 1,
            },
        });

        const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
        if (!imageBytes) {
            throw new Error(`No generated image returned for ${objectName}`);
        }

        const dataUrl = `data:image/png;base64,${imageBytes}`;
        this.generatedSpriteCache.set(cacheKey, dataUrl);
        return dataUrl;
    }
}
