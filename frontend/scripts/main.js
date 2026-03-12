import IndicatorLight from './indicator.js';
import Tools from './tools.js';
import { SocketManager, MediaManager } from './managers.js';

class App {
    constructor() {
        this.overlay = document.getElementById('overlay');
        this.video = document.getElementById('videoElement');
        this.canvas = document.getElementById('videoCanvas');
        
        this.indicator = new IndicatorLight();
        this.tools = new Tools();
        this.socketManager = new SocketManager(this.indicator, this.tools);
        this.mediaManager = new MediaManager(this.video, this.canvas, this.socketManager);

        this.init();
    }

    init() {
        this.overlay.addEventListener("click", () => this.handleStart());
    }

    async handleStart() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });

            this.overlay.style.display = "none";
            this.socketManager.connect();
            
            // Wait for socket to be open before starting media
            this.socketManager.addOnOpenCallback(() => {
                this.mediaManager.start(stream);
            });

        } catch (err) {
            alert(`Could not access camera or microphone. Please ensure permissions are granted.\nError:\n${err}`);
        }
    }
}

// Initialize the application
new App();