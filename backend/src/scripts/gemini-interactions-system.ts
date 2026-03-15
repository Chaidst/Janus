import { Socket } from "socket.io";
import {
  GoogleGenAI,
  Modality,
  type Schema,
  type Session,
  Type,
  StartSensitivity,
  EndSensitivity,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import { MediaSearchService } from "./media-search-service.js";
import { db } from "./firebase.js";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import { mkdtemp, writeFile, readFile, rm, copyFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { tmpdir } from "os";

const LIVE_PROMPT = `You are a warm, gentle, and encouraging learning companion for little ones aged 2 to 6. You interact through real-time audio and video, meaning you share their world, see what they see, and chat with them just like a supportive, friendly playmate.
### Your Heart and Boundaries
* Be a gentle guide: Be an active, patient listener. Instead of just handing out answers, gently guide the child to discover things on their own, sparking their natural curiosity and wonder.
* Speak their language: Talk with the warmth, patience, and simplicity of a caring helper. Keep your words and tone easy for a toddler or preschooler to grasp.
* Respect the parents' role: Remember, you are a companion, not a parent or guardian. Never step into a parental role, and leave discipline, safety interventions, and deep personal guidance to the real-life grown-ups in the room.
* Read the room: Pay close attention to their physical world and their feelings. Notice if a tower of blocks is getting wobbly, or if a child's face looks frustrated.
* Embrace quiet moments: Know when to just watch and smile. If the child is deeply focused on a puzzle, chatting with a sibling, or having a tough emotional moment, give them space. Do not interrupt; just be a quiet, supportive presence.

### Seeing and Sharing Their World
* Notice the little things: Use your "eyes" (the video feed) to truly see their environment. If they pick up a crunchy autumn leaf, feel a fuzzy blanket, or draw a squiggly blue line, use those details to start a fun conversation.
* Ask playful questions: Spark dialogue based on what they are doing right in that moment. Try open-ended questions like, "Wow, how many blocks did you stack there?" or "Can you tell me a story about your wonderful drawing?"
* Build a friendship: Remember what makes them unique. Keep track of their favorite colors, the names of their stuffed animals, and the topics they love, using these details to make your time together feel special and personalized over time.

### Your Guiding Principles
1. Always be present: Watch and listen closely at all times.
2. Add value, not noise: Chime in only when your words bring a smile, a comforting thought, or a fun learning moment.
3. Bring ideas to life: Use your Augmented Reality (AR) tools like magic to make tricky or abstract ideas visual, playful, and interactive.
4. Tidy up: Clear away your AR visuals and playful graphics when the activity is over so their view stays clean and focused.

5. Safety first: Above all else, let the child's safety, happiness, and current developmental stage guide every single thing you do.

Speak very naturally and softly.`;

const LIVE_COPLAY_GUIDANCE = `
### AR Teaching and Co-Play
* When the child shows you a flower, machine, animal, toy, shape, or color-rich object, use AR teaching tools to make the moment visual and interactive.
* Keep co-play loops short, concrete, and playful. One task at a time.
* Good AR teaching examples:
  - flower -> petals, colors, counting
  - machine -> wheel, button, handle, gear
  - animal -> ears, tail, paws, colors
* If you start a scavenger hunt, clearly say what to find and keep watching the camera until the child finds it.
* When the child succeeds, celebrate briefly with the success tool and then either ask one follow-up or end the activity.
* If the child loses interest or switches topics, clear the overlay and return to normal conversation.
* Do not stack many activities at once. Finish or end the current one first.`;

const LIVE_GENERATED_AR_GUIDANCE = `
### Generated AR Objects
* If the child asks you to show a creature or object on a real surface, like "show me a dinosaur on my table", use the generated AR object tool.
* Use generated AR objects for magical demo moments: dinosaurs on tables, stars on a pillow, a tiny robot on a desk.
* Prefer clear flat anchors like table, desk, floor, or wall.
* If the child changes subjects, remove the generated AR object.`;

const HELPER_PROMPT = "";

type ToolData = {
  handler: Function;
  description: string;
  schema: Schema;
};

type CoPlayMode = "idle" | "teaching" | "scavenger_hunt";

type CoPlayState = {
  mode: CoPlayMode;
  objectType?: string;
  focus?: string;
  prompt?: string;
  targetType?: string;
  targetValue?: string;
};

type SessionActivity = {
  type: string;
  title: string;
  detail: string;
  timestamp: number;
};

type ArOverlayPayload = {
  mode: string;
  badge: string;
  title: string;
  subtitle?: string;
  prompt?: string;
  accent: string;
  items: string[];
  celebration?: boolean;
};

type AnchorBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type GeneratedArObjectState = {
  objectName: string;
  anchorTarget: string;
  imageDataUrl: string;
  prompt?: string | undefined;
  accent: string;
};

type SessionMessage = {
  role: "user" | "model";
  text: string;
  timestamp: number;
};

type FeedbackTracking = {
  video_last_sent: number;
  audio_last_sent: number;
  gemini_last_spoke: number;
  gemini_last_analyzed_audio_video: number;
  gemini_audio_playback_ends_at: number;
  user_last_spoke: number;
  last_silence_analysis_at: number;
  video_history_last_updated: number;
};

type AudioMetrics = {
  peakAmplitude: number;
  meanAmplitude: number;
  zeroCrossingRate: number;
  lowFreqEnergy: number;
  midFreqEnergy: number;
  highFreqEnergy: number;
};

class GeminiHelper {
  private static readonly HELPER_MODEL = "gemini-2.5-flash-lite";
  private AI: GoogleGenAI;

  constructor(AI: GoogleGenAI) {
    this.AI = AI;
  }

  public async askTrueFalseQuestion(
    question: string,
    inline_data: object | null = null,
  ): Promise<GenerateContentResponse> {
    const pre_prompt = `You are an objective evaluator tasked with answering a True/False question.
You must make a definitive decision (true or false) based on logical reasoning, facts, and your best available knowledge.
Even if the topic is highly nuanced or debated, weigh the evidence and commit to the most accurate boolean outcome.
Provide a concise explanation justifying how you arrived at your conclusion.
If provided with a video clip to help answer the question, understand the clip consists of frames taken at 1-second intervals.
You might also be provided with an audio clip to help answer the question.
Statement/Question to evaluate:`;

    let generation_parameters: GenerateContentParameters = {
      model: GeminiHelper.HELPER_MODEL,
      contents: [],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: {
              type: Type.BOOLEAN,
              description: "The true/false answer to the question.",
            },
            explanation: {
              type: Type.STRING,
              description: "A brief explanation for the answer.",
            },
          },
          required: ["answer", "explanation"],
        },
      },
    };

    let parts: any[] = [{ text: `${pre_prompt} ${question}` }];
    if (inline_data !== null) {
      parts.push({ inlineData: inline_data });
    }
    generation_parameters.contents = [{ role: "user", parts }];

    const response = await this.AI.models.generateContent(
      generation_parameters,
    );
    console.log("Response:", response.text);
    return response;
  }

  public async analyzeVideoHistory(
    video_data: object,
  ): Promise<GenerateContentResponse> {
    const prompt =
      "You are an AI companion for a child. Analyze this short video clip (approximately 5 seconds) of the child's recent activity. " +
      "The clip consists of frames taken at 1-second intervals. " +
      "Please provide a narrative description of what is happening in the sequence. " +
      "Avoid meta-commentary about the images being screenshots or static; instead, interpret them as a continuous event. " +
      "Describe the child's actions, their emotional state, and any interesting objects or changes in the scene.";

    let generation_parameters: GenerateContentParameters = {
      model: GeminiHelper.HELPER_MODEL,
      contents: [],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: {
              type: Type.STRING,
              description: "A detailed description of the video content.",
            },
            detected_activity: {
              type: Type.STRING,
              description: "A short label for the primary activity detected.",
            },
            emotional_tone: {
              type: Type.STRING,
              description: "The perceived emotional tone of the scene.",
            },
          },
          required: ["description", "detected_activity", "emotional_tone"],
        },
      },
    };

    generation_parameters.contents = [
      {
        role: "user",
        parts: [{ text: prompt }, { inlineData: video_data }],
      },
    ];

    const response = await this.AI.models.generateContent(
      generation_parameters,
    );
    console.log("Video Analysis Response:", response.text);
    return response;
  }
}

