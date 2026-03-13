import { IndicatorLight } from "./utils.js"
import { WebcamAudioVideoStream } from "./webcam-audio-video-stream.js"

const overlay_button = document.querySelector("#overlay-button");
const video_playback = document.querySelector("#video-playback");

const indicator = new IndicatorLight();
const socket = io();

// Handle audio playback from Gemini
let audioQueue = [];
let isPlaying = false;
let audioContext = null;
let nextStartTime = 0;
let activeSources = [];

async function playNextAudio() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }

    isPlaying = true;
    const arrayBuffer = audioQueue.shift();
    const pcmData = new Int16Array(arrayBuffer);

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 24000 // Gemini output rate
        });
        nextStartTime = audioContext.currentTime;
    }

    // Convert Int16 PCM to Float32 for AudioContext
    const float32Data = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 0x8000;
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

socket.on('audio-out', (data) => {
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

socket.on('transcription', (data) => {
    console.log(`[${data.type}] ${data.text}`);
});

function show_ui() {
    overlay_button.style.display = "none";
    video_playback.style.display = "block";
}

function handle_video_feed(data) {
    // console.log("Received video frame.");
    socket.emit('video-frame', data);
}

function handle_audio_feed(data) {
    // console.log("Received audio chunk.");
    socket.emit('audio-chunk', data);
}

function main() {
    indicator.setStatus("pending");
    // initialize webcam audio and video streams
    const playback_streams = new WebcamAudioVideoStream(video_playback, {
        onVideoFrame: handle_video_feed,
        onAudioData: handle_audio_feed
    });
    playback_streams.start();
    show_ui();

}

overlay_button.addEventListener("click", () => {
    main();
});