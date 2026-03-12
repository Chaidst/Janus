import {Socket} from 'socket.io';
import {GoogleGenAI, Modality, type Session} from "@google/genai"

// constants
const API_KEY = process.env.VERTEX_API_KEY || "";
const LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const HELPER_MODEL = "gemini-2.5-flash-lite";
const AI = new GoogleGenAI({apiKey: API_KEY});

// the analogy I like is we're giving Gemini a driver seat, and teaching it how to drive.
// Gemini will obviously make mistakes driving the vehicle from time-to-time, so it's up to us
// (the developers) to build a safe vehicle, potentially with some nice self driving.
export class GeminiInteractionSystem {
    private socket: Socket;
    private session: Session | null = null;
    
    constructor(user_socket: Socket) {
        this.socket = user_socket;

        AI.live.connect({
            model: LIVE_MODEL,
            callbacks: {
                onopen: () => {
                    console.log("A user has connected to the Gemini Live API!")
                },
                onclose: () => {
                    this.session?.close();
                    this.shutdown_sockets();
                },
                onmessage: (message) => {
                    console.log("Message received from Gemini Live API:\n", message);

                },
                onerror: (error) => {
                    console.error("Error connecting to Gemini Live API (non catch):\n", error);
                    this.session?.close();
                    this.shutdown_sockets();
                }
            },
            config: {
                responseModalities: [Modality.AUDIO]
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

    private handle_video_frame(data: string) {
        // data is base64 string with header: data:image/jpeg;base64,...
        const base64Data = data.split(',')[1];
        if (!base64Data) return;
        
        // Gemini Live API format:
        // session.sendRealtimeInput({
        //   video: { data: base64Data, mimeType: 'image/jpeg' }
        // });
        // console.log(`Processed video frame. Size: ${base64Data.length}`);
    }

    private handle_audio_chunk(data: Float32Array) {
        // data is Float32Array from browser (16kHz mono)
        // Convert to Int16Array (PCM 16-bit, little-endian)
        const pcmData = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) {
            // Clamp to [-1.0, 1.0] and scale to 16-bit range
            // @ts-ignore
            const s = Math.max(-1, Math.min(1, data[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const base64Audio = Buffer.from(pcmData.buffer).toString('base64');
        // Gemini Live API format: 
        // session.sendRealtimeInput({
        //   audio: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' }
        // });
        // console.log(`Processed audio chunk. Size: ${base64Audio.length}`);
    }
}