import { MSG_TYPE, VIDEO_CONFIG } from './constants.js';

export class SocketManager {
    constructor(indicator, tools) {
        console.log("SocketManager initialized with indicator:", indicator);
        this.indicator = indicator;
        this.tools = tools;
        this.socket = null;
        this.onOpenCallbacks = [];
        this.onReadyCallbacks = [];
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.socket = new WebSocket(`${protocol}//${window.location.host}/ws/stream/`);

        this.socket.onopen = () => {
            console.log("WebSocket connection established");
            this.indicator.setActive(true);
            this.sendConstraints();
            this.onOpenCallbacks.forEach(cb => cb());
        };

        this.socket.onmessage = (event) => {
            if (event.data instanceof Blob) {
                this.handleAudioMessage(event.data);
            } else {
                this.handleMessage(event);
            }
        };
        this.socket.onerror = (error) => console.error("WebSocket error:", error);
        this.socket.onclose = () => {
            console.log("WebSocket connection closed");
            this.indicator.setActive(false);
        };

        window.addEventListener('resize', () => this.sendConstraints());
    }

    addOnOpenCallback(cb) {
        this.onOpenCallbacks.push(cb);
    }

    addOnReadyCallback(cb) {
        this.onReadyCallbacks.push(cb);
    }

    sendConstraints() {
        this.send({
            type: MSG_TYPE.CONSTRAINTS,
            width: window.innerWidth,
            height: window.innerHeight
        });
    }

    send(data) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            if (data instanceof ArrayBuffer || data instanceof Blob || data instanceof Uint8Array) {
                this.socket.send(data);
            } else {
                this.socket.send(JSON.stringify(data));
            }
        }
    }

    async handleAudioMessage(blob) {
        if (!this.audioContext) {
            // Native audio models like gemini-2.0-flash-exp output at 24kHz.
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        }
        
        try {
            const arrayBuffer = await blob.arrayBuffer();
            if (arrayBuffer.byteLength === 0) {
                console.warn("Received empty audio buffer");
                return;
            }

            console.log(`Processing ${arrayBuffer.byteLength} bytes of audio from Gemini`);

            const int16Array = new Int16Array(arrayBuffer);
            const float32Array = new Float32Array(int16Array.length);
            
            for (let i = 0; i < int16Array.length; i++) {
                float32Array[i] = int16Array[i] / 32768.0;
            }
            
            const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, 24000);
            audioBuffer.getChannelData(0).set(float32Array);
            
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioContext.destination);
            
            // Handle overlapping audio chunks
            const now = this.audioContext.currentTime;
            if (!this.nextStartTime || this.nextStartTime < now) {
                this.nextStartTime = now;
            }
            source.start(this.nextStartTime);
            this.nextStartTime += audioBuffer.duration;
            
            this.audioSources = this.audioSources || [];
            this.audioSources.push(source);
            source.onended = () => {
                this.audioSources = this.audioSources.filter(s => s !== source);
            };
        } catch (err) {
            console.error("Error handling audio message:", err);
        }
    }

    stopAudio() {
        if (this.audioSources) {
            this.audioSources.forEach(source => {
                try { source.stop(); } catch (e) {}
            });
            this.audioSources = [];
        }
        this.nextStartTime = 0;
    }

    handleMessage(event) {
        if (event.data instanceof Blob) {
            this.handleAudioMessage(event.data);
            return;
        }

        try {
            const payload = JSON.parse(event.data);
            switch (payload.type) {
                case 'interrupted':
                    this.stopAudio();
                    break;
                case 'status':
                    console.log("Received status update:", payload);
                    if (payload.status === 'connected') {
                        if (typeof this.indicator.setConnected === 'function') {
                            this.indicator.setConnected(true);
                        } else {
                            console.error("this.indicator.setConnected is not a function", this.indicator);
                        }
                    } else if (payload.status === 'ready') {
                        if (typeof this.indicator.setReady === 'function') {
                            this.indicator.setReady(true);
                        } else {
                            console.error("this.indicator.setReady is not a function", this.indicator);
                        }
                        this.onReadyCallbacks.forEach(cb => cb());
                    } else if (payload.status === 'error') {
                        console.error("Gemini Live reported an error:", payload.message);
                        if (typeof this.indicator.setActive === 'function') {
                            this.indicator.setActive(false); // Turn red
                        }
                    }
                    break;
                case MSG_TYPE.PROJECT:
                    this.tools.project(payload);
                    break;
                case MSG_TYPE.UPDATE_POSITION:
                    this.tools.updatePosition(payload);
                    break;
                case MSG_TYPE.UNPROJECT:
                    this.tools.unproject(payload);
                    break;
                default:
                    if (payload.status !== 'streaming') {
                        console.log("Unknown message type:", payload.type);
                    }
            }
        } catch (err) {
            console.error("Error parsing WebSocket message:", err, event.data);
        }
    }
}

