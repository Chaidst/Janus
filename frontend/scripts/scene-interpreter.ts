import {
    Florence2ForConditionalGeneration,
    AutoProcessor,
    RawImage,
    env,
} from '@huggingface/transformers';

// Configure environment for browser usage
env.allowLocalModels = false;
env.useBrowserCache = true;

class SceneInterpreter {
    private model: Florence2ForConditionalGeneration | null = null;
    private processor: AutoProcessor | null = null;
    private ready: boolean = false;

    constructor() {
        this.init();
    }

    private async init() {
        const model_id = 'onnx-community/Florence-2-base-ft';
        
        console.log("Loading model:", model_id);
        this.model = await Florence2ForConditionalGeneration.from_pretrained(model_id, {
            device: 'webgpu', // Try 'webgpu' or 'wasm'
            dtype: 'fp32',
        });
        
        console.log("Loading processor...");
        this.processor = await AutoProcessor.from_pretrained(model_id);
        
        this.ready = true;
        console.log("Scene interpreter ready.");
    }

    async interpret(base64Image: string) {
        if (!this.ready || !this.model || !this.processor) {
            console.warn("Scene interpreter not ready yet.");
            return null;
        }

        const image = await RawImage.fromURL(base64Image);
        const inputs = await this.processor(image, '<CAPTION>');
        
        const output = await this.model.generate({
            ...inputs,
            max_new_tokens: 100,
        });

        const decoded = this.processor.batch_decode(output, { skip_special_tokens: true });
        return decoded[0];
    }
}

export { SceneInterpreter };