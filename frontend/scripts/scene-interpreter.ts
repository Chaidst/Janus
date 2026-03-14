import {
    Florence2ForConditionalGeneration,
    AutoProcessor,
    RawImage,
    env, PreTrainedModel, Processor,
} from '@huggingface/transformers';

// Configure environment for browser usage
env.allowLocalModels = false;
env.useBrowserCache = true;

class SceneInterpreter {
    private model: PreTrainedModel | null = null;
    private processor: Processor | null = null;
    private initPromise: Promise<void>;

    constructor() {
        this.initPromise = this.init();
    }

    private async init() {
        const model_id = 'onnx-community/Florence-2-base-ft';
        
        console.log("Loading model:", model_id);
        try {
            this.model = await Florence2ForConditionalGeneration.from_pretrained(model_id, {
                device: 'webgpu', // Try 'webgpu' or 'wasm'
                dtype: 'fp32',
            });
            console.log("Model loaded successfully.");
        } catch (error) {
            console.error("Failed to load model:", error);
        }

        console.log("Loading processor...");
        try {
            this.processor = await AutoProcessor.from_pretrained(model_id);
            console.log("Processor loaded successfully.");
        } catch (error) {
            console.error("Failed to load processor:", error);
        }
    }

    async interpret(base64Image: string) {
        await this.initPromise;
        if (!this.model || !this.processor) {
            console.warn("Scene interpreter not ready (failed to load).");
            return false;
        }

        try {
            const image = await RawImage.fromURL(base64Image);
            const inputs = await this.processor(image, "Say which objects appear");
            
            const output = await this.model.generate({
                ...inputs,
                max_new_tokens: 100,
            });

            const decoded = this.processor.batch_decode(output, { skip_special_tokens: true });
            console.log("Interpreter output:", decoded[0]);
            return true;
        } catch (error) {
            console.error("Error during interpretation:", error);
            return null;
        }
    }
}

export { SceneInterpreter };