declare class AudioWorkletProcessor {
  port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorClass: any): void;

class AudioStreamProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const floatData = input[0];
      if (floatData) {
        // Convert Float32Array to Int16Array
        const int16Data = new Int16Array(floatData.length);
        for (let i = 0; i < floatData.length; i++) {
          const sample = floatData[i];
          if (sample !== undefined) {
              const s = Math.max(-1, Math.min(1, sample));
              int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
        }
        
        // Send the Int16Array as an ArrayBuffer
        this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);

export {};
