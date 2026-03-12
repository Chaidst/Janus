import { MSG_TYPE, VIDEO_CONFIG } from './constants.js';

export class SocketManager {
    constructor(indicator, tools) {
        this.indicator = indicator;
        this.tools = tools;
        this.socket = null;
        this.onOpenCallbacks = [];
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

        this.socket.onmessage = (event) => this.handleMessage(event);
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

    handleMessage(event) {
        try {
            const payload = JSON.parse(event.data);
            switch (payload.type) {
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
    }

    async start(stream) {
        this.stream = stream;
        this.video.srcObject = stream;
        this.video.style.display = "block";

        await this.setupAudio();
        this.setupVideo();
        this.setupProjectionRequest();
    }

    async setupAudio() {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(this.stream);

        try {
            await audioContext.audioWorklet.addModule('/static/scripts/audio-processor.js');
            const workletNode = new AudioWorkletNode(audioContext, 'audio-stream-processor');
            source.connect(workletNode);
            workletNode.connect(audioContext.destination);

            workletNode.port.onmessage = (event) => {
                this.socketManager.send(event.data.buffer);
            };
        } catch (err) {
            console.error("Error loading AudioWorklet:", err);
        }
    }

    setupVideo() {
        setInterval(() => {
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
