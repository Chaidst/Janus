declare var WEBARROCKSHAND: any;

export type HandTrackingUpdate = {
    confidence: number;
    left: number;
    top: number;
    width: number;
    height: number;
} | null;

type HandTrackingEngineOptions = {
    canvasElement: HTMLCanvasElement;
    videoElement: HTMLVideoElement;
    onUpdate: (update: HandTrackingUpdate) => void;
};

const NN_PATH = 'https://cdn.webar.rocks/hand/neuralNets/NN_NAV_21.json';
const OBJMANIP_NN_PATH = 'https://cdn.webar.rocks/hand/neuralNets/NN_OBJMANIP_7.json';

export class HandTrackingEngine {
    private canvasElement: HTMLCanvasElement;
    private videoElement: HTMLVideoElement;
    private onUpdate: (update: HandTrackingUpdate) => void;
    private readyPromise: Promise<void> | null = null;
    private isReady = false;
    private isPaused = true;
    private landmarkIndices: { index0: number; thumb0: number } | null = null;

    constructor(options: HandTrackingEngineOptions) {
        this.canvasElement = options.canvasElement;
        this.videoElement = options.videoElement;
        this.onUpdate = options.onUpdate;
    }

    public async resume() {
        if (!this.readyPromise) {
            this.readyPromise = this.initialize();
        }

        await this.readyPromise;
        if (this.isReady && this.isPaused) {
            await WEBARROCKSHAND.toggle_pause(false, false);
            this.isPaused = false;
        }
    }

    public async pause() {
        this.onUpdate(null);
        if (this.isReady && !this.isPaused) {
            await WEBARROCKSHAND.toggle_pause(true, false);
            this.isPaused = true;
        }
    }

    public resize() {
        this.sizeCanvas();
        if (this.isReady) {
            WEBARROCKSHAND.resize();
        }
    }

    private async initialize() {
        await this.waitForVideo();
        this.sizeCanvas();

        await new Promise<void>((resolve, reject) => {
            WEBARROCKSHAND.init({
                canvas: this.canvasElement,
                NNsPaths: [OBJMANIP_NN_PATH],
                videoSettings: {
                    videoElement: this.videoElement,
                },
                scanSettings: {
                    threshold: 0.92,
                    thresholdSignal: 0.2,
                },
                callbackReady: (error: string | false) => {
                    if (error) {
                        reject(new Error(error));
                        return;
                    }

                    this.isReady = true;
                    this.isPaused = false;
                    resolve();
                },
                callbackTrack: (detectState: any) => {
                    WEBARROCKSHAND.render_video();
                    this.handleTrack(detectState);
                },
            });
        });
    }

    private handleTrack(detectState: any) {
        if (!detectState?.isDetected) {
            this.onUpdate(null);
            return;
        }

        const centerX = ((detectState.x || 0) + 1) * 0.5 * window.innerWidth;
        const centerY = (1 - ((detectState.y || 0) + 1) * 0.5) * window.innerHeight;
        const handSize = Math.max(
            150,
            Math.min(window.innerWidth * 0.38, (detectState.s || 0.24) * window.innerWidth * 1.9),
        );

        this.onUpdate({
            confidence: detectState.detected || 1,
            left: centerX - handSize / 2,
            top: centerY - handSize * 0.62,
            width: handSize,
            height: handSize * 1.05,
        });
    }

    private sizeCanvas() {
        const ratio = window.devicePixelRatio || 1;
        this.canvasElement.width = Math.round(window.innerWidth * ratio);
        this.canvasElement.height = Math.round(window.innerHeight * ratio);
    }

    private async waitForVideo() {
        if (this.videoElement.readyState >= 2 && this.videoElement.videoWidth > 0) {
            return;
        }

        await new Promise<void>((resolve) => {
            const onReady = () => {
                this.videoElement.removeEventListener('loadedmetadata', onReady);
                this.videoElement.removeEventListener('canplay', onReady);
                resolve();
            };

            this.videoElement.addEventListener('loadedmetadata', onReady, { once: true });
            this.videoElement.addEventListener('canplay', onReady, { once: true });
        });
    }
}