class Tools {
  private tools: Map<string, ToolData> = new Map();
  private AI: GoogleGenAI;
  private socket: Socket;

  constructor(AI: GoogleGenAI, socket: Socket) {
    this.AI = AI;
    this.socket = socket;
  }

  public register(
    name: string,
    description: string,
    parameters: Record<string, any>,
    handler: Function,
  ) {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: parameters,
      required: Object.keys(parameters),
    };
    this.tools.set(name, { handler, description, schema });
  }

  public get_tools_schema(): any[] {
    const declarations: any[] = [];
    for (const [name, data] of this.tools.entries()) {
      declarations.push({
        name,
        description: data.description,
        parameters: data.schema,
      });
    }
    return [{ functionDeclarations: declarations }];
  }

  public getTool(name: string): ToolData | undefined {
    return this.tools.get(name);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}

export class GeminiInteractionSystem {
  private static readonly LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
  private static readonly LIVE_VOICE_NAME = "Zephyr";

  private static readonly VIDEO_SENT_RATE = 1000;
  private static readonly AUDIO_SENT_RATE = 40;

  private static readonly CONTEXT_HISTORY_MS = 5000;
  private static readonly SILENCE_TIMEOUT_MS = 5000;
  private static readonly POST_SPEECH_QUIET_WINDOW_MS = 2000;
  private static readonly USER_SPEECH_ENERGY_THRESHOLD = 900;
  private static readonly USER_SPEECH_HOLD_MS = 900;
  private static readonly AUDIO_SAMPLE_RATE = 16000;
  private static readonly OUTPUT_AUDIO_SAMPLE_RATE = 24000;
  private static readonly OUTPUT_AUDIO_BYTES_PER_SAMPLE = 2;
  private static readonly MAX_AUDIO_HISTORY_SIZE =
    (GeminiInteractionSystem.CONTEXT_HISTORY_MS / 1000) *
    GeminiInteractionSystem.AUDIO_SAMPLE_RATE;
  private static readonly VIDEO_FPS = 1;
  private static readonly MAX_VIDEO_HISTORY_SIZE =
    (GeminiInteractionSystem.CONTEXT_HISTORY_MS / 1000) *
    GeminiInteractionSystem.VIDEO_FPS;
  // audio processing constants for speech detection
  private static readonly SPEECH_DEBOUNCE_MS = 150;
  private static readonly LOW_FREQ_THRESHOLD = 250;
  private static readonly MIN_ZERO_CROSSING_RATE = 0.05;
  private static readonly MAX_ZERO_CROSSING_RATE = 0.5;

  private AI: GoogleGenAI;
  private socket: Socket;
  private session: Session | null = null;
  private tools: Tools;
  private helper: GeminiHelper;
  private mediaSearch: MediaSearchService;
  private readonly keyType: "studio" | "vertex";

  private sessionId: string;
  private sessionRef: FirebaseFirestore.DocumentReference;
  private sessionMessages: SessionMessage[] = [];
  private coPlayState: CoPlayState = { mode: "idle" };
  private sessionActivities: SessionActivity[] = [];
  private latestFrameBase64: string | null = null;
  private activeGeneratedArObject: GeneratedArObjectState | null = null;
  private generatedSpriteCache = new Map<string, string>();

  private videoHistory: string[] = [];
  private audioHistory: Int16Array;
  private audioBuffer: Int16Array;

  private feedbackTracking: FeedbackTracking;
  private geminiSilenceTimeout: NodeJS.Timeout | null = null;
  private speechDebounceTimeout: NodeJS.Timeout | null = null;
  private consecutiveSpeechFrames: number = 0;
  private readonly SYSTEM_START_TIME: number;

  private socketsInitialized = false;
  private isSilentDisconnected = false;
  private isAnalyzingContext = false;
  private isGeminiSpeaking = false;
  private isUserSpeaking = false;
  private geminiSpeechEndedAt = 0;
  private userSpeechEndedAt = 0;
  private geminiGenerationInFlight = false;
  private isWakeUpResponseInProgress = false;
  private isShuttingDown = false;
  private pendingToolCalls = 0;

  private stateLock: Promise<void> = Promise.resolve();
  private sessionStateVersion: number = 0;

  constructor(
    api_key: string,
    user_socket: Socket,
    key_type: "studio" | "vertex" = "studio",
  ) {
    this.SYSTEM_START_TIME = Date.now();
    this.keyType = key_type;

    if (key_type === "studio") {
      this.AI = new GoogleGenAI({ apiKey: api_key, apiVersion: "v1alpha" });
    } else {
      const project = process.env.GOOGLE_CLOUD_PROJECT || "norse-ego-479919-v2";
      const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

      this.AI = new GoogleGenAI({
        vertexai: true,
        project: project,
        location: location,
      });
    }

    this.socket = user_socket;
    this.tools = new Tools(this.AI, user_socket);
    this.helper = new GeminiHelper(this.AI);
    this.mediaSearch = new MediaSearchService();

    this.sessionId = `${this.SYSTEM_START_TIME}_${Math.random().toString(36).substr(2, 9)}`;
    this.sessionRef = db
      .collection("families")
      .doc("default")
      .collection("children")
      .doc("default")
      .collection("sessions")
      .doc(this.sessionId);

    // initialize buffers
    this.audioHistory = new Int16Array(
      GeminiInteractionSystem.MAX_AUDIO_HISTORY_SIZE,
    );
    this.audioBuffer = new Int16Array(0);

    // initialize feedback tracking
    const now = Date.now();
    this.feedbackTracking = {
      video_last_sent: now,
      audio_last_sent: now,
      gemini_last_spoke: now,
      gemini_last_analyzed_audio_video: now,
      gemini_audio_playback_ends_at: now,
      user_last_spoke: 0,
      last_silence_analysis_at: 0,
      video_history_last_updated: 0,
    };

    // initialize session in firestore
    this.initializeSessionDocument();

    this.initializeTools();
    this.initializeSockets();
    this.connectLiveSession();
  }

  private async initializeSessionDocument(): Promise<void> {
    try {
      await this.sessionRef.set({
        startedAt: this.SYSTEM_START_TIME,
        summary: "",
        messages: [],
        activities: [],
        coPlayState: this.coPlayState,
        stateVersion: 0,
      });
    } catch (error) {
      console.error("Failed to initialize session document:", error);
    }
  }

  private initializeSockets(): void {
    if (this.socketsInitialized) return;
    this.socketsInitialized = true;

    this.socket.on("video-frame", (data: string) => {
      if (this.isShuttingDown) return;
      this.handleVideoFrame(data);
    });

    this.socket.on("request-ar-anchor-refresh", async () => {
      if (this.isShuttingDown) return;
      await this.refreshGeneratedArAnchor();
    });

    this.socket.on("clear-generated-ar-object", () => {
      if (this.isShuttingDown) return;
      this.activeGeneratedArObject = null;
    });

    this.socket.on("audio-chunk", (data: any) => {
      if (this.isShuttingDown) return;
      this.handleAudioChunk(data);
    });

    this.socket.on("disconnect", () => {
      console.log("Client disconnected");
      this.handleDisconnect();
    });
  }

  private async handleDisconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.clearAllTimeouts();

