class AudioStreamProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunkSize = 1024; // 1024 samples * 4 bytes/sample = 4096 bytes
        this.buffer = new Float32Array(this.chunkSize);
        this.offset = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input && input.length > 0) {
            const inputChannel = input[0]; // Mono

            for (let i = 0; i < inputChannel.length; i++) {
                this.buffer[this.offset++] = inputChannel[i];
                if (this.offset >= this.chunkSize) {
                    // Send a copy to the main thread
                    this.port.postMessage(this.buffer.slice());
                    this.offset = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
