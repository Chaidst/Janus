import audioProcessorUrl from "./audio-processor.ts?worker&url";

class WebcamAudioVideoStream {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private onAudioData: (data: ArrayBuffer) => void;
  private onVideoFrame: (frame: string) => void;
  private fps: number;
  private downscaleFactor: number;
  private quality: number;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private videoInterval: any = null;

  /**
   * @param {HTMLVideoElement} videoElement
   * @param {Object} options
   * @param {Function} options.onAudioData - Callback for audio chunks (Float32Array)
   * @param {Function} options.onVideoFrame - Callback for video frames (base64 image data)
   * @param {number} [options.fps=30] - Frames per second for video capture
   * @param {number} [options.downscaleFactor=2] - Downscale factor for video frame capture
   * @param {number} [options.quality=0.8] - JPEG quality (0.0 to 1.0)
   */
  constructor(
    videoElement: HTMLVideoElement,
    options: {
      onAudioData?: (data: ArrayBuffer) => void;
      onVideoFrame?: (frame: string) => void;
      fps?: number;
      downscaleFactor?: number;
      quality?: number;
    } = {},
  ) {
    this.video = videoElement;
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not get 2D context");
    }
    this.context = context;

    this.onAudioData = options.onAudioData || (() => {});
    this.onVideoFrame = options.onVideoFrame || (() => {});
    this.fps = options.fps || 30;
    this.downscaleFactor = options.downscaleFactor || 2;
    this.quality = options.quality || 0.8;
  }

  /**
   * Start the webcam and audio stream
   */
  async start(): Promise<MediaStream> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      });

      this.video.srcObject = this.stream;
      this.video.play();

      await this.setupAudio();
      this.setupVideo();

      return this.stream;
    } catch (err) {
      console.error("Error accessing media devices:", err);
      throw err;
    }
  }

  /**
   * Stop the webcam and audio stream
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.videoInterval) {
      clearInterval(this.videoInterval);
      this.videoInterval = null;
    }

    if (this.video) {
      this.video.srcObject = null;
    }
  }

  /**
   * Resume or reinitialize audio capture after interruptions.
   */
  async resumeAudio(callback: (data: ArrayBuffer) => void = this.onAudioData) {
    if (!this.stream) {
      console.warn("Cannot resume audio: stream is not initialized.");
      return;
    }

    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = null;
      await this.setupAudio(callback);
      return;
    }

    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch (err) {
        console.error("Failed to resume AudioContext, reinitializing:", err);
        this.audioContext = null;
        await this.setupAudio(callback);
      }
    }
  }

  /**
   * Internal: Set up audio processing using AudioWorklet
   */
  async setupAudio(callback: (data: ArrayBuffer) => void = this.onAudioData) {
    if (!this.stream) {
      console.error("Cannot setup audio: stream is not initialized.");
      return;
    }

    if (this.audioContext) {
      console.warn("AudioContext already exists. Re-using existing context.");
      return;
    }

    this.audioContext = new (
      window.AudioContext || (window as any).webkitAudioContext
    )({
      sampleRate: 16000,
    });
    const source = this.audioContext.createMediaStreamSource(this.stream);

    try {
      await this.audioContext.audioWorklet.addModule(audioProcessorUrl);
      const workletNode = new AudioWorkletNode(
        this.audioContext,
        "audio-stream-processor",
      );

      source.connect(workletNode);
      workletNode.connect(this.audioContext.destination);

      workletNode.port.onmessage = (event) => {
        callback(event.data);
      };
    } catch (err) {
      console.error("Error loading AudioWorklet:", err);
      // Fallback or just log error
    }
  }

  /**
   * Internal: Set up video frame capturing
   */
  setupVideo(callback: (frame: string) => void = this.onVideoFrame) {
    if (this.videoInterval) {
      console.warn("Video capture already running.");
      return;
    }

    this.videoInterval = setInterval(() => {
      if (this.video.videoWidth > 0) {
        const width = this.video.videoWidth / this.downscaleFactor;
        const height = this.video.videoHeight / this.downscaleFactor;

        if (this.canvas.width !== width || this.canvas.height !== height) {
          this.canvas.width = width;
          this.canvas.height = height;
        }

        this.context.drawImage(this.video, 0, 0, width, height);
        const frameData = this.canvas.toDataURL("image/jpeg", this.quality);
        callback(frameData);
      }
    }, 1000 / this.fps);
  }
}

export { WebcamAudioVideoStream };
