import { IndicatorLight } from "./utils.js";
import { WebcamAudioVideoStream } from "./webcam-audio-video-stream.js";
import { HandTracker } from "./hand-tracker.js";
//import { SceneInterpreter } from "./scene-interpreter.js"

declare var io: any;

const overlay_button =
  document.querySelector<HTMLButtonElement>("#overlay-button");
const video_playback =
  document.querySelector<HTMLVideoElement>("#video-playback");
const activityBanner =
  document.querySelector<HTMLDivElement>("#activity-banner");
const arFocusRing = document.querySelector<HTMLDivElement>("#ar-focus-ring");
const arOverlayCard =
  document.querySelector<HTMLDivElement>("#ar-overlay-card");
const arOverlayBadge =
  document.querySelector<HTMLDivElement>("#ar-overlay-badge");
const arOverlayTitle =
  document.querySelector<HTMLDivElement>("#ar-overlay-title");
const arOverlaySubtitle = document.querySelector<HTMLDivElement>(
  "#ar-overlay-subtitle",
);
const arOverlayItems =
  document.querySelector<HTMLDivElement>("#ar-overlay-items");
const arOverlayPrompt =
  document.querySelector<HTMLDivElement>("#ar-overlay-prompt");
const generatedArStage = document.querySelector<HTMLDivElement>(
  "#generated-ar-stage",
);
const generatedArImage = document.querySelector<HTMLImageElement>(
  "#generated-ar-image",
);
const generatedArShadow = document.querySelector<HTMLDivElement>(
  "#generated-ar-shadow",
);
const celebrationLayer =
  document.querySelector<HTMLDivElement>("#celebration-layer");
const handTrackingStatus = document.createElement("div");

type ArOverlayPayload = {
  mode: "teaching" | "hunt" | "success";
  badge: string;
  title: string;
  subtitle?: string;
  prompt?: string;
  accent?: string;
  items?: string[];
  celebration?: boolean;
};

type GeneratedArObjectPayload = {
  objectName: string;
  anchorTarget: string;
  imageDataUrl: string;
  anchorBox: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  title: string;
  prompt?: string;
  accent: string;
};

type GeneratedArInteractionState =
  | "hidden"
  | "camera-space"
  | "grabbed"
  | "released";

if (
  !overlay_button ||
  !video_playback ||
  !activityBanner ||
  !arFocusRing ||
  !arOverlayCard ||
  !arOverlayBadge ||
  !arOverlayTitle ||
  !arOverlaySubtitle ||
  !arOverlayItems ||
  !arOverlayPrompt ||
  !generatedArStage ||
  !generatedArImage ||
  !generatedArShadow ||
  !celebrationLayer
) {
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
let celebrationTimeout: number | null = null;
let generatedArRefreshInterval: number | null = null;
let generatedArProcessToken = 0;
let handTracker: HandTracker | null = null;
let generatedArDragActive = false;
let generatedArDragOffsetX = 0;
let generatedArDragOffsetY = 0;
let generatedArInteractionState: GeneratedArInteractionState = "hidden";
const cleanedSpriteCache = new Map<string, string>();

function escapeHtml(value: string) {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return value.replace(
    /[&<>"']/g,
    (character) => escapes[character] || character,
  );
}

function clearCelebration() {
  if (celebrationTimeout !== null) {
    window.clearTimeout(celebrationTimeout);
    celebrationTimeout = null;
  }
  celebrationLayer.classList.add("hidden");
  celebrationLayer.innerHTML = "";
}

function triggerCelebration(accent = "#ffd166") {
  clearCelebration();
  celebrationLayer.classList.remove("hidden");

  const burst = document.createElement("div");
  burst.className = "celebration-burst";
  burst.style.color = accent;
  burst.style.setProperty("--accent", accent);
  celebrationLayer.appendChild(burst);

  for (let i = 0; i < 8; i++) {
    const star = document.createElement("div");
    star.className = "celebration-star";
    star.style.left = `${35 + Math.random() * 30}%`;
    star.style.top = `${35 + Math.random() * 30}%`;
    star.style.background = accent;
    star.style.setProperty("--tx", `${(Math.random() - 0.5) * 260}px`);
    star.style.setProperty("--ty", `${(Math.random() - 0.5) * 220}px`);
    celebrationLayer.appendChild(star);
  }

  celebrationTimeout = window.setTimeout(() => {
    clearCelebration();
  }, 1600);
}

function clearArOverlay() {
  activityBanner.textContent = "";
  activityBanner.classList.add("hidden");
  arFocusRing.classList.add("hidden");
  arOverlayCard.classList.add("hidden");
  arOverlayCard.style.removeProperty("border-color");
  arOverlayCard.style.removeProperty("box-shadow");
  arOverlayBadge.textContent = "";
  arOverlayTitle.textContent = "";
  arOverlaySubtitle.textContent = "";
  arOverlayPrompt.textContent = "";
  arOverlayItems.innerHTML = "";
  clearCelebration();
}

function stopGeneratedArRefresh() {
  if (generatedArRefreshInterval !== null) {
    window.clearInterval(generatedArRefreshInterval);
    generatedArRefreshInterval = null;
  }
}

function clearGeneratedArObject() {
  stopGeneratedArRefresh();
  generatedArStage.classList.add("hidden");
  generatedArStage.classList.remove("is-grabbed");
  generatedArStage.style.removeProperty("left");
  generatedArStage.style.removeProperty("top");
  generatedArStage.style.removeProperty("width");
  generatedArStage.style.removeProperty("height");
  generatedArImage.src = "";
  generatedArDragActive = false;
  generatedArInteractionState = "hidden";
}

function getGeneratedArStageSize() {
  return {
    width: generatedArStage.offsetWidth || 220,
    height: generatedArStage.offsetHeight || 220,
  };
}

function applyGeneratedArStagePosition(left: number, top: number) {
  const { width, height } = getGeneratedArStageSize();
  const clampedLeft = Math.max(0, Math.min(window.innerWidth - width, left));
  const clampedTop = Math.max(0, Math.min(window.innerHeight - height, top));

  generatedArStage.style.left = `${clampedLeft}px`;
  generatedArStage.style.top = `${clampedTop}px`;
}

function centerGeneratedArObject() {
  const viewportSpan = Math.min(window.innerWidth, window.innerHeight);
  const spriteWidth = Math.max(160, Math.min(viewportSpan * 0.34, 260));
  const spriteHeight = spriteWidth * 1.08;
  const left = (window.innerWidth - spriteWidth) / 2;
  const top =
    (window.innerHeight - spriteHeight) / 2 - window.innerHeight * 0.04;

  generatedArStage.style.width = `${spriteWidth}px`;
  generatedArStage.style.height = `${spriteHeight}px`;
  applyGeneratedArStagePosition(left, top);
  generatedArInteractionState = "camera-space";
}

function setHandTrackingStatus(message: string, isError = false) {
  handTrackingStatus.textContent = message;
  handTrackingStatus.dataset.state = isError ? "error" : "info";
  handTrackingStatus.classList.toggle("hidden", !message);
}

function beginGeneratedArDrag(x: number, y: number) {
  if (generatedArStage.classList.contains("hidden")) {
    return;
  }

  const { width, height } = getGeneratedArStageSize();
  generatedArDragActive = true;
  generatedArDragOffsetX = width / 2;
  generatedArDragOffsetY = height / 2;
  generatedArInteractionState = "grabbed";
  generatedArStage.classList.add("is-grabbed");
  moveGeneratedArDrag(x, y);
}

function moveGeneratedArDrag(x: number, y: number) {
  if (!generatedArDragActive) {
    return;
  }

  applyGeneratedArStagePosition(
    x - generatedArDragOffsetX,
    y - generatedArDragOffsetY,
  );
}

function endGeneratedArDrag() {
  if (generatedArDragActive) {
    generatedArInteractionState = "released";
  }
  generatedArDragActive = false;
  generatedArStage.classList.remove("is-grabbed");
}

async function removeWhiteBackground(dataUrl: string) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    return dataUrl;
  }

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const red = data[i] ?? 0;
    const green = data[i + 1] ?? 0;
    const blue = data[i + 2] ?? 0;
    if (red > 245 && green > 245 && blue > 245) {
      data[i + 3] = 0;
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function positionGeneratedArObject(
  anchorBox: GeneratedArObjectPayload["anchorBox"],
) {
  void anchorBox;
  centerGeneratedArObject();
}

async function renderGeneratedArObject(payload: GeneratedArObjectPayload) {
  const token = ++generatedArProcessToken;
  positionGeneratedArObject(payload.anchorBox);
  generatedArShadow.style.background = `radial-gradient(circle, rgba(20, 18, 16, 0.34) 0%, ${payload.accent}22 38%, rgba(20, 18, 16, 0) 74%)`;
  generatedArStage.classList.remove("hidden");

  const cleanedDataUrl =
    cleanedSpriteCache.get(payload.imageDataUrl) ||
    (await removeWhiteBackground(payload.imageDataUrl));
  if (token !== generatedArProcessToken) {
    return;
  }

  cleanedSpriteCache.set(payload.imageDataUrl, cleanedDataUrl);
  generatedArImage.src = cleanedDataUrl;
  generatedArImage.alt = payload.objectName;
  endGeneratedArDrag();
}

function renderArOverlay(payload: ArOverlayPayload) {
  const accent = payload.accent || "#b794f4";
  activityBanner.textContent =
    payload.mode === "hunt" ? payload.prompt || payload.title : payload.badge;
  activityBanner.classList.remove("hidden");

  arFocusRing.classList.toggle("hidden", payload.mode === "success");
  arFocusRing.style.borderColor = accent;
  arFocusRing.style.boxShadow = `0 0 0 12px rgba(255,255,255,0.08), 0 0 80px ${accent}55`;

  arOverlayCard.classList.remove("hidden");
  arOverlayCard.style.borderColor = `${accent}66`;
  arOverlayCard.style.boxShadow = `0 18px 48px rgba(0, 0, 0, 0.42), 0 0 0 1px ${accent}22`;
  arOverlayBadge.textContent = payload.badge;
  arOverlayTitle.textContent = payload.title;
  arOverlaySubtitle.textContent = payload.subtitle || "";
  arOverlayPrompt.textContent = payload.prompt || "";

  arOverlayItems.innerHTML = "";
  for (const item of payload.items || []) {
    const chip = document.createElement("div");
    chip.className = "ar-chip";
    chip.textContent = item;
    chip.style.background = `${accent}22`;
    chip.style.border = `1px solid ${accent}55`;
    arOverlayItems.appendChild(chip);
  }

  if (payload.celebration) {
    triggerCelebration(accent);
  } else {
    clearCelebration();
  }
}

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
    audioContext = new (
      window.AudioContext || (window as any).webkitAudioContext
    )({
      sampleRate: 24000, // Gemini output rate
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

socket.on("audio-out", (data: ArrayBuffer) => {
  audioQueue.push(data);
  if (!isPlaying) {
    playNextAudio();
  }
});

socket.on("interrupted", () => {
  audioQueue = [];
  nextStartTime = 0;
  activeSources.forEach((source) => {
    try {
      source.stop();
    } catch (e) {
      console.warn("Error stopping source:", e);
    }
  });
  activeSources = [];
  isPlaying = false;
});

socket.on("transcription", (data: { type: string; text: string }) => {
  console.log(`[${data.type}] ${data.text}`);
});

// ── Tool Call Handler ────────────────────────────────────────────────────────
socket.on("tool-call", (data: { name: string; args: any }) => {
  if (data.name === "show_visual") {
    const args = data.args;
    // Remove any existing popup first
    const existing = document.querySelector(".media-popup");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.className = "media-popup";

    if (args.type === "video" && args.videoId) {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube.com/embed/${args.videoId}?autoplay=1&mute=1`;
      iframe.allow = "autoplay; encrypted-media";
      iframe.allowFullscreen = true;
      popup.appendChild(iframe);
    } else if (args.url) {
      const img = document.createElement("img");
      img.src = args.url;
      img.alt = args.title || "";
      // Prevent Google CDN from rejecting requests due to referrer
      img.referrerPolicy = "no-referrer";
      img.crossOrigin = "anonymous";
      // If the image fails to load, show a placeholder gradient
      img.onerror = () => {
        img.style.display = "none";
        const fallback = document.createElement("div");
        fallback.style.cssText =
          "width:100%;height:180px;display:flex;align-items:center;justify-content:center;" +
          "background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);color:#fff;" +
          "font-family:'Inter',sans-serif;font-size:42px;";
        fallback.textContent = "🖼️";
        popup.insertBefore(fallback, popup.firstChild);
      };
      popup.appendChild(img);
    }

    const title = document.createElement("div");
    title.className = "media-popup-title";
    title.textContent = args.title;
    popup.appendChild(title);

    document.body.appendChild(popup);

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      popup.classList.add("dismissing");
      setTimeout(() => popup.remove(), 500);
    }, 10000);
    return;
  }

  if (data.name === "ar_overlay") {
    renderArOverlay(data.args as ArOverlayPayload);
    return;
  }

  if (data.name === "clear_ar_overlay") {
    clearArOverlay();
    return;
  }

  if (data.name === "generated_ar_status") {
    const args = data.args as { message?: string };
    if (args.message) {
      activityBanner.textContent = args.message;
      activityBanner.classList.remove("hidden");
    } else if (activityBanner.textContent?.includes("Making ")) {
      activityBanner.textContent = "";
      activityBanner.classList.add("hidden");
    }
    return;
  }

  if (data.name === "generated_ar_object") {
    const payload = data.args as GeneratedArObjectPayload;
    void renderGeneratedArObject(payload);
    return;
  }

  if (data.name === "clear_generated_ar_object") {
    clearGeneratedArObject();
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
  socket.emit("video-frame", data);

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
  socket.emit("audio-chunk", data);
}

async function main() {
  indicator.setStatus("pending");
  if (!document.body.contains(handTrackingStatus)) {
    handTrackingStatus.className = "hand-tracking-status hidden";
    document.body.appendChild(handTrackingStatus);
  }

  setHandTrackingStatus("Starting camera...");
  // initialize webcam audio and video streams
  const playback_streams = new WebcamAudioVideoStream(video_playback!, {
    onVideoFrame: handle_video_feed,
    onAudioData: handle_audio_feed,
  });
  await playback_streams.start();
  setHandTrackingStatus("Hand tracking is loading...");

  if (!handTracker) {
    handTracker = new HandTracker(video_playback!, {
      onPinchStart: beginGeneratedArDrag,
      onPinchMove: moveGeneratedArDrag,
      onPinchEnd: endGeneratedArDrag,
      onReady: () => {
        setHandTrackingStatus("Pinch anywhere to grab the object.");
        window.setTimeout(() => setHandTrackingStatus(""), 2200);
      },
      onError: (message) => {
        setHandTrackingStatus(`Hand tracking unavailable: ${message}`, true);
      },
    });
  }

  void handTracker.start();
  show_ui();
}

overlay_button.addEventListener("click", () => {
  void main();
});

window.addEventListener("resize", () => {
  if (!generatedArStage.classList.contains("hidden")) {
    applyGeneratedArStagePosition(
      generatedArStage.offsetLeft,
      generatedArStage.offsetTop,
    );
  }
});
