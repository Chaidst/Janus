import { Socket } from 'socket.io';

// the analogy I like is we're giving Gemini a driver seat, and teaching it how to drive.
// Gemini will obviously make mistakes driving the vehicle from time-to-time, so it's up to us
// (the developers) to build a safe vehicle, potentially with some nice self driving.
export class GeminiInteractionSystem {
    
    constructor(private socket: Socket) {
    }
}