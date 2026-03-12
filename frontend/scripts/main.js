import { IndicatorLight } from "./utils.js"
import { WebcamAudioVideoStream } from "./webcam-audio-video-stream.js"

const overlay_button = document.querySelector("#overlay-button");
const video_playback = document.querySelector("#video-playback");

const indicator = new IndicatorLight();

function show_ui() {
    overlay_button.style.display = "none";
    video_playback.style.display = "block";
}

function handle_video_feed(data) {
    console.log("Received video frame.");
}

function handle_audio_feed(data) {
    console.log("Received audio chunk.");
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