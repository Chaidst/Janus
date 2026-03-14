import { IndicatorLight } from "./utils.js"
import { WebcamAudioVideoStream } from "./webcam-audio-video-stream.js"
//import { SceneInterpreter } from "./scene-interpreter.js"

declare var io: any;

const overlay_button = document.querySelector<HTMLButtonElement>("#overlay-button");
const video_playback = document.querySelector<HTMLVideoElement>("#video-playback");

if (!overlay_button || !video_playback) {
    throw new Error("Required DOM elements not found");
}

const indicator = new IndicatorLight();
const socket = io();
//const interpreter = new SceneInterpreter(); // Local AI model initialization

// Handle audio playback from Gemini
let audioQueue: ArrayBuffer[] = [];
let isPlaying = false;
let audioContext: AudioContext | null = null;
let nextStartTime = 0;
let activeSources: AudioBufferSourceNode[] = [];

async function playNextAudio() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }

    isPlaying = true;
    const arrayBuffer = audioQueue.shift();
    if (!arrayBuffer) return;
    const pcmData = new Int16Array(arrayBuffer);

    if (!audioContext) {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
            sampleRate: 24000 // Gemini output rate
        });
        nextStartTime = audioContext.currentTime;
    }

    // Convert Int16 PCM to Float32 for AudioContext
    const float32Data = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
        const sample = pcmData[i];
        if (sample !== undefined) {
            float32Data[i] = sample / 0x8000;
        }
    }

    const audioBuffer = audioContext.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    activeSources.push(source);

    // Schedule playback for gapless transition
    const currentTime = audioContext.currentTime;
    if (nextStartTime < currentTime) {
        nextStartTime = currentTime;
    }

    source.start(nextStartTime);
    nextStartTime += audioBuffer.duration;

    source.onended = () => {
        const index = activeSources.indexOf(source);
        if (index > -1) {
            activeSources.splice(index, 1);
        }
    };

    // Continue with next chunk as soon as possible (it will be scheduled)
    setTimeout(playNextAudio, 0);
}

socket.on('audio-out', (data: ArrayBuffer) => {
    audioQueue.push(data);
    if (!isPlaying) {
        playNextAudio();
    }
});

socket.on('interrupted', () => {
    audioQueue = [];
    nextStartTime = 0;
    activeSources.forEach(source => {
        try {
            source.stop();
        } catch (e) {
            console.warn("Error stopping source:", e);
        }
    });
    activeSources = [];
    isPlaying = false;
});

socket.on('transcription', (data: { type: string, text: string }) => {
    console.log(`[${data.type}] ${data.text}`);
});

// ── Tool Call Handler ────────────────────────────────────────────────────────
socket.on('tool-call', (data: { name: string; args: any }) => {
    if (data.name === 'show_visual') {
        const args = data.args;
        // Remove any existing popup first
        const existing = document.querySelector('.media-popup');
        if (existing) existing.remove();

        const popup = document.createElement('div');
        popup.className = 'media-popup';

        if (args.type === 'video' && args.videoId) {
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube.com/embed/${args.videoId}?autoplay=1&mute=1`;
            iframe.allow = 'autoplay; encrypted-media';
            iframe.allowFullscreen = true;
            popup.appendChild(iframe);
        } else if (args.url) {
            const img = document.createElement('img');
            img.src = args.url;
            img.alt = args.title;
            popup.appendChild(img);
        }

        const title = document.createElement('div');
        title.className = 'media-popup-title';
        title.textContent = args.title;
        popup.appendChild(title);

        document.body.appendChild(popup);

        // Auto-dismiss after 10 seconds
        setTimeout(() => {
            popup.classList.add('dismissing');
            setTimeout(() => popup.remove(), 500);
        }, 10000);
    }
});

function show_ui() {
    if (overlay_button) overlay_button.style.display = "none";
    if (video_playback) video_playback.style.display = "block";
}
let ignore = false;
let is_interpreting = false;
async function handle_video_feed(data: string) {
    // console.log("Received video frame.");
    if (ignore) return;
    socket.emit('video-frame', data);

    // // Optional: Run local inference as well
    // if (is_interpreting) return;
    // is_interpreting = true;
    //
    // try {
    //     const result = await interpreter.interpret(data);
    //     if (result) {
    //         console.log("ignoring");
    //         ignore = true;
    //     }
    // } finally {
    //     is_interpreting = false;
    // }
}

function handle_audio_feed(data: ArrayBuffer) {
    // console.log("Received audio chunk.");
    socket.emit('audio-chunk', data);
}

function main() {
    indicator.setStatus("pending");
    // initialize webcam audio and video streams
    const playback_streams = new WebcamAudioVideoStream(video_playback!, {
        onVideoFrame: handle_video_feed,
        onAudioData: handle_audio_feed
    });
    playback_streams.start();
    show_ui();
}

overlay_button.addEventListener("click", () => {
    main();
});