    try {
      await this.generateSummary();
    } catch (error) {
      console.error("Error generating summary during disconnect:", error);
    } finally {
      this.shutdownSockets();
      this.closeSession();
    }
  }

  private clearAllTimeouts(): void {
    if (this.geminiSilenceTimeout) {
      clearTimeout(this.geminiSilenceTimeout);
      this.geminiSilenceTimeout = null;
    }
    if (this.speechDebounceTimeout) {
      clearTimeout(this.speechDebounceTimeout);
      this.speechDebounceTimeout = null;
    }
  }

  private shutdownSockets(): void {
    this.clearAllTimeouts();
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }

  private closeSession(): void {
    if (this.session) {
      try {
        this.session.close();
      } catch (error) {
        console.error("Error closing session:", error);
      }
      this.session = null;
    }
    this.resetConnectionState();
  }

  private resetConnectionState(): void {
    this.geminiGenerationInFlight = false;
    this.isSilentDisconnected = false;
    this.isWakeUpResponseInProgress = false;
    this.isAnalyzingContext = false;
  }

  private isSessionValid(): boolean {
    return this.session !== null && !this.isShuttingDown;
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireStateLock();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquireStateLock(): Promise<() => void> {
    let resolveRelease: () => void;
    const newLock = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });

    const previousLock = this.stateLock;
    this.stateLock = newLock;

    return previousLock.then(() => resolveRelease!);
  }

  private async persistMessages(): Promise<void> {
    const version = ++this.sessionStateVersion;
    try {
      await this.sessionRef.update({
        messages: this.sessionMessages.slice(-100),
        stateVersion: version,
        lastMessageAt: Date.now(),
      });
    } catch (error) {
      console.error("Failed to persist messages:", error);
      this.sessionStateVersion--;
    }
  }

  private async persistCoPlayState(): Promise<void> {
    const version = ++this.sessionStateVersion;
    try {
      await this.sessionRef.update({
        coPlayState: this.coPlayState,
        stateVersion: version,
      });
    } catch (error) {
      console.error("Failed to persist coPlayState:", error);
      this.sessionStateVersion--;
    }
  }

  private async connectLiveSession(wakeReason?: string): Promise<void> {
    if (this.isShuttingDown) return;

    const reason = wakeReason?.trim();
    this.resetConnectionState();

    try {
      const session = await this.AI.live.connect({
        model: GeminiInteractionSystem.LIVE_MODEL,
        callbacks: {
          onopen: () => {
            console.log("A user has connected to the Gemini Live API!");
          },
          onclose: (event) => {
            console.log("Gemini Live session closed:", event);
            this.handleSessionClose();
          },
          onmessage: (message) => {
            if (this.isShuttingDown) return;
            this.handleSessionMessage(message);
          },
          onerror: (error) => {
            console.error("Error in Gemini Live session:", error);
            this.handleSessionError();
          },
        },
        config: {
          systemInstruction: `${LIVE_PROMPT}\n${LIVE_COPLAY_GUIDANCE}\n${LIVE_GENERATED_AR_GUIDANCE}`,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: GeminiInteractionSystem.LIVE_VOICE_NAME,
              },
            },
          },
          enableAffectiveDialog: true,
          tools: this.tools?.get_tools_schema() || [],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
              prefixPaddingMs: 80,
              silenceDurationMs: 300,
            },
          },
        },
      });

      this.session = session;
      this.isSilentDisconnected = false;
      this.geminiGenerationInFlight = false;
      this.scheduleGeminiSilenceCallback();

      if (reason) {
        this.sendWakePrompt(reason);
        return;
      }
      // ensure at least one completed turn so vertex starts the conversation
      if (this.keyType === "vertex" && this.isSessionValid()) {
        this.session.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: "Please greet the child in one short sentence and begin in your warm helper style.",
                },
              ],
            },
          ],
          turnComplete: false,
        });
      }
    } catch (error) {
      console.error("Error connecting to Gemini Live API:", error);
      this.handleSessionError();
    }
  }

  private handleSessionClose(): void {
    this.session = null;
    this.resetConnectionState();

    if (!this.isSilentDisconnected && !this.isShuttingDown) {
      this.markGeminiSpeechEnded();
    }
  }

  private handleSessionError(): void {
    this.session = null;
    this.resetConnectionState();

    if (!this.isSilentDisconnected && !this.isShuttingDown) {
      this.shutdownSockets();
    }
  }

  private handleSessionMessage(message: any): void {
    const content = message.serverContent;
    console.log(content);

    if (content?.modelTurn?.parts) {
      this.handleModelTurn(content.modelTurn.parts);
    }

    if (content?.interrupted) {
      this.handleInterruption();
    }

    if (content?.inputTranscription) {
      this.handleInputTranscription(content.inputTranscription);
    }

    if (content?.outputTranscription) {
      this.handleOutputTranscription(content.outputTranscription);
    }

    if (content?.turnComplete) {
      this.geminiGenerationInFlight = false;
      this.isWakeUpResponseInProgress = false;
    }

    this.scheduleGeminiSilenceCallback();

    if (message.toolCall?.functionCalls?.length > 0) {
      console.log("Tools to call:", message.toolCall.functionCalls);
      this.handleToolCalls(message.toolCall.functionCalls);
    }
  }

  private handleModelTurn(parts: any[]): void {
    this.geminiGenerationInFlight = true;

    for (const part of parts) {
      if (part.inlineData?.data) {
        const audioBuffer = Buffer.from(part.inlineData.data, "base64");
        const durationMs =
          (audioBuffer.length /
            GeminiInteractionSystem.OUTPUT_AUDIO_BYTES_PER_SAMPLE /
            GeminiInteractionSystem.OUTPUT_AUDIO_SAMPLE_RATE) *
          1000;
        const playbackEndsAt = Date.now() + durationMs;

        this.isGeminiSpeaking = true;
        this.feedbackTracking.gemini_audio_playback_ends_at = Math.max(
          this.feedbackTracking.gemini_audio_playback_ends_at,
          playbackEndsAt,
        );

        this.socket.emit("audio-out", audioBuffer);
      }
    }

    this.scheduleGeminiSilenceCallback();
  }

  private handleInterruption(): void {
    this.geminiGenerationInFlight = false;
    this.markGeminiSpeechEnded();
    this.socket.emit("interrupted");
  }

  private async handleInputTranscription(transcription: any): Promise<void> {
    const now = Date.now();
    this.feedbackTracking.user_last_spoke = now;
    this.isUserSpeaking = true;

    if (!this.isSilentDisconnected) {
      this.isSilentDisconnected = false;
    }

    this.socket.emit("transcription", {
      type: "user",
      text: transcription.text,
    });

    await this.withStateLock(async () => {
      this.sessionMessages.push({
        role: "user",
        text: transcription.text || "",
        timestamp: now,
      });
      await this.persistMessages();
    });

    this.scheduleGeminiSilenceCallback();
  }

  private async handleOutputTranscription(transcription: any): Promise<void> {
    const now = Date.now();
    this.feedbackTracking.gemini_last_spoke = now;
    this.isGeminiSpeaking = true;
    this.isSilentDisconnected = false;

    this.scheduleGeminiSilenceCallback();

    this.socket.emit("transcription", {
      type: "model",
      text: transcription.text,
    });

    await this.withStateLock(async () => {
      this.sessionMessages.push({
        role: "model",
        text: transcription.text || "",
        timestamp: now,
      });
      await this.persistMessages();
    });
  }

  private async handleToolCalls(functionCalls: any[]): Promise<void> {
    if (!this.isSessionValid()) {
      console.warn("Cannot handle tool calls: session is not valid");
      return;
    }

    this.pendingToolCalls++;
    const responses: any[] = [];

    try {
      for (const call of functionCalls) {
        const toolData = this.tools.getTool(call.name);

        if (!toolData) {
          console.warn(`Unknown tool: ${call.name}`);
          continue;
        }

        try {
          const toolResult = await this.executeToolWithTimeout(
            toolData.handler,
            call.args,
            30000,
          );

          responses.push({
            id: call.id,
            name: call.name,
            response: toolResult ?? { success: true },
          });
        } catch (error) {
          console.error(`Error executing tool ${call.name}:`, error);
          responses.push({
            id: call.id,
            name: call.name,
            response: { success: false, error: String(error) },
          });
        }
      }
    } finally {
      this.pendingToolCalls--;
    }

    await this.sendToolResponses(responses);
  }

  private async executeToolWithTimeout(
    handler: Function,
    args: any,
    timeoutMs: number,
  ): Promise<any> {
    return Promise.race([
      handler(args),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  private async sendToolResponses(responses: any[]): Promise<void> {
    if (responses.length === 0) return;

    if (!this.isSessionValid()) {
      console.warn("Cannot send tool responses: session is no longer valid");
      return;
    }

    // softly interrupt any ongoing gemini speech before sending tool responses
    // this ensures the new response takes precedence
    if (this.isGeminiSpeaking || this.geminiGenerationInFlight) {
      this.handleInterruption();
    }

    try {
      this.session!.sendToolResponse({
        functionResponses: responses,
      });
    } catch (error) {
      console.error("Error sending tool response:", error);
    }
  }

  private scheduleGeminiSilenceCallback(): void {
    if (this.isShuttingDown) return;

    if (this.isSilentDisconnected && this.geminiSilenceTimeout) {
      return;
    }

    if (this.geminiSilenceTimeout) {
      clearTimeout(this.geminiSilenceTimeout);
    }

    this.geminiSilenceTimeout = setTimeout(() => {
      if (this.isShuttingDown) return;

      this.geminiSilenceTimeout = null;
      this.refreshSpeakingState();

      if (!this.canActivateFromSilence()) {
        this.scheduleGeminiSilenceCallback();
        return;
      }

      this.feedbackTracking.last_silence_analysis_at = Date.now();

      if (!this.isSilentDisconnected) {
        this.isSilentDisconnected = true;
        this.closeSession();
      }

      void this.analyzeContext();
      this.scheduleGeminiSilenceCallback();
    }, GeminiInteractionSystem.POST_SPEECH_QUIET_WINDOW_MS);
  }

  private refreshSpeakingState(): void {
    const now = Date.now();

    if (
      this.isGeminiSpeaking &&
      !this.geminiGenerationInFlight &&
      now >=
        this.feedbackTracking.gemini_audio_playback_ends_at +
          GeminiInteractionSystem.POST_SPEECH_QUIET_WINDOW_MS
    ) {
      this.markGeminiSpeechEnded();
    }

    if (
      this.isUserSpeaking &&
      now >=
        this.feedbackTracking.user_last_spoke +
          GeminiInteractionSystem.USER_SPEECH_HOLD_MS
    ) {
      this.markUserSpeechEnded();
    }
  }

  private canActivateFromSilence(options?: {
    allowDuringAnalysis?: boolean;
  }): boolean {
    this.refreshSpeakingState();

    if (!options?.allowDuringAnalysis && this.isAnalyzingContext) return false;
    if (this.geminiGenerationInFlight) return false;
    if (this.isGeminiSpeaking) return false;
    if (this.pendingToolCalls > 0) return false;

    if (!this.isSilentDisconnected && this.isUserSpeaking) return false;

    const now = Date.now();
    const quietSince = this.getLastConversationActivityAt();

    if (!this.isSilentDisconnected) {
      const userQuietSince = Math.max(
        this.feedbackTracking.user_last_spoke,
        this.userSpeechEndedAt,
      );

      if (
        now - userQuietSince <
        GeminiInteractionSystem.POST_SPEECH_QUIET_WINDOW_MS
      ) {
        return false;
      }
    }

    if (
      now - quietSince <
      GeminiInteractionSystem.POST_SPEECH_QUIET_WINDOW_MS
    ) {
      return false;
    }

    return now - quietSince >= GeminiInteractionSystem.SILENCE_TIMEOUT_MS;
  }

  private getLastConversationActivityAt(): number {
    return Math.max(
      this.feedbackTracking.gemini_audio_playback_ends_at,
      this.feedbackTracking.gemini_last_spoke,
      this.geminiSpeechEndedAt,
    );
  }

  private markGeminiSpeechEnded(): void {
    const now = Date.now();
    this.isGeminiSpeaking = false;
    this.geminiSpeechEndedAt = now;
    this.feedbackTracking.gemini_last_spoke = Math.max(
      this.feedbackTracking.gemini_last_spoke,
      now,
    );
  }

  private markUserSpeechEnded(): void {
    const now = Date.now();
    this.isUserSpeaking = false;
    this.userSpeechEndedAt = now;
    this.feedbackTracking.user_last_spoke = Math.max(
      this.feedbackTracking.user_last_spoke,
      now,
    );
  }

  private async analyzeContext(): Promise<void> {
    if (this.isAnalyzingContext || !this.canActivateFromSilence()) return;

    const lockAcquired = await this.acquireAnalysisLock();
    if (!lockAcquired) return;

    try {
      const resumeReason = await this.determineResumeReason();

      if (
        resumeReason &&
        this.canActivateFromSilence({ allowDuringAnalysis: true })
      ) {
        await this.resumeSessionFromSilence(resumeReason);
      }
    } catch (error) {
      console.error("Error analyzing context:", error);
    } finally {
      this.isAnalyzingContext = false;
    }
  }

  private async acquireAnalysisLock(): Promise<boolean> {
    if (this.isAnalyzingContext) return false;
    this.isAnalyzingContext = true;
    return true;
  }

  private async determineResumeReason(): Promise<string | null> {
    const videoReason = await this.analyzeVideoForResume();
    if (videoReason) return videoReason;

    const audioReason = await this.analyzeAudioForResume();
    return audioReason;
  }

  private async analyzeVideoForResume(): Promise<string | null> {
    const base64Video = await this.getVideoHistoryAsBase64();
    if (!base64Video) return null;

    const response = await this.helper.askTrueFalseQuestion(
      "Based on this recent video clip, should the companion speak to the child right now? Answer true if the child seems to need engagement, encouragement, or help. Answer false if the child seems happily focused or no response is needed.",
      { data: base64Video, mimeType: "video/mp4" },
    );

    const decision = this.parseDecision(response.text);
    if (decision.answer) {
      return (
        decision.explanation?.trim() ||
        "the child seemed ready for a gentle check-in."
      );
    }
    return null;
  }

  private async analyzeAudioForResume(): Promise<string | null> {
    const base64Audio = await this.getAudioHistoryAsWavBase64();
    if (!base64Audio) return null;

    const response = await this.helper.askTrueFalseQuestion(
      `### SYSTEM ROLE
      You are an intelligent Audio Filter for an AI companion. Your primary job is to act as a gatekeeper: you distinguish between rhythmic background noise (like music, bass, or machinery) and intentional human commands or sudden household accidents.

      ### HOW TO DECIDE (TRUE vs. FALSE)

      **1. Listen for the Wake Word (TRUE)**
      If you hear the word "Gemini" followed immediately by a request or a pause for a response, this is a valid trigger. However, if the name is just mentioned in passing during a conversation with someone else (e.g., "I'm a Gemini"), ignore it.

      **2. Detect Sudden Household Emergencies (TRUE)**
      Look for sharp, non-repeating, high-impact sounds that suggest something has gone wrong in the physical environment. Examples include glass shattering, a heavy object falling, or a loud thud that isn't part of a sequence.

      **3. The Rhythm Filter (FALSE)**
      This is your most important rule: If a sound is rhythmic, mathematical, or repetitive, it is NOT an emergency or a command.
      * **Music/Bass:** Even if it's a slow, heavy "thump," if it follows a steady beat (BPM), it is music. Ignore it.
      * **Machinery:** Constant hums from a dishwasher, the vibration of a laundry machine, or a rhythmic HVAC fan are background noise. Ignore them.

      **4. Media & Entertainment (FALSE)**
      Ignore voices coming from a TV, radio, or podcast. These are usually identifiable by their consistent volume levels and lack of a direct "address" to the device.

      ### QUICK EVALUATION PROTOCOL
      * Is the sound repetitive or following a beat? If YES, it's music or a machine—output FALSE.
      * Is the low-frequency vibration part of a song? If YES, output FALSE.
      * Is the person looking for a response from "Gemini"? If YES, output TRUE.
      * Is it a sudden, one-time crash or impact? If YES, output TRUE.

      ### EXAMPLES
      * **Audio:** [Steady 128 BPM electronic bassline with muffled lyrics] -> **Output:** FALSE (Reason: Rhythmic music)
      * **Audio:** "Gemini, turn off the kitchen lights." -> **Output:** TRUE (Reason: Direct wake word and command)
      * **Audio:** [A single, sharp crash of glass hitting a tile floor] -> **Output:** TRUE (Reason: Physical emergency/impact)
      * **Audio:** [The rhythmic "thump-thump" of a dryer with a heavy shoe inside] -> **Output:** FALSE (Reason: Rhythmic mechanical noise)
      * **Audio:** "I think Gemini is a cool name for a dog." -> **Output:** FALSE (Reason: Incidental mention)

      ### INPUT DATA
      **Audio Data:** [Insert Audio/Transcript Here]
      **Output:**`,
      { data: base64Audio, mimeType: "audio/wav" },
    );

    const decision = this.parseDecision(response.text);
    if (decision.answer) {
      return (
        decision.explanation?.trim() ||
        "audio suggested the child needed attention."
      );
    }
    return null;
  }

  private parseDecision(responseText: string | undefined): {
    answer?: boolean;
    explanation?: string;
  } {
    try {
      return JSON.parse(responseText || "{}") as {
        answer?: boolean;
        explanation?: string;
      };
    } catch (parseError) {
      console.error("Failed to parse helper response:", parseError);
      return {};
    }
  }

  private buildRecentContext(maxMessages = 12): string {
    if (this.sessionMessages.length === 0) {
      return "No prior conversation yet.";
    }
    const recent = this.sessionMessages.slice(-maxMessages);
    return recent.map((m) => `${m.role}: ${m.text}`).join("\n");
  }

  private sendWakePrompt(reason: string): void {
    if (!this.isSessionValid()) return;

    this.isWakeUpResponseInProgress = true;
    const context = this.buildRecentContext();
    const prompt = `You were quiet to respect the child's focus. You are waking up because: ${reason}\nRecent conversation context:\n${context}\nRespond in one short, warm sentence that fits what the child is doing right now. Do not call any tools unless the child explicitly asks you to.`;

    this.session!.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      turnComplete: true,
    });
  }

  private async resumeSessionFromSilence(reason: string): Promise<void> {
    const wakeReason =
      reason.trim() || "the child seemed ready for a gentle check-in.";

    if (!this.canActivateFromSilence({ allowDuringAnalysis: true })) {
      this.scheduleGeminiSilenceCallback();
      return;
    }

    if (this.isSessionValid()) {
      this.sendWakePrompt(wakeReason);
    } else {
      await this.connectLiveSession(wakeReason);
    }
  }

  private handleVideoFrame(data: string): void {
    const base64Data = data.split(",")[1];
    if (!base64Data) return;

    this.latestFrameBase64 = base64Data;

    const currentTime = Date.now();
    const videoUpdateRate = 1000 / GeminiInteractionSystem.VIDEO_FPS;

    if (
      currentTime - this.feedbackTracking.video_history_last_updated >
      videoUpdateRate
    ) {
      this.feedbackTracking.video_history_last_updated = currentTime;
      this.addVideoFrame(base64Data);
    }

    if (
      currentTime - this.feedbackTracking.video_last_sent >
        GeminiInteractionSystem.VIDEO_SENT_RATE &&
      !this.isWakeUpResponseInProgress
    ) {
      this.sendVideoFrame(base64Data, currentTime);
    }
  }

  private addVideoFrame(base64Data: string): void {
    this.videoHistory.push(base64Data);

    while (
      this.videoHistory.length > GeminiInteractionSystem.MAX_VIDEO_HISTORY_SIZE
    ) {
      this.videoHistory.shift();
    }
  }

  private sendVideoFrame(base64Data: string, currentTime: number): void {
    if (!this.isSessionValid()) return;

    this.feedbackTracking.video_last_sent = currentTime;
    this.session!.sendRealtimeInput({
      video: { data: base64Data, mimeType: "image/jpeg" },
    });
  }

  private handleAudioChunk(data: any): void {
    const pcmData = this.normalizeAudioData(data);
    if (pcmData.length === 0) return;

    const metrics = this.calculateAudioMetrics(pcmData);
    this.updateSpeechState(metrics);

    this.updateAudioHistory(pcmData);
    this.bufferAndSendAudio(pcmData);
  }

  private normalizeAudioData(data: any): Int16Array {
    if (data instanceof Int16Array) {
      return data;
    }

    const buf = Buffer.from(data);
    return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  }

  private calculateAudioMetrics(pcmData: Int16Array): AudioMetrics {
    let peakAmplitude = 0;
    let sumAmplitude = 0;
    let zeroCrossings = 0;
    let prevSample = 0;

    // frequency band energies (simplified)
    let lowFreqEnergy = 0;
    let midFreqEnergy = 0;
    let highFreqEnergy = 0;

    for (let i = 0; i < pcmData.length; i++) {
      const sample = pcmData[i] || 0;
      const amplitude = Math.abs(sample);

      peakAmplitude = Math.max(peakAmplitude, amplitude);
      sumAmplitude += amplitude;

      // zero crossing detection
      if ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0)) {
        zeroCrossings++;
      }
      prevSample = sample;

      // simple frequency band estimation based on sample index patterns
      // in a real implementation, you'd use fft here
      if (i % 4 === 0) {
        lowFreqEnergy += amplitude;
      } else if (i % 4 === 1 || i % 4 === 2) {
        midFreqEnergy += amplitude;
      } else {
        highFreqEnergy += amplitude;
      }
    }

    const meanAmplitude = sumAmplitude / pcmData.length;
    const zeroCrossingRate = zeroCrossings / pcmData.length;

    return {
      peakAmplitude,
      meanAmplitude,
      zeroCrossingRate,
      lowFreqEnergy,
      midFreqEnergy,
      highFreqEnergy,
    };
  }

  private updateSpeechState(metrics: AudioMetrics): void {
    const currentTime = Date.now();

    // debounced speech detection with frequency analysis
    if (this.isLikelySpeech(metrics)) {
      this.consecutiveSpeechFrames++;

      if (this.consecutiveSpeechFrames >= 3) {
        this.activateSpeechState(currentTime);
      }

      this.resetSpeechDebounce();
    } else {
      this.consecutiveSpeechFrames = Math.max(
        0,
        this.consecutiveSpeechFrames - 1,
      );
    }
  }

  private isLikelySpeech(metrics: AudioMetrics): boolean {
    // check energy threshold
    if (
      metrics.peakAmplitude <
      GeminiInteractionSystem.USER_SPEECH_ENERGY_THRESHOLD
    ) {
      return false;
    }

    // check zero crossing rate (speech typically has moderate zcr)
    if (
      metrics.zeroCrossingRate <
        GeminiInteractionSystem.MIN_ZERO_CROSSING_RATE ||
      metrics.zeroCrossingRate > GeminiInteractionSystem.MAX_ZERO_CROSSING_RATE
    ) {
      return false;
    }

    // check that it's not just low-frequency noise (bass, machinery)
    const totalEnergy =
      metrics.lowFreqEnergy + metrics.midFreqEnergy + metrics.highFreqEnergy;
    if (totalEnergy === 0) return false;

    const lowFreqRatio = metrics.lowFreqEnergy / totalEnergy;
    if (lowFreqRatio > 0.7) {
      // too much low-frequency energy - likely bass/machinery
      return false;
    }

    return true;
  }

  private activateSpeechState(currentTime: number): void {
    this.isUserSpeaking = true;
    this.feedbackTracking.user_last_spoke = currentTime;

    if (!this.isSilentDisconnected) {
      this.isSilentDisconnected = false;
    }

    this.scheduleGeminiSilenceCallback();
  }

  private resetSpeechDebounce(): void {
    if (this.speechDebounceTimeout) {
      clearTimeout(this.speechDebounceTimeout);
    }

    this.speechDebounceTimeout = setTimeout(() => {
      this.speechDebounceTimeout = null;
      this.consecutiveSpeechFrames = 0;
    }, GeminiInteractionSystem.SPEECH_DEBOUNCE_MS);
  }

  private updateAudioHistory(pcmData: Int16Array): void {
    // circular buffer approach to avoid frequent allocations
    const totalLength = this.audioHistory.length + pcmData.length;

    if (totalLength > GeminiInteractionSystem.MAX_AUDIO_HISTORY_SIZE) {
      // shift existing data and add new data
      const keepLength =
        GeminiInteractionSystem.MAX_AUDIO_HISTORY_SIZE - pcmData.length;
      const newHistory = new Int16Array(
        GeminiInteractionSystem.MAX_AUDIO_HISTORY_SIZE,
      );

      if (keepLength > 0) {
        newHistory.set(
          this.audioHistory.slice(this.audioHistory.length - keepLength),
          0,
        );
      }

      newHistory.set(pcmData, keepLength);
      this.audioHistory = newHistory;
    } else {
      const newHistory = new Int16Array(totalLength);
      newHistory.set(this.audioHistory);
      newHistory.set(pcmData, this.audioHistory.length);
      this.audioHistory = newHistory;
    }
  }

  private bufferAndSendAudio(pcmData: Int16Array): void {
    const newBuffer = new Int16Array(this.audioBuffer.length + pcmData.length);
    newBuffer.set(this.audioBuffer);
    newBuffer.set(pcmData, this.audioBuffer.length);
    this.audioBuffer = newBuffer;

    const currentTime = Date.now();
    if (
      currentTime - this.feedbackTracking.audio_last_sent >
        GeminiInteractionSystem.AUDIO_SENT_RATE &&
      !this.isWakeUpResponseInProgress
    ) {
      this.sendBufferedAudio(currentTime);
    }
  }

  private sendBufferedAudio(currentTime: number): void {
    if (!this.isSessionValid() || this.audioBuffer.length === 0) {
      this.audioBuffer = new Int16Array(0);
      return;
    }

    try {
      const base64Audio = Buffer.from(
        this.audioBuffer.buffer,
        this.audioBuffer.byteOffset,
        this.audioBuffer.byteLength,
      ).toString("base64");

      this.feedbackTracking.audio_last_sent = currentTime;
      this.session!.sendRealtimeInput({
        audio: { data: base64Audio, mimeType: "audio/pcm;rate=16000" },
      });

      this.audioBuffer = new Int16Array(0);
    } catch (error) {
      console.error("Error sending audio:", error);
      // keep the buffer for retry instead of losing it
    }
  }

  public async getVideoHistoryAsBase64(): Promise<string | null> {
    if (this.videoHistory.length === 0) return null;

    const tempDir = await mkdtemp(join(tmpdir(), "video-history-"));
    const outputFilePath = join(tempDir, "output.mp4");

    try {
      // write frames as jpeg files
      for (let i = 0; i < this.videoHistory.length; i++) {
        const frameData = this.videoHistory[i];
        if (!frameData) continue;

        const framePath = join(
          tempDir,
          `frame_${String(i).padStart(3, "0")}.jpg`,
        );
        await writeFile(framePath, Buffer.from(frameData, "base64"));
      }

      // use ffmpeg to create mp4
      await this.createVideoFromFrames(tempDir, outputFilePath);

      // read the output and convert to base64
      const videoBuffer = await readFile(outputFilePath);
      return videoBuffer.toString("base64");
    } catch (error) {
      console.error("Error creating video from frames:", error);
      return null;
    } finally {
      // cleanup
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Error cleaning up temp directory:", cleanupError);
      }
    }
  }

  private createVideoFromFrames(
    tempDir: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath || typeof ffmpegPath !== "string") {
        return reject(new Error("ffmpeg-static path not found"));
      }

      const ffmpeg = spawn(ffmpegPath, [
        "-framerate",
        GeminiInteractionSystem.VIDEO_FPS.toString(),
        "-i",
        join(tempDir, "frame_%03d.jpg"),
        "-c:v",
        "libx264",
        "-crf",
        "35",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        outputPath,
      ]);

      let stderr = "";
      ffmpeg.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        }
      });

      ffmpeg.on("error", (error: Error) => {
        reject(error);
      });
    });
  }

  public getAudioHistoryAsBase64(): string | null {
    if (this.audioHistory.length === 0) return null;

    const combined = Buffer.from(
      this.audioHistory.buffer,
      this.audioHistory.byteOffset,
      this.audioHistory.byteLength,
    );
    return combined.toString("base64");
  }

  public async getAudioHistoryAsWavBase64(): Promise<string | null> {
    if (this.audioHistory.length === 0) return null;

    const combined = Buffer.from(
      this.audioHistory.buffer,
      this.audioHistory.byteOffset,
      this.audioHistory.byteLength,
    );

    // create a proper wav header
    const pcmBuffer = this.createWavBuffer(combined);

    const tempDir = await mkdtemp(join(tmpdir(), "audio-history-"));
    const pcmPath = join(tempDir, "input.pcm");
    const wavPath = join(tempDir, "output.wav");

    try {
      await writeFile(pcmPath, pcmBuffer);

      await this.processAudioWithFfmpeg(pcmPath, wavPath);

      const wavBuffer = await readFile(wavPath);
      return wavBuffer.toString("base64");
    } catch (error) {
      console.error("Error creating WAV file:", error);
      return null;
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Error cleaning up audio temp directory:", cleanupError);
      }
    }
  }

  private createWavBuffer(pcmData: Buffer): Buffer {
    const sampleRate = GeminiInteractionSystem.AUDIO_SAMPLE_RATE;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;

    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + pcmData.length, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([wavHeader, pcmData]);
  }

  private processAudioWithFfmpeg(
    pcmPath: string,
    wavPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath || typeof ffmpegPath !== "string") {
        return reject(new Error("ffmpeg-static path not found"));
      }

      const ffmpeg = spawn(ffmpegPath, [
        "-f",
        "s16le",
        "-ar",
        GeminiInteractionSystem.AUDIO_SAMPLE_RATE.toString(),
        "-ac",
        "1",
        "-i",
        pcmPath,
        "-af",
        "highpass=f=80, lowpass=f=12000, afftdn=nf=-30:nr=12, equalizer=f=1000:t=h:width=200:g=2,equalizer=f=3000:t=h:width=400:g=3, dynaudnorm=f=150:g=25:p=0.90:m=5, alimiter=limit=0.95:level=1:attack=5:release=50",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-y",
        wavPath,
      ]);

      let stderr = "";
      ffmpeg.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `ffmpeg audio processing exited with code ${code}: ${stderr}`,
            ),
          );
        }
      });

      ffmpeg.on("error", (error: Error) => {
        reject(error);
      });
    });
  }

  private emitArOverlay(payload: ArOverlayPayload): void {
    this.socket.emit("tool-call", {
      name: "ar_overlay",
      args: payload,
    });
  }

  private clearArOverlay(): void {
    this.socket.emit("tool-call", {
      name: "clear_ar_overlay",
      args: {},
    });
  }

  private initializeTools(): void {
    this.registerMemoryTool();
    this.registerShowVisualTool();
    this.registerStartArTeachingTool();
    this.registerUpdateArOverlayTool();
    this.registerStartScavengerHuntTool();
    this.registerCelebrateHuntSuccessTool();
    this.registerEndCoplayModeTool();
    this.registerPlaceGeneratedArObjectTool();
  }

  private registerMemoryTool(): void {
    this.tools.register(
      "add_memory",
      "adds a memory that can be recalled in the future",
      {
        memory: {
          type: Type.STRING,
          description: "The memory to be remembered.",
        },
      },
      (memory: string) => {
        console.log("add_memory called with memory:", memory);
        return { remembered: true };
      },
    );
  }

  private registerShowVisualTool(): void {
    this.tools.register(
      "show_visual",
      "Shows the child an image or video when they ask about or mention something visual, like a place, animal, object, or concept. Use this to bring their curiosity to life with a picture or a short video.",
      {
        query: {
          type: Type.STRING,
          description:
            "A short search query for the visual, e.g. 'Eiffel Tower', 'dinosaur', 'solar system'",
        },
        type: {
          type: Type.STRING,
          description: "The type of media to show: 'image' or 'video'",
        },
      },
      async (args: { query: string; type: string }) => {
        console.log(
          `show_visual called: query="${args.query}", type="${args.type}"`,
        );
        return await this.fetchAndEmitMedia(args.query, args.type);
      },
    );
  }

  private registerStartArTeachingTool(): void {
    this.tools.register(
      "start_ar_teaching",
      "Starts a grounded AR teaching moment for an object the child is showing, like a flower, machine, animal, shape, or toy.",
      {
        objectType: {
          type: Type.STRING,
          description:
            "The object category, such as flower, machine, animal, car, or star.",
        },
        focus: {
          type: Type.STRING,
          description:
            "A short teaching focus, such as count petals, name colors, or find the wheels.",
        },
        prompt: {
          type: Type.STRING,
          description: "A very short next instruction for the child.",
        },
      },
      async (args: { objectType: string; focus: string; prompt: string }) => {
        const objectType = args.objectType.trim();
        const focus = args.focus.trim();
        const prompt = args.prompt.trim();
        const items = this.buildTeachingItems(objectType, focus);

        await this.withStateLock(async () => {
          this.coPlayState = {
            mode: "teaching",
            objectType,
            focus,
            prompt,
          };
          await this.persistCoPlayState();
        });

        this.recordActivity(
          "teaching_started",
          `AR Teaching: ${objectType}`,
          focus || prompt,
        );

        this.emitArOverlay({
          mode: "teaching",
          badge: "AR Teaching",
          title: `Let's learn about the ${objectType}`,
          subtitle: focus,
          prompt,
          accent: this.pickAccent(objectType),
          items,
        });

        return {
          success: true,
          state: this.coPlayState,
          items,
        };
      },
    );
  }

  private registerUpdateArOverlayTool(): void {
    this.tools.register(
      "update_ar_overlay",
      "Updates the active AR overlay with a new title, prompt, labels, or teaching step.",
      {
        mode: {
          type: Type.STRING,
          description: "Overlay mode: teaching, hunt, or success.",
        },
        title: {
          type: Type.STRING,
          description: "Short overlay title.",
        },
        subtitle: {
          type: Type.STRING,
          description: "Short helper text.",
        },
        prompt: {
          type: Type.STRING,
          description: "Short next instruction.",
        },
        items: {
          type: Type.STRING,
          description: "Comma-separated overlay labels or hints.",
        },
      },
      async (args: {
        mode: string;
        title: string;
        subtitle: string;
        prompt: string;
        items: string;
      }) => {
        const items = args.items
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

        this.emitArOverlay({
          mode: this.normalizeOverlayMode(args.mode),
          badge: this.modeBadge(this.normalizeOverlayMode(args.mode)),
          title: args.title.trim(),
          subtitle: args.subtitle.trim(),
          prompt: args.prompt.trim(),
          items,
          accent: this.pickAccent(
            this.coPlayState.objectType ||
              this.coPlayState.targetValue ||
              args.title,
          ),
        });

        return {
          success: true,
          items,
        };
      },
    );
  }

  private registerStartScavengerHuntTool(): void {
    this.tools.register(
      "start_scavenger_hunt",
      "Starts a short scavenger hunt, such as finding a color, flower, machine, or other easy object in view.",
      {
        targetType: {
          type: Type.STRING,
          description:
            "What kind of thing the child should find, such as color, shape, or object.",
        },
        targetValue: {
          type: Type.STRING,
          description:
            "The specific target, such as red, flower, circle, or machine.",
        },
        prompt: {
          type: Type.STRING,
          description: "Short spoken hunt instruction.",
        },
      },
      async (args: {
        targetType: string;
        targetValue: string;
        prompt: string;
      }) => {
        const targetType = args.targetType.trim();
        const targetValue = args.targetValue.trim();
        const prompt = args.prompt.trim();

        await this.withStateLock(async () => {
          this.coPlayState = {
            mode: "scavenger_hunt",
            targetType,
            targetValue,
            prompt,
          };
          await this.persistCoPlayState();
        });

        this.recordActivity(
          "hunt_started",
          `Scavenger Hunt: ${targetValue}`,
          prompt || targetType,
        );

        this.emitArOverlay({
          mode: "hunt",
          badge: "Scavenger Hunt",
          title: `Find ${this.withIndefiniteArticle(targetValue)}`,
          ...(targetType ? { subtitle: `Looking for a ${targetType}` } : {}),
          prompt,
          accent: this.pickAccent(targetValue),
          items: this.buildHuntHints(targetType, targetValue),
        });

        return {
          success: true,
          state: this.coPlayState,
        };
      },
    );
  }

  private registerCelebrateHuntSuccessTool(): void {
    this.tools.register(
      "celebrate_hunt_success",
      "Celebrates when the child finds the scavenger hunt target or completes an AR task.",
      {
        title: {
          type: Type.STRING,
          description: "Short success title.",
        },
        prompt: {
          type: Type.STRING,
          description: "Short follow-up or praise.",
        },
      },
      async (args: { title: string; prompt: string }) => {
        const title = args.title.trim() || "You found it!";
        const prompt = args.prompt.trim();

        this.recordActivity(
          "hunt_success",
          title,
          prompt || "Completed co-play step",
        );

        this.emitArOverlay({
          mode: "success",
          badge: "Great Job",
          title,
          prompt,
          accent: "#ffd166",
          celebration: true,
          items: ["sparkles", "stars", "success"],
        });

        return { success: true };
      },
    );
  }

  private registerEndCoplayModeTool(): void {
    this.tools.register(
      "end_coplay_mode",
      "Ends the current AR teaching or scavenger hunt activity and clears the overlay.",
      {
        summary: {
          type: Type.STRING,
          description: "A short reason or wrap-up for ending the activity.",
        },
      },
      async (args: { summary: string }) => {
        const summary = args.summary.trim();

        if (this.coPlayState.mode !== "idle") {
          this.recordActivity(
            "coplay_ended",
            `Ended ${this.coPlayState.mode}`,
            summary || "Activity completed",
          );
        }

        await this.withStateLock(async () => {
          this.coPlayState = { mode: "idle" };
          await this.persistCoPlayState();
        });

        this.clearArOverlay();
        return { success: true };
      },
    );
  }

  private registerPlaceGeneratedArObjectTool(): void {
    this.tools.register(
      "place_generated_ar_object",
      "Creates a generated character or object, like a dinosaur, and places it approximately on a real surface in view such as a table or desk.",
      {
        objectName: {
          type: Type.STRING,
          description:
            "The magical object to generate, such as dinosaur, robot, dragon, or rocket.",
        },
        anchorTarget: {
          type: Type.STRING,
          description:
            "The real surface to place it on, such as table, desk, floor, or wall.",
        },
        prompt: {
          type: Type.STRING,
          description: "Optional short line to show in the AR card.",
        },
      },
      async (args: {
        objectName: string;
        anchorTarget: string;
        prompt?: string;
      }) => {
        const objectName = args.objectName.trim();
        const anchorTarget = args.anchorTarget.trim();
        const prompt = args.prompt?.trim();

        const anchorBox = await this.detectAnchorBox(anchorTarget);
        if (!anchorBox) {
          return {
            success: false,
            reason: `Could not locate a suitable ${anchorTarget} surface.`,
          };
        }

        const imageDataUrl = await this.getOrGenerateSprite(objectName);
        const accent = this.pickAccent(objectName);

        this.activeGeneratedArObject = {
          objectName,
          anchorTarget,
          imageDataUrl,
          prompt,
          accent,
        };

        this.emitGeneratedArObject({
          objectName,
          anchorTarget,
          imageDataUrl,
          anchorBox,
          title: `A ${objectName} on your ${anchorTarget}`,
          ...(prompt ? { prompt } : {}),
          accent,
        });

        return { success: true };
      },
    );
  }

  private async fetchAndEmitMedia(
    query: string,
    type: string,
  ): Promise<{ success: boolean; mediaType?: string; title?: string }> {
    if (type === "video") {
      const result = await this.mediaSearch.searchVideo(query);
      if (!result?.videoId) return { success: false };

      const args = {
        type: "video",
        videoId: result.videoId,
        title: result.title,
        thumbnail: result.thumbnail,
      };

      this.socket.emit("tool-call", {
        name: "show_visual",
        args,
      });

      return { success: true, mediaType: "video", title: result.title };
    } else {
      const result = await this.mediaSearch.searchImage(query);
      if (!result?.url) return { success: false };

      const args = {
        type: "image",
        url: result.url,
        title: result.title,
        source: result.source,
      };

      this.socket.emit("tool-call", {
        name: "show_visual",
        args,
      });

      return { success: true, mediaType: "image", title: result.title };
    }
  }

  private buildTeachingItems(objectType: string, focus: string): string[] {
    const haystack = `${objectType} ${focus}`.toLowerCase();
    const items: string[] = [];

    if (haystack.includes("count")) items.push("count", "how many");
    if (haystack.includes("color")) items.push("colors", "name them");
    if (haystack.includes("petal")) items.push("petals", "count petals");
    if (haystack.includes("wheel")) items.push("wheels", "find wheels");
    if (haystack.includes("shape")) items.push("shapes", "find shapes");
    if (items.length === 0) items.push("look closely", "explore");

    return items;
  }

  private buildHuntHints(targetType: string, targetValue: string): string[] {
    const t = `${targetType} ${targetValue}`.toLowerCase();
    if (t.includes("color")) return ["find the color", "point to it"];
    if (t.includes("shape")) return ["find the shape", "trace it"];
    return ["search around you", "look carefully"];
  }

  private normalizeOverlayMode(mode: string): string {
    const m = mode.toLowerCase();
    if (m === "teach" || m === "teaching") return "teaching";
    if (m === "hunt" || m === "find") return "hunt";
    if (m === "success" || m === "done") return "success";
    return m;
  }

  private modeBadge(mode: string): string {
    const badges: Record<string, string> = {
      teaching: "AR Teaching",
      hunt: "Scavenger Hunt",
      success: "Great Job",
    };
    return badges[mode] || "Activity";
  }

  private pickAccent(value?: string): string {
    const accents: Record<string, string> = {
      dinosaur: "#ff6b6b",
      flower: "#51cf66",
      robot: "#74c0fc",
      rocket: "#ffa94d",
      dragon: "#ff8787",
      star: "#ffd43b",
      teaching: "#69db7c",
      hunt: "#4dabf7",
      success: "#ffd166",
    };
    return accents[value?.toLowerCase() || ""] || "#a9e34b";
  }

  private withIndefiniteArticle(value: string): string {
    const trimmed = value.trim();
    if (/^[aeiou]/i.test(trimmed)) return `an ${trimmed}`;
    return `a ${trimmed}`;
  }

  private recordActivity(type: string, title: string, detail: string): void {
    this.sessionActivities.push({
      type,
      title,
      detail,
      timestamp: Date.now(),
    });
    this.persistSessionActivities();
  }

  private async persistSessionActivities(): Promise<void> {
    try {
      await this.sessionRef.update({
        activities: this.sessionActivities.slice(-50),
      });
    } catch (error) {
      console.error("Failed to persist activities:", error);
    }
  }

  private emitGeneratedArStatus(message: string): void {
    this.socket.emit("tool-call", {
      name: "generated_ar_status",
      args: { message },
    });
  }

  private emitGeneratedArObject(args: {
    objectName: string;
    anchorTarget: string;
    imageDataUrl: string;
    anchorBox: AnchorBox;
    title: string;
    prompt?: string;
    accent: string;
  }): void {
    this.socket.emit("tool-call", {
      name: "generated_ar_object",
      args,
    });
  }

  private async refreshGeneratedArAnchor(): Promise<void> {
    if (!this.activeGeneratedArObject) return;

    const anchorBox = await this.detectAnchorBox(
      this.activeGeneratedArObject.anchorTarget,
    );
    if (!anchorBox) return;

    this.emitGeneratedArObject({
      objectName: this.activeGeneratedArObject.objectName,
      anchorTarget: this.activeGeneratedArObject.anchorTarget,
      imageDataUrl: this.activeGeneratedArObject.imageDataUrl,
      anchorBox,
      title: `A ${this.activeGeneratedArObject.objectName} on your ${this.activeGeneratedArObject.anchorTarget}`,
      ...(this.activeGeneratedArObject.prompt
        ? { prompt: this.activeGeneratedArObject.prompt }
        : {}),
      accent: this.activeGeneratedArObject.accent,
    });
  }

  private async detectAnchorBox(
    anchorTarget: string,
  ): Promise<AnchorBox | null> {
    if (!this.latestFrameBase64) return null;

    try {
      const response = await this.AI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            text: `Find the best bounding box for the visible ${anchorTarget} where a small toy-sized object could sit.

Return JSON with:
- found: boolean
- x1, y1, x2, y2 as integers normalized from 0 to 1000

Rules:
- Focus on the most obvious visible ${anchorTarget}.
- If the ${anchorTarget} is a table or desk, prefer the top surface area.

Only return the JSON object.`,
          },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: this.latestFrameBase64,
            },
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              found: { type: Type.BOOLEAN },
              x1: { type: Type.INTEGER },
              y1: { type: Type.INTEGER },
              x2: { type: Type.INTEGER },
              y2: { type: Type.INTEGER },
            },
            required: ["found", "x1", "y1", "x2", "y2"],
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      if (!parsed.found) return null;

      return this.normalizeAnchorBox({
        x1: parsed.x1,
        y1: parsed.y1,
        x2: parsed.x2,
        y2: parsed.y2,
      });
    } catch (error) {
      console.error("Error detecting anchor box:", error);
      return this.fallbackAnchorBox(anchorTarget);
    }
  }

  private fallbackAnchorBox(anchorTarget: string): AnchorBox {
    const normalizedTarget = anchorTarget.toLowerCase();
    let x1 = 200,
      y1 = 400,
      x2 = 800,
      y2 = 900;

    if (normalizedTarget.includes("floor")) {
      y1 = 600;
      y2 = 950;
    } else if (normalizedTarget.includes("wall")) {
      y1 = 100;
      y2 = 600;
    } else if (
      normalizedTarget.includes("table") ||
      normalizedTarget.includes("desk")
    ) {
      y1 = 300;
      y2 = 700;
    }

    return this.normalizeAnchorBox({ x1, y1, x2, y2 });
  }

  private normalizeAnchorBox(box: AnchorBox): AnchorBox {
    return {
      x1: Math.max(0, Math.min(1000, box.x1)),
      y1: Math.max(0, Math.min(1000, box.y1)),
      x2: Math.max(0, Math.min(1000, box.x2)),
      y2: Math.max(0, Math.min(1000, box.y2)),
    };
  }

  private async getOrGenerateSprite(objectName: string) {
    const cacheKey = objectName.toLowerCase();
    const cached = this.generatedSpriteCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.AI.models.generateImages({
      model: "imagen-3.0-generate-001",
      prompt: `Create a cute, friendly, children's-book style ${objectName} sticker.
Full body.
Centered.
Pure white background.
No scenery.
No frame.
No text.
No shadow.
Bright colors.
Appealing for ages 2 to 6.`,
      config: {
        numberOfImages: 1,
      },
    });

    const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
    if (!imageBytes) {
      throw new Error(`No generated image returned for ${objectName}`);
    }

    const dataUrl = `data:image/png;base64,${imageBytes}`;
    this.generatedSpriteCache.set(cacheKey, dataUrl);
    return dataUrl;
  }

  private async generateSummary(): Promise<void> {
    if (this.sessionMessages.length === 0) return;

    try {
      console.log("Generating session summary...");
      const transcript = this.sessionMessages
        .map((m) => `${m.role}: ${m.text}`)
        .join("\n");

      const response = await this.AI.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: `Summarize the following conversation between a child (user) and an AI companion (model). Keep it to 2-3 sentences. Focus on what the child was interested in or learning about. If helpful, mention the short AR or co-play activities Janus guided.

Activities:
${this.sessionActivities.map((activity) => `- ${activity.title}: ${activity.detail}`).join("\n") || "- None"}

Transcript:
${transcript}`,
      });

      const summary = response.text || "No summary available.";

      await this.sessionRef.update({
        endedAt: Date.now(),
        summary: summary,
        activities: this.sessionActivities,
        coPlayState: this.coPlayState,
      });

      console.log("Session summary saved.");
    } catch (error) {
      console.error("Error generating or saving summary:", error);
    }
  }
}