export class MediaManager {
    constructor(videoElement, canvasElement, socketManager) {
        this.video = videoElement;
        this.canvas = canvasElement;
        this.context = canvasElement.getContext('2d');
        this.socketManager = socketManager;
        this.stream = null;
        this.streamingInterval = null;
    }

    setStream(stream) {
        this.stream = stream;
        this.video.srcObject = stream;
        this.video.style.display = "block";
    }

    async startStreaming() {
        if (!this.stream) return;
        await this.setupAudio();
        this.setupVideo();
        this.setupProjectionRequest();
    }

    async start(stream) {
        this.setStream(stream);
        await this.startStreaming();
    }

    async setupAudio() {
        if (!this.stream.getAudioTracks().length) {
            console.warn("No audio tracks found in stream");
            return;
        }
        const audioContext = new AudioContext({ sampleRate: 16000 });
        this.audioContext = audioContext; // Keep reference to prevent GC
        const source = this.audioContextSource = audioContext.createMediaStreamSource(this.stream);

        try {
            await audioContext.audioWorklet.addModule('/static/scripts/audio-processor.js');
            const workletNode = new AudioWorkletNode(audioContext, 'audio-stream-processor');
            source.connect(workletNode);
            // Don't connect workletNode to destination to avoid echo of local mic
            
            workletNode.port.onmessage = (event) => {
                // event.data is Float32Array
                const float32Data = event.data;
                const int16Data = new Int16Array(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    const s = Math.max(-1, Math.min(1, float32Data[i]));
                    int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                this.socketManager.send(int16Data.buffer);
            };
        } catch (err) {
            console.error("Error loading AudioWorklet:", err);
        }
    }

    setupVideo() {
        if (this.streamingInterval) clearInterval(this.streamingInterval);
        this.streamingInterval = setInterval(() => {
            if (this.video.videoWidth > 0) {
                this.canvas.width = this.video.videoWidth / VIDEO_CONFIG.DOWNSCALE_FACTOR;
                this.canvas.height = this.video.videoHeight / VIDEO_CONFIG.DOWNSCALE_FACTOR;
                this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
                
                const frameData = this.canvas.toDataURL('image/jpeg', VIDEO_CONFIG.QUALITY);
                this.socketManager.send({
                    type: MSG_TYPE.VIDEO,
                    data: frameData
                });
            }
        }, 1000 / VIDEO_CONFIG.FPS);
    }

    setupProjectionRequest() {
        this.video.addEventListener('click', (event) => {
            const rect = this.video.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            this.socketManager.send({
                type: MSG_TYPE.REQUEST_PROJECTION,
                id: `proj-${Date.now()}`,
                attach_point: [x, y],
                html: `<div style="background: rgba(0, 255, 0, 0.7); color: white; padding: 8px; border-radius: 4px; border: 1px solid white; white-space: nowrap;">Tracked Object</div>`,
                relative_to: 'top'
            });
        });
    }
}
