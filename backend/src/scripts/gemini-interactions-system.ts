import { Socket } from 'socket.io';

// the analogy I like is we're giving Gemini a driver seat, and teaching it how to drive.
// Gemini will obviously make mistakes driving the vehicle from time-to-time, so it's up to us
// (the developers) to build a safe vehicle, potentially with some nice self driving.
export class GeminiInteractionSystem {
    private socket: Socket;
    
    constructor(user_socket: Socket) {
        this.socket = user_socket;

        this.socket.on('video-frame', (data: string) => {
            this.handle_video_frame(data);
        });

        this.socket.on("audio-chunk", (data: Float32Array) => {
            this.handle_audio_chunk(data);
        });

        this.socket.on("disconnect", () => {
            console.log("Client disconnected, cleaning up Gemini interaction...");
        });
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