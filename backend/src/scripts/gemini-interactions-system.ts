import {Socket} from 'socket.io';
import {GoogleGenAI, Modality, type Schema, type Session, Type} from "@google/genai"

// constants
const LIVE_PROMPT = `You are an educational companion designed for children ages 2 to 6. Your primary interface is through a real-time audio and video feed, allowing you to see what the child sees and converse with them naturally. 

# CORE PERSONA & BOUNDARIES
- Act as an active listener and a gentle, encouraging guide. Prioritize nurturing curiosity and exploration over simply providing direct answers.
- Speak in a natural, caregiver-style tone that is easy for a toddler or young child to understand. 
- You are not a parent or guardian. Never assume a parental role, and never provide advice, discipline, or guidance that should exclusively come from a human caregiver.
- Be highly observant of the child's physical environment, physical properties of objects (e.g., a leaning tower of blocks), and non-verbal cues.
- Exercise discretion: Know when to speak and when to remain quietly observant. Do not interrupt if the child is deeply focused on a task, talking to someone else, arguing, or if an interaction would be distracting.

# VISUAL & CONTEXTUAL AWARENESS
- Use your visual processing to identify objects, shapes, and textures in the child's environment to drive relevant, context-aware conversations (e.g., identifying a leaf, recognizing a drawing).
- Ask open-ended questions based on what the child is actively doing (e.g., "How many blocks do you have there?" or "Can you tell me a story about your drawing?").
- Actively maintain context. Note important details about the child (favorite colors, interests) to personalize the learning experience over time.

# DIRECTIVES
1. Observe continuously. 
2. Speak only when it adds educational or emotional value.
3. Use AR tools creatively to make abstract concepts visual and interactive.
4. Clean up your AR visuals when they are no longer needed.
5. Always keep the child's safety, focus, and developmental stage as your highest priority.`;
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
    private AI: GoogleGenAI;
    private socket: Socket;
    private session: Session | null = null;
    private tools: Tools;
    private audioBuffer: Int16Array = new Int16Array(0);

    
    constructor(api_key: string, user_socket: Socket) {
        this.AI = new GoogleGenAI({apiKey: api_key, httpOptions: {"apiVersion": "v1alpha"}});
        this.socket = user_socket;
        this.tools = new Tools(this.AI, user_socket);

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
                            if (part.inlineData) {
                                this.socket.emit('audio-out', part.inlineData.data);
                            }
                        }
                    }
                    if (content?.interrupted) {
                        this.audioBuffer = new Int16Array(0);
                        this.socket.emit('interrupted');
                    }
                    if (content?.inputTranscription) {
                        this.socket.emit('transcription', { type: 'user', text: content.inputTranscription.text });
                    }
                    if (content?.outputTranscription) {
                        this.socket.emit('transcription', { type: 'model', text: content.outputTranscription.text });
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
                enableAffectiveDialog: true,
                tools: this.tools?.get_tools_schema() || [],
                // @ts-ignore - Enable transcription to see what Gemini hears
                inputTranscriptionConfig: { enabled: true }
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

        this.socket.on("audio-chunk", (data: Float32Array) => {
            this.handle_audio_chunk(data);
        });

        this.socket.on("disconnect", () => {
            console.log("Client disconnected");
            this.shutdown_sockets();
            this.session?.close();
        });
    }

    private shutdown_sockets() {
        this.socket.removeAllListeners();
        this.socket.disconnect();
    }

    private initialize_tools() {
        // this.tools.register(
        //     "add_memory",
        //     "Adds a memory to be remembered in later conversations.")
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
        // Correctly handle incoming audio data from Socket.io (which delivers Buffer in Node)
        let floatArray: Float32Array;
        
        if (Buffer.isBuffer(data)) {
            try {
                // If the buffer is not aligned to 4 bytes, we must copy it to a new ArrayBuffer
                if (data.byteOffset % 4 !== 0) {
                    const newBuf = new Uint8Array(data.byteLength);
                    newBuf.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                    floatArray = new Float32Array(newBuf.buffer);
                } else {
                    floatArray = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
                }
            } catch (e) {
                // Fallback: Copy the data manually if something goes wrong with memory alignment
                const newBuf = new Uint8Array(data.byteLength);
                newBuf.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                floatArray = new Float32Array(newBuf.buffer);
            }
        } else if (data instanceof Float32Array) {
            floatArray = data;
        } else if (data instanceof ArrayBuffer) {
            floatArray = new Float32Array(data);
        } else if (Array.isArray(data)) {
            floatArray = new Float32Array(data);
        } else {
            // Fallback for objects with Numeric keys (sometimes happens with socket.io)
            floatArray = new Float32Array(data);
        }

        const length = floatArray.length;
        if (length === 0) return;

        // Convert and scale to 16-bit PCM (Gemini expects little-endian)
        const pcmData = new Int16Array(length);
        for (let i = 0; i < length; i++) {
            const val = floatArray[i] || 0;
            const s = Math.max(-1, Math.min(1, val));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Buffer audio to send larger chunks (e.g., ~100ms / 1600 samples)
        // This is much more efficient than sending small chunks every 8ms.
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