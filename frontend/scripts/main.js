import IndicatorLight from './indicator.js';
import Tools from './tools.js';

const overlay = document.getElementById('overlay');
const video = document.getElementById('videoElement');
const canvas = document.getElementById('videoCanvas');
const context = canvas.getContext('2d');

overlay.addEventListener("click", async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        video.srcObject = stream;
        video.style.display = "block";
        overlay.style.display = "none";


        main(stream);
    } catch (err) {
        alert(`Could not access camera or microphone. Please ensure permissions are granted.\nError:\n${err}`);
    }
});

/**
 * Heart and soul of the application, where most initialization and in general
 * magic happens. :P
 * @param {MediaStream} stream
 */
function main(stream) {
    const indicator = new IndicatorLight();
    const tools = new Tools();
    const socket = new WebSocket(`ws://${window.location.host}/ws/stream/`);

    socket.onopen = () => {
        console.log("WebSocket connection established");
        indicator.setActive(true);

        // Send window constraints
        socket.send(JSON.stringify({
            type: 'constraints',
            width: window.innerWidth,
            height: window.innerHeight
        }));

        window.addEventListener('resize', () => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'constraints',
                    width: window.innerWidth,
                    height: window.innerHeight
                }));
            }
        });

        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);

        // Load the AudioWorklet module
        audioContext.audioWorklet.addModule('/static/scripts/audio-processor.js').then(() => {
            const workletNode = new AudioWorkletNode(audioContext, 'audio-stream-processor');

            source.connect(workletNode);
            workletNode.connect(audioContext.destination);

            workletNode.port.onmessage = (event) => {
                const inputData = event.data; // Float32Array (1024 samples)
                // 1024 samples * 4 bytes/sample = 4096 bytes
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(inputData.buffer);
                }
            };

            // Start video capture at interval
            setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    canvas.width = video.videoWidth / 4; // Downscale
                    canvas.height = video.videoHeight / 4;
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    
                    const frameData = canvas.toDataURL('image/jpeg', 0.5);
                    socket.send(JSON.stringify({
                        type: 'video',
                        data: frameData
                    }));
                }
            }, 100); // 10 FPS

        }).catch(err => {
            console.error("Error loading AudioWorklet:", err);
        });
    };

    socket.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'project') {
                tools.project(payload);
            } else if (payload.type === 'unproject') {
                tools.unproject(payload);
            } else {
                console.log("Unknown message type:", payload.type);
            }
        } catch (err) {
            console.error("Error parsing WebSocket message:", err, event.data);
        }
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
    };

    socket.onclose = () => {
        console.log("WebSocket connection closed");
        indicator.setActive(false);
    };
}