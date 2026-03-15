type Landmark = {
  x: number;
  y: number;
  z?: number;
};

type HandLandmarkerResult = {
  landmarks?: Landmark[][];
};

type HandLandmarkerInstance = {
  detectForVideo(
    video: HTMLVideoElement,
    timestampMs: number,
  ): HandLandmarkerResult;
};

type HandTrackerCallbacks = {
  onPinchStart?: (x: number, y: number) => void;
  onPinchMove?: (x: number, y: number) => void;
  onPinchEnd?: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
};

declare global {
  interface Window {
    FilesetResolver?: {
      forVisionTasks(wasmRoot: string): Promise<unknown>;
    };
    HandLandmarker?: {
      createFromOptions(
        vision: unknown,
        options: Record<string, unknown>,
      ): Promise<HandLandmarkerInstance>;
    };
  }
}

const PINCH_START_THRESHOLD = 0.045;
const PINCH_END_THRESHOLD = 0.065;
const MODEL_ASSET_PATH =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

class HandTracker {
  private video: HTMLVideoElement;
  private callbacks: HandTrackerCallbacks;
  private handLandmarker: HandLandmarkerInstance | null = null;
  private animationFrameId: number | null = null;
  private isRunning = false;
  private pinchActive = false;
  private lastVideoTime = -1;
  private initializationPromise: Promise<void> | null = null;

  constructor(video: HTMLVideoElement, callbacks: HandTrackerCallbacks = {}) {
    this.video = video;
    this.callbacks = callbacks;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    await this.waitForVideoReadiness();
    await this.initialize();

    if (!this.handLandmarker) {
      return;
    }

    this.isRunning = true;
    this.animationFrameId = window.requestAnimationFrame(this.processFrame);
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.pinchActive) {
      this.pinchActive = false;
      this.callbacks.onPinchEnd?.();
    }
  }

  private async initialize() {
    if (this.handLandmarker || this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = (async () => {
      if (!window.FilesetResolver || !window.HandLandmarker) {
        const message = "MediaPipe vision bundle is unavailable.";
        console.warn(message);
        this.callbacks.onError?.(message);
        return;
      }

      const vision = await window.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
      );

      this.handLandmarker = await this.createHandLandmarker(vision);
      this.callbacks.onReady?.();
    })();

    try {
      await this.initializationPromise;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to initialize hand tracking.";
      console.warn("Hand tracker initialization failed:", error);
      this.callbacks.onError?.(message);
    } finally {
      this.initializationPromise = null;
    }
  }

  private async createHandLandmarker(vision: unknown) {
    const create = (delegate: "GPU" | "CPU") =>
      window.HandLandmarker!.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_ASSET_PATH,
          delegate,
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.45,
        minHandPresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      });

    try {
      return await create("GPU");
    } catch (error) {
      console.warn("GPU hand tracking init failed, retrying on CPU:", error);
      return create("CPU");
    }
  }

  private async waitForVideoReadiness() {
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    await new Promise<void>((resolve) => {
      const handleReady = () => {
        this.video.removeEventListener("loadeddata", handleReady);
        this.video.removeEventListener("loadedmetadata", handleReady);
        resolve();
      };

      this.video.addEventListener("loadeddata", handleReady, { once: true });
      this.video.addEventListener("loadedmetadata", handleReady, { once: true });
    });
  }

  private processFrame = () => {
    if (!this.isRunning) {
      return;
    }

    if (
      this.handLandmarker &&
      this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      this.video.videoWidth > 0 &&
      this.video.currentTime !== this.lastVideoTime
    ) {
      const result = this.handLandmarker.detectForVideo(
        this.video,
        performance.now(),
      );
      this.lastVideoTime = this.video.currentTime;
      this.handleResult(result);
    }

    this.animationFrameId = window.requestAnimationFrame(this.processFrame);
  };

  private handleResult(result: HandLandmarkerResult) {
    const hand = result.landmarks?.[0];
    if (!hand || hand.length < 9) {
      if (this.pinchActive) {
        this.pinchActive = false;
        this.callbacks.onPinchEnd?.();
      }
      return;
    }

    const thumbTip = hand[4];
    const indexTip = hand[8];
    if (!thumbTip || !indexTip) {
      return;
    }

    const pinchDistance = Math.hypot(
      thumbTip.x - indexTip.x,
      thumbTip.y - indexTip.y,
    );
    const midpoint = this.mapVideoPointToViewport(
      (thumbTip.x + indexTip.x) / 2,
      (thumbTip.y + indexTip.y) / 2,
    );

    if (!this.pinchActive && pinchDistance <= PINCH_START_THRESHOLD) {
      this.pinchActive = true;
      this.callbacks.onPinchStart?.(midpoint.x, midpoint.y);
      this.callbacks.onPinchMove?.(midpoint.x, midpoint.y);
      return;
    }

    if (this.pinchActive && pinchDistance >= PINCH_END_THRESHOLD) {
      this.pinchActive = false;
      this.callbacks.onPinchEnd?.();
      return;
    }

    if (this.pinchActive) {
      this.callbacks.onPinchMove?.(midpoint.x, midpoint.y);
    }
  }

  private mapVideoPointToViewport(normalizedX: number, normalizedY: number) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const videoAspect = this.video.videoWidth / this.video.videoHeight;
    const viewportAspect = viewportWidth / viewportHeight;

    let renderWidth = viewportWidth;
    let renderHeight = viewportHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (videoAspect > viewportAspect) {
      renderHeight = viewportHeight;
      renderWidth = renderHeight * videoAspect;
      offsetX = (viewportWidth - renderWidth) / 2;
    } else {
      renderWidth = viewportWidth;
      renderHeight = renderWidth / videoAspect;
      offsetY = (viewportHeight - renderHeight) / 2;
    }

    const x = offsetX + normalizedX * renderWidth;
    const y = offsetY + normalizedY * renderHeight;

    return {
      x: Math.max(0, Math.min(viewportWidth, x)),
      y: Math.max(0, Math.min(viewportHeight, y)),
    };
  }
}

export { HandTracker };
