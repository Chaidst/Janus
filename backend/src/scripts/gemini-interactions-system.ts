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
  PersonGeneration,
  SafetyFilterLevel,
} from "@google/genai";
import { MediaSearchService } from "./media-search-service.js";
import { db } from "./firebase.js";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import { mkdtemp, writeFile, readFile, rm, copyFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { tmpdir } from "os";

// system prompts for the gemini model
const SYSTEM_PROMPTS = {
  LIVE_BASE: `You are a warm, gentle, and encouraging learning companion for little ones aged 2 to 6. You interact through real-time audio and video, meaning you share their world, see what they see, and chat with them just like a supportive, friendly playmate.
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

5. Safety first: Above all else, let the child's safety, happiness, and current developmental stage guide every single thing you do.`,

  COPLAY_GUIDANCE: `
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
* Do not stack many activities at once. Finish or end the current one first.`,

  GENERATED_AR_GUIDANCE: `
### Generated AR Objects
* If the child asks you to show a creature or object on a real surface, like "show me a dinosaur on my table", use the generated AR object tool.
* Use generated AR objects for magical demo moments: dinosaurs on tables, stars on a pillow, a tiny robot on a desk.
* Prefer clear flat anchors like table, desk, floor, book, or wall.
* If the child changes subjects, remove the generated AR object.`,
};

/**
 * helper class for general gemini interactions
 */
class GeminiHelper {
  private static readonly HELPER_MODEL = "gemini-2.5-flash-lite";
  private AI: GoogleGenAI;

  constructor(AI: GoogleGenAI) {
    this.AI = AI;
  }

  /**
   * asks a simple true/false question with optional inline data
   */
  public async askTrueFalseQuestion(
    question: string,
    inlineData: object | null = null,
  ): Promise<GenerateContentResponse> {
    const prePrompt = `You are an objective evaluator tasked with answering a True/False question.
You must make a definitive decision (true or false) based on logical reasoning, facts, and your best available knowledge.
Even if the topic is highly nuanced or debated, weigh the evidence and commit to the most accurate boolean outcome.
Provide a concise explanation justifying how you arrived at your conclusion.
If provided with a video clip to help answer the question, understand the clip consists of frames taken at 1-second intervals.
You might also be provided with an audio clip to help answer the question.
Statement/Question to evaluate:`;

    const generationParameters: GenerateContentParameters = {
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

    const parts: any[] = [{ text: `${prePrompt} ${question}` }];
    if (inlineData !== null) {
      parts.push({ inlineData });
    }

    generationParameters.contents = [{ role: "user", parts }];
    const response = await this.AI.models.generateContent(generationParameters);
    console.log("Response:", response.text);
    return response;
  }

  /**
   * analyzes a short video clip and returns a narrative description
   */
  public async analyzeVideoHistory(
    videoData: object,
  ): Promise<GenerateContentResponse> {
    const prompt =
      "You are an AI companion for a child. Analyze this short video clip (approximately 5 seconds) of the child's recent activity. " +
      "The clip consists of frames taken at 1-second intervals. " +
      "Please provide a narrative description of what is happening in the sequence. " +
      "Avoid meta-commentary about the images being screenshots or static; instead, interpret them as a continuous event. " +
      "Describe the child's actions, their emotional state, and any interesting objects or changes in the scene.";

    const generationParameters: GenerateContentParameters = {
      model: GeminiHelper.HELPER_MODEL,
      contents: [],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: {
              type: Type.STRING,
              description: "a detailed description of the video content.",
            },
            detectedActivity: {
              type: Type.STRING,
              description: "a short label for the primary activity detected.",
            },
            emotionalTone: {
              type: Type.STRING,
              description: "the perceived emotional tone of the scene.",
            },
          },
          required: ["description", "detectedActivity", "emotionalTone"],
        },
      },
    };

    generationParameters.contents = [
      {
        role: "user",
        parts: [{ text: prompt }, { inlineData: videoData }],
      },
    ];

    const response = await this.AI.models.generateContent(generationParameters);
    console.log("Video Analysis Response:", response.text);
    return response;
  }
}

// type definitions for the system
interface ToolData {
  handler: Function;
  description: string;
  schema: Schema;
}

type CoPlayMode = "idle" | "teaching" | "scavenger_hunt";

interface CoPlayState {
  mode: CoPlayMode;
  objectType?: string;
  focus?: string;
  targetType?: string;
  targetValue?: string;
  prompt?: string;
}

interface SessionActivity {
  type: string;
  title: string;
  detail: string;
  timestamp: number;
}

interface ArOverlayPayload {
  mode: "teaching" | "hunt" | "success";
  badge: string;
  title: string;
  subtitle?: string;
  prompt?: string;
  accent?: string;
  items?: string[];
  celebration?: boolean;
}

interface AnchorBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface GeneratedArObjectState {
  objectName: string;
  anchorTarget: string;
  imageDataUrl: string;
  prompt?: string;
  accent: string;
}

/**
 * manages registration and schema generation for tools
 */
class Tools {
  private tools: Record<string, ToolData> = {};

  constructor(
    private AI: GoogleGenAI,
    private userSocket: Socket,
  ) {}

  /**
   * registers a new tool with a name, description, schema, and handler
   */
  public register(
    name: string,
    description: string,
    properties: Record<string, Schema>,
    handler: Function,
  ) {
    this.tools[name] = { handler, description, schema: properties as Schema };
  }

  /**
   * returns the tools schema for the gemini api
   */
  public getToolsSchema() {
    const declarations = Object.entries(this.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: tool.schema as Record<string, Schema>,
        required: Object.keys(tool.schema),
      },
    }));

    if (declarations.length === 0) return [];
    return [{ functionDeclarations: declarations }];
  }

  /**
   * gets a tool by its name
   */
  public get(name: string): ToolData | undefined {
    return this.tools[name];
  }
}

// the analogy I like is we're giving Gemini a driver seat, and teaching it how to drive.
// Gemini will obviously make mistakes driving the vehicle from time-to-time, so it's up to us
// (the developers) to build a safe vehicle, potentially with some nice self driving.
export class GeminiInteractionSystem {
  private static readonly LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
  private static readonly LIVE_VOICE_NAME = "Aoede";
  private AI: GoogleGenAI;
  private socket: Socket;
  private session: Session | null = null;
  private tools: Tools;
  private helper: GeminiHelper;
  private mediaSearch: MediaSearchService;
  private audioBuffer: Int16Array = new Int16Array(0);
  private readonly keyType: "studio" | "vertex";

  private sessionId: string;
  private sessionMessages: {
    role: "user" | "model";
    text: string;
    timestamp: number;
  }[] = [];
  private sessionRef: FirebaseFirestore.DocumentReference;
  private coPlayState: CoPlayState = { mode: "idle" };
  private sessionActivities: SessionActivity[] = [];
  private latestFrameBase64: string | null = null;
  private activeGeneratedArObject: GeneratedArObjectState | null = null;
  private generatedSpriteCache = new Map<string, string>();

  private static readonly VIDEO_SENT_RATE = 1000;
  private static readonly AUDIO_SENT_RATE = 40;

  private static readonly AUDIO_VIDEO_HISTORY_DURATION_MS = 30000;
  private static readonly AUDIO_SAMPLE_RATE = 16000;
  private static readonly MAX_AUDIO_HISTORY_SIZE =
    (GeminiInteractionSystem.AUDIO_VIDEO_HISTORY_DURATION_MS / 1000) *
    GeminiInteractionSystem.AUDIO_SAMPLE_RATE;
  private static readonly VIDEO_FPS = 1;
  private static readonly MAX_VIDEO_HISTORY_SIZE =
    (GeminiInteractionSystem.AUDIO_VIDEO_HISTORY_DURATION_MS / 1000) *
    GeminiInteractionSystem.VIDEO_FPS;

  private videoHistory: string[] = [];
  private audioHistory: Int16Array = new Int16Array(0);

  private feedbackTracking = {
    videoLastSent: Date.now(),
    audioLastSent: Date.now(),
    geminiLastSpoke: Date.now(),
    geminiLastAnalyzedAudioVideo: Date.now(),
    videoHistoryLastUpdated: 0,
  };

  constructor(
    apiKey: string,
    userSocket: Socket,
    keyType: "studio" | "vertex" = "studio",
  ) {
    this.keyType = keyType;
    this.socket = userSocket;

    // initialize core services
    this.AI = this.initializeAI(apiKey);
    this.tools = new Tools(this.AI, userSocket);
    this.helper = new GeminiHelper(this.AI);
    this.mediaSearch = new MediaSearchService();

    // initialize session state
    this.sessionId = Date.now().toString();
    this.sessionRef = db
      .collection("families")
      .doc("default")
      .collection("children")
      .doc("default")
      .collection("sessions")
      .doc(this.sessionId);
    this.initializeSessionMetadata();

    // setup tools and connect
    this.initializeTools();
    this.connectToGemini();
  }

  /**
   * initializes the gemini ai client based on the key type
   */
  private initializeAI(apiKey: string): GoogleGenAI {
    if (this.keyType === "studio") {
      return new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
    } else {
      const project = process.env.GOOGLE_CLOUD_PROJECT || "norse-ego-479919-v2";
      const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

      return new GoogleGenAI({
        vertexai: true,
        project,
        location,
      });
    }
  }

  /**
   * initializes session metadata in firestore
   */
  private initializeSessionMetadata() {
    this.sessionRef
      .set({
        startedAt: Date.now(),
        summary: "",
        messages: [],
        activities: [],
        coPlayState: this.coPlayState,
      })
      .catch((err) =>
        console.error("error initializing session metadata:", err),
      );
  }

  /**
   * connects to the gemini live api and sets up callbacks
   */
  private connectToGemini() {
    this.AI.live
      .connect({
        model: GeminiInteractionSystem.LIVE_MODEL,
        callbacks: {
          onopen: () => console.log("connected to gemini live api"),
          onclose: () => {
            this.session?.close();
            this.shutdownSockets();
          },
          onmessage: (message) => this.handleGeminiMessage(message),
          onerror: (error) => {
            console.error("gemini live connection error:", error);
            this.session?.close();
            this.shutdownSockets();
          },
        },
        config: {
          systemInstruction: `${SYSTEM_PROMPTS.LIVE_BASE}\n${SYSTEM_PROMPTS.COPLAY_GUIDANCE}\n${SYSTEM_PROMPTS.GENERATED_AR_GUIDANCE}`,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: GeminiInteractionSystem.LIVE_VOICE_NAME,
              },
            },
          },
          enableAffectiveDialog: true,
          tools: this.tools?.getToolsSchema() || [],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: 20,
              silenceDurationMs: 100,
            },
          },
        },
      })
      .then((session) => {
        this.session = session;
        this.initializeSockets();

        if (this.keyType === "vertex") {
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
      })
      .catch((error) => {
        console.error("error connecting to gemini live api:", error);
        this.shutdownSockets();
      });
  }

  /**
   * handles messages received from gemini
   */
  private handleGeminiMessage(message: any) {
    const content = message.serverContent;

    if (content?.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) {
          const audioBuffer = Buffer.from(part.inlineData.data, "base64");
          this.socket.emit("audio-out", audioBuffer);
          this.feedbackTracking.geminiLastSpoke = Date.now();
        }
      }
    }

    if (content?.interrupted) {
      this.socket.emit("interrupted");
    }

    if (content?.inputTranscription) {
      const text = content.inputTranscription.text || "";
      this.socket.emit("transcription", { type: "user", text });
      this.sessionMessages.push({ role: "user", text, timestamp: Date.now() });
      this.sessionRef
        .update({ messages: this.sessionMessages })
        .catch(console.error);
    }

    if (content?.outputTranscription) {
      const text = content.outputTranscription.text || "";
      this.socket.emit("transcription", { type: "model", text });
      this.sessionMessages.push({ role: "model", text, timestamp: Date.now() });
      this.sessionRef
        .update({ messages: this.sessionMessages })
        .catch(console.error);
      this.feedbackTracking.geminiLastSpoke = Date.now();
    }

    if (message.toolCall) {
      this.handleToolCalls(message.toolCall.functionCalls || []);
    }
  }

  private initializeSockets() {
    this.socket.on("video-frame", (data: string) => {
      this.handleVideoFrame(data);
    });

    this.socket.on("request-ar-anchor-refresh", async () => {
      await this.refreshGeneratedArAnchor();
    });

    this.socket.on("clear-generated-ar-object", () => {
      this.activeGeneratedArObject = null;
    });

    this.socket.on("audio-chunk", (data: any) => {
      this.handleAudioChunk(data);
    });

    this.socket.on("disconnect", () => {
      console.log("Client disconnected");
      this.generateSummary().finally(() => {
        this.shutdownSockets();
        this.session?.close();
      });
    });
  }

  private async generateSummary() {
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

  private shutdownSockets() {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }

  private initializeTools() {
    this.registerMemoryTools();
    this.registerVisualTools();
    this.registerCoPlayTools();
    this.registerArOverlayTools();
    this.registerGeneratedArTools();
  }

  /**
   * registers memory-related tools
   */
  private registerMemoryTools() {
    this.tools.register(
      "add_memory",
      "adds a memory that can be recalled in the future",
      {
        memory: {
          type: Type.STRING,
          description: "the memory to be remembered.",
        },
      },
      (memory: string) => {
        console.log("add_memory called with memory:", memory);
        return { remembered: true };
      },
    );
  }

  /**
   * registers visual and media-related tools
   */
  private registerVisualTools() {
    this.tools.register(
      "show_visual",
      "shows an image or video when they ask about or mention something visual, like a place, animal, object, or concept. use this to bring their curiosity to life with a picture or a short video.",
      {
        query: {
          type: Type.STRING,
          description:
            "a short search query for the visual, e.g. 'eiffel tower', 'dinosaur', 'solar system'",
        },
        type: {
          type: Type.STRING,
          description: "the type of media to show: 'image' or 'video'",
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

  /**
   * registers co-play and teaching tools
   */
  private registerCoPlayTools() {
    this.tools.register(
      "start_ar_teaching",
      "starts a grounded ar teaching moment for an object the child is showing, like a flower, machine, animal, shape, or toy.",
      {
        objectType: {
          type: Type.STRING,
          description:
            "the object category, such as flower, machine, animal, car, or star.",
        },
        focus: {
          type: Type.STRING,
          description:
            "a short teaching focus, such as count petals, name colors, or find the wheels.",
        },
        prompt: {
          type: Type.STRING,
          description: "a very short next instruction for the child.",
        },
      },
      async (args: { objectType: string; focus: string; prompt: string }) => {
        const objectType = args.objectType.trim();
        const focus = args.focus.trim();
        const prompt = args.prompt.trim();
        const items = this.buildTeachingItems(objectType, focus);

        this.coPlayState = { mode: "teaching", objectType, focus, prompt };
        this.persistSessionMetadata();
        this.recordActivity(
          "teaching_started",
          `ar teaching: ${objectType}`,
          focus || prompt,
        );

        this.emitArOverlay({
          mode: "teaching",
          badge: "ar teaching",
          title: `let's learn about the ${objectType}`,
          subtitle: focus,
          prompt,
          accent: this.pickAccent(objectType),
          items,
        });

        return { success: true, state: this.coPlayState, items };
      },
    );

    this.tools.register(
      "start_scavenger_hunt",
      "starts a short scavenger hunt, such as finding a color, flower, machine, or other easy object in view.",
      {
        targetType: {
          type: Type.STRING,
          description:
            "what kind of thing the child should find, such as color, shape, or object.",
        },
        targetValue: {
          type: Type.STRING,
          description:
            "the specific target, such as red, flower, circle, or machine.",
        },
        prompt: {
          type: Type.STRING,
          description: "short spoken hunt instruction.",
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

        this.coPlayState = {
          mode: "scavenger_hunt",
          targetType,
          targetValue,
          prompt,
        };
        this.persistSessionMetadata();
        this.recordActivity(
          "hunt_started",
          `scavenger hunt: ${targetValue}`,
          prompt || targetType,
        );

        this.emitArOverlay({
          mode: "hunt",
          badge: "scavenger hunt",
          title: `find ${this.withIndefiniteArticle(targetValue)}`,
          ...(targetType ? { subtitle: `looking for a ${targetType}` } : {}),
          prompt,
          accent: this.pickAccent(targetValue),
          items: this.buildHuntHints(targetType, targetValue),
        });

        return { success: true, state: this.coPlayState };
      },
    );

    this.tools.register(
      "get_coplay_state",
      "gets the current ar teaching or scavenger hunt state",
      {},
      () => {
        return { success: true, state: this.coPlayState };
      },
    );
  }

  /**
   * registers ar overlay management tools
   */
  private registerArOverlayTools() {
    this.tools.register(
      "update_ar_overlay",
      "updates the active ar overlay with a new title, prompt, labels, or teaching step.",
      {
        mode: {
          type: Type.STRING,
          description: "overlay mode: teaching, hunt, or success.",
        },
        title: {
          type: Type.STRING,
          description: "short overlay title.",
        },
        subtitle: {
          type: Type.STRING,
          description: "short helper text.",
        },
        prompt: {
          type: Type.STRING,
          description: "short next instruction.",
        },
        items: {
          type: Type.STRING,
          description: "comma-separated overlay labels or hints.",
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
        const mode = this.normalizeOverlayMode(args.mode);

        this.emitArOverlay({
          mode,
          badge: this.modeBadge(mode),
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

        return { success: true, items };
      },
    );

    this.tools.register(
      "celebrate_hunt_success",
      "celebrates when the child finds the scavenger hunt target or completes an ar task.",
      {
        title: {
          type: Type.STRING,
          description: "short success title.",
        },
        prompt: {
          type: Type.STRING,
          description: "short follow-up or praise.",
        },
      },
      async (args: { title: string; prompt: string }) => {
        const title = args.title.trim() || "you found it!";
        const prompt = args.prompt.trim();

        this.recordActivity(
          "hunt_success",
          title,
          prompt || "completed co-play step",
        );
        this.emitArOverlay({
          mode: "success",
          badge: "great job",
          title,
          prompt,
          accent: "#ffd166",
          celebration: true,
          items: ["sparkles", "stars", "success"],
        });

        return { success: true };
      },
    );

    this.tools.register(
      "clear_ar_overlay",
      "removes the ar overlay from the screen.",
      {},
      async () => {
        this.clearArOverlay();
        return { success: true };
      },
    );

    this.tools.register(
      "end_coplay_mode",
      "ends the current ar teaching or scavenger hunt activity and clears the overlay.",
      {
        summary: {
          type: Type.STRING,
          description: "a short reason or wrap-up for ending the activity.",
        },
      },
      async (args: { summary: string }) => {
        const summary = args.summary.trim();
        if (this.coPlayState.mode !== "idle") {
          this.recordActivity(
            "coplay_ended",
            `ended ${this.coPlayState.mode}`,
            summary || "activity completed",
          );
        }

        this.coPlayState = { mode: "idle" };
        this.persistSessionMetadata();
        this.clearArOverlay();
        return { success: true };
      },
    );
  }

  /**
   * registers generated ar object tools
   */
  private registerGeneratedArTools() {
    this.tools.register(
      "place_generated_ar_object",
      "creates a generated character or object, like a dinosaur, and places it approximately on a real surface in view such as a table or desk.",
      {
        objectName: {
          type: Type.STRING,
          description:
            "the magical object to generate, such as dinosaur, robot, dragon, or rocket.",
        },
        anchorTarget: {
          type: Type.STRING,
          description:
            "the real surface to place it on, such as table, desk, floor, or wall.",
        },
        prompt: {
          type: Type.STRING,
          description: "optional short line to show in the ar card.",
        },
      },
      async (args: {
        objectName: string;
        anchorTarget: string;
        prompt: string;
      }) => {
        const objectName = args.objectName.trim();
        const anchorTarget = args.anchorTarget.trim() || "table";
        const prompt = args.prompt.trim();

        this.emitGeneratedArStatus(
          `making ${this.withIndefiniteArticle(objectName)} for your ${anchorTarget}...`,
        );

        try {
          const anchorBox = await this.detectAnchorBox(anchorTarget);
          if (!anchorBox) {
            return {
              success: false,
              reason: `i could not find a ${anchorTarget} to place it on.`,
            };
          }

          let imageDataUrl: string;
          try {
            imageDataUrl = await this.getOrGenerateSprite(objectName);
          } catch (error) {
            console.error("failed to generate sprite:", error);
            return {
              success: false,
              reason: `i'm having a little trouble making a magic ${objectName} right now. maybe we can try something else?`,
            };
          }

          const accent = this.pickAccent(objectName);

          this.activeGeneratedArObject = {
            objectName,
            anchorTarget,
            imageDataUrl,
            prompt,
            accent,
          };
          this.recordActivity(
            "generated_ar_object",
            `magic ar: ${objectName}`,
            `placed on ${anchorTarget}`,
          );

          this.emitArOverlay({
            mode: "teaching",
            badge: "magic ar",
            title: `look, a ${objectName}!`,
            subtitle: `sitting on your ${anchorTarget}`,
            prompt: prompt || `can you see the ${objectName}?`,
            accent,
            items: [objectName, anchorTarget, "magic"],
          });

          this.emitGeneratedArObject({
            objectName,
            anchorTarget,
            imageDataUrl,
            anchorBox,
            title: `a ${objectName} on your ${anchorTarget}`,
            ...(prompt ? { prompt } : {}),
            accent,
          });

          return { success: true, objectName, anchorTarget };
        } finally {
          this.emitGeneratedArStatus("");
        }
      },
    );

    this.tools.register(
      "clear_generated_ar_object",
      "removes the currently placed generated ar creature or object from the scene.",
      {},
      async () => {
        this.activeGeneratedArObject = null;
        this.socket.emit("tool-call", {
          name: "clear_generated_ar_object",
          args: {},
        });
        return { success: true };
      },
    );
  }

  /**
   * Fetches media from Google APIs and emits the result to the frontend.
   */
  private async fetchAndEmitMedia(query: string, type: string) {
    try {
      if (type === "video") {
        const result = await this.mediaSearch.searchVideo(query);
        if (result) {
          this.socket.emit("tool-call", {
            name: "show_visual",
            args: {
              type: "video",
              videoId: result.videoId,
              title: result.title,
              thumbnail: result.thumbnail,
            },
          });
          console.log(`Sent video to client: ${result.title}`);
          return {
            success: true,
            mediaType: "video",
            title: result.title,
          };
        }
      } else {
        const result = await this.mediaSearch.searchImage(query);
        if (result) {
          this.socket.emit("tool-call", {
            name: "show_visual",
            args: {
              type: "image",
              url: result.url,
              title: result.title,
              source: result.source,
            },
          });
          console.log(`Sent image to client: ${result.title}`);
          return {
            success: true,
            mediaType: "image",
            title: result.title,
          };
        }
      }
    } catch (error) {
      console.error("Error fetching media:", error);
    }

    return { success: false };
  }

  /**
   * Executes tool calls received from Gemini and sends responses back to the session.
   */
  private async handleToolCalls(functionCalls: any[]) {
    if (!functionCalls || !this.session) return;

    const responses = [];
    for (const call of functionCalls) {
      const toolName = call.name;
      const toolArgs = call.args;
      const toolData = (this.tools as any).tools[toolName];

      if (toolData) {
        try {
          const toolResult = await toolData.handler(toolArgs);
          responses.push({
            id: call.id,
            name: toolName,
            response: toolResult ?? { success: true },
          });
        } catch (error) {
          console.error(`Error executing tool ${toolName}:`, error);
          responses.push({
            id: call.id,
            name: toolName,
            response: { success: false, error: String(error) },
          });
        }
      }
    }

    // Send tool responses back to Gemini so it can continue the conversation
    if (responses.length > 0) {
      try {
        this.session.sendToolResponse({
          functionResponses: responses,
        });
      } catch (error) {
        console.error("Error sending tool response:", error);
      }
    }
  }

  private handleVideoFrame(data: string) {
    // data is base64 string with header: data:image/jpeg;base64,...
    const base64Data = data.split(",")[1];
    if (!base64Data) return;
    this.latestFrameBase64 = base64Data;

    const currentTime = Date.now();

    // update video history (last 5 seconds at 1 fps)
    const videoHistoryUpdateRate = 1000 / GeminiInteractionSystem.VIDEO_FPS;
    if (
      !this.feedbackTracking.videoHistoryLastUpdated ||
      currentTime - this.feedbackTracking.videoHistoryLastUpdated >
        videoHistoryUpdateRate
    ) {
      this.feedbackTracking.videoHistoryLastUpdated = currentTime;
      this.videoHistory.push(base64Data);
      if (
        this.videoHistory.length >
        GeminiInteractionSystem.MAX_VIDEO_HISTORY_SIZE
      ) {
        this.videoHistory.shift();
      }
    }

    // send video frame to gemini live session
    if (
      currentTime - this.feedbackTracking.videoLastSent >
      GeminiInteractionSystem.VIDEO_SENT_RATE
    ) {
      this.feedbackTracking.videoLastSent = currentTime;
      this.session?.sendRealtimeInput({
        video: { data: base64Data, mimeType: "image/jpeg" },
      });
    }
  }

  private handleAudioChunk(data: any) {
    const pcmData =
      data instanceof Int16Array
        ? data
        : (() => {
            const buf = Buffer.from(data);
            return new Int16Array(
              buf.buffer,
              buf.byteOffset,
              buf.byteLength >> 1,
            );
          })();

    if (pcmData.length === 0) return;

    // update audio history
    const newAudioHistory = new Int16Array(
      this.audioHistory.length + pcmData.length,
    );
    newAudioHistory.set(this.audioHistory);
    newAudioHistory.set(pcmData, this.audioHistory.length);
    if (
      newAudioHistory.length > GeminiInteractionSystem.MAX_AUDIO_HISTORY_SIZE
    ) {
      this.audioHistory = newAudioHistory.slice(
        newAudioHistory.length - GeminiInteractionSystem.MAX_AUDIO_HISTORY_SIZE,
      );
    } else {
      this.audioHistory = newAudioHistory;
    }

    // buffer audio to send larger chunks
    const newBuffer = new Int16Array(this.audioBuffer.length + pcmData.length);
    newBuffer.set(this.audioBuffer);
    newBuffer.set(pcmData, this.audioBuffer.length);
    this.audioBuffer = newBuffer;

    const currentTime = Date.now();
    if (
      currentTime - this.feedbackTracking.audioLastSent >
      GeminiInteractionSystem.AUDIO_SENT_RATE
    ) {
      this.feedbackTracking.audioLastSent = currentTime;
      const base64Audio = Buffer.from(
        this.audioBuffer.buffer,
        this.audioBuffer.byteOffset,
        this.audioBuffer.byteLength,
      ).toString("base64");
      this.session?.sendRealtimeInput({
        audio: { data: base64Audio, mimeType: "audio/pcm;rate=16000" },
      });
      this.audioBuffer = new Int16Array(0);
    }
  }

  /**
   * converts the current video history (jpeg frames) into a single base64-encoded mp4 video.
   */
  public async getVideoHistoryAsBase64(): Promise<string> {
    if (this.videoHistory.length === 0) return "";

    const tempDir = await mkdtemp(join(tmpdir(), "janus-video-"));
    const outputFilePath = join(tempDir, "output.mp4");

    try {
      // write all frames to the temporary directory
      for (let i = 0; i < this.videoHistory.length; i++) {
        const frameData = this.videoHistory[i];
        if (!frameData) continue;
        const framePath = join(
          tempDir,
          `frame_${String(i).padStart(3, "0")}.jpg`,
        );
        await writeFile(framePath, Buffer.from(frameData, "base64"));
      }

      // use ffmpeg to combine frames into an mp4 at the target fps
      await new Promise<void>((resolve, reject) => {
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
          "-vf",
          "scale=iw/2:ih/2",
          "-pix_fmt",
          "yuv420p",
          "-y",
          outputFilePath,
        ]);

        ffmpeg.on("close", (code: number | null) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${code}`));
        });

        ffmpeg.on("error", (err: Error) => reject(err));
      });

      // read the generated video and encode to base64
      const videoBuffer = await readFile(outputFilePath);
      return videoBuffer.toString("base64");
    } catch (error) {
      console.error("error creating video history:", error);
      throw error;
    } finally {
      // clean up temporary directory
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("error cleaning up temporary video files:", cleanupError);
      }
    }
  }

  /**
   * emits an ar overlay payload to the frontend
   */
  private emitArOverlay(payload: ArOverlayPayload) {
    this.socket.emit("tool-call", {
      name: "ar_overlay",
      args: payload,
    });
  }

  /**
   * clears the active ar overlay on the client
   */
  private clearArOverlay() {
    this.socket.emit("tool-call", {
      name: "clear_ar_overlay",
      args: {},
    });
  }

  /**
   * builds a list of teaching items based on the object type and focus
   */
  private buildTeachingItems(objectType: string, focus: string) {
    const haystack = `${objectType} ${focus}`.toLowerCase();
    if (haystack.includes("flower")) return ["petals", "colors", "count"];
    if (
      haystack.includes("machine") ||
      haystack.includes("car") ||
      haystack.includes("truck")
    ) {
      return ["wheel", "button", "handle"];
    }
    if (haystack.includes("animal") || haystack.includes("dinosaur")) {
      return ["ears", "tail", "colors"];
    }
    return [objectType, focus].filter(Boolean);
  }

  /**
   * builds a list of hints for a scavenger hunt
   */
  private buildHuntHints(targetType: string, targetValue: string) {
    if (targetType.toLowerCase().includes("color")) {
      return ["look around", "show it to me", targetValue];
    }
    return [targetValue, "bring it close", "hold it steady"];
  }

  /**
   * normalizes the overlay mode to a valid value
   */
  private normalizeOverlayMode(value: string): ArOverlayPayload["mode"] {
    return value === "hunt" || value === "success" ? value : "teaching";
  }

  /**
   * returns a user-friendly badge text for the given mode
   */
  private modeBadge(mode: ArOverlayPayload["mode"]) {
    if (mode === "hunt") return "scavenger hunt";
    if (mode === "success") return "great job";
    return "ar teaching";
  }

  /**
   * picks a color accent based on a seed string (e.g., object name)
   */
  private pickAccent(seed: string) {
    const value = seed.toLowerCase();
    if (
      value.includes("flower") ||
      value.includes("leaf") ||
      value.includes("plant")
    )
      return "#7bd389";
    if (
      value.includes("machine") ||
      value.includes("car") ||
      value.includes("truck")
    )
      return "#7aa2ff";
    if (value.includes("star") || value.includes("sun")) return "#ffd166";
    if (value.includes("red")) return "#ff6b6b";
    if (value.includes("blue")) return "#63b3ff";
    return "#b794f4";
  }

  /**
   * adds an indefinite article (a/an) to a word
   */
  private withIndefiniteArticle(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return "something fun";
    return /^[aeiou]/i.test(trimmed) ? `an ${trimmed}` : `a ${trimmed}`;
  }

  /**
   * records a session activity and persists the session state
   */
  private recordActivity(type: string, title: string, detail: string) {
    this.sessionActivities.push({
      type,
      title,
      detail,
      timestamp: Date.now(),
    });
    this.persistSessionMetadata();
  }

  /**
   * persists session activities and state to firestore
   */
  private persistSessionMetadata() {
    this.sessionRef
      .update({
        activities: this.sessionActivities,
        coPlayState: this.coPlayState,
      })
      .catch((err) => console.error("error persisting session metadata:", err));
  }

  /**
   * emits a status message for generated ar objects
   */
  private emitGeneratedArStatus(message: string) {
    this.socket.emit("tool-call", {
      name: "generated_ar_status",
      args: { message },
    });
  }

  /**
   * emits a generated ar object payload to the frontend
   */
  private emitGeneratedArObject(args: {
    objectName: string;
    anchorTarget: string;
    imageDataUrl: string;
    anchorBox: AnchorBox;
    title: string;
    prompt?: string;
    accent: string;
  }) {
    this.socket.emit("tool-call", {
      name: "generated_ar_object",
      args,
    });
  }

  /**
   * refreshes the anchor box for the active generated ar object
   */
  private async refreshGeneratedArAnchor() {
    const activeObject = this.activeGeneratedArObject;
    if (!activeObject) return;

    const anchorBox = await this.detectAnchorBox(activeObject.anchorTarget);
    if (
      !anchorBox ||
      !this.activeGeneratedArObject ||
      this.activeGeneratedArObject !== activeObject
    )
      return;

    this.emitGeneratedArObject({
      objectName: activeObject.objectName,
      anchorTarget: activeObject.anchorTarget,
      imageDataUrl: activeObject.imageDataUrl,
      anchorBox,
      title: `a ${activeObject.objectName} on your ${activeObject.anchorTarget}`,
      ...(activeObject.prompt ? { prompt: activeObject.prompt } : {}),
      accent: activeObject.accent,
    });
  }

  /**
   * detects a suitable anchor box for ar placement using vision models
   */
  private async detectAnchorBox(
    anchorTarget: string,
  ): Promise<AnchorBox | null> {
    if (!this.latestFrameBase64) return null;

    try {
      const response = await this.AI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            text: `find the best bounding box for the visible ${anchorTarget} where a small toy-sized object could sit.

return json with:
- found: boolean
- x1, y1, x2, y2 as integers normalized from 0 to 1000

rules:
- focus on the most obvious visible ${anchorTarget}.
- if the ${anchorTarget} is a table or desk, prefer the top surface area.
- if you are uncertain but a flat surface is clearly visible, return the best likely surface.
- return only json.`,
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

      const parsed = JSON.parse(response.text || "{}") as Partial<{
        found: boolean;
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      }>;
      if (!parsed.found) return this.fallbackAnchorBox(anchorTarget);

      return this.normalizeAnchorBox({
        x1: parsed.x1 ?? 120,
        y1: parsed.y1 ?? 620,
        x2: parsed.x2 ?? 880,
        y2: parsed.y2 ?? 960,
      });
    } catch (error) {
      console.error("failed to detect anchor box:", error);
      return this.fallbackAnchorBox(anchorTarget);
    }
  }

  /**
   * returns a fallback anchor box if detection fails
   */
  private fallbackAnchorBox(anchorTarget: string): AnchorBox {
    const normalizedTarget = anchorTarget.toLowerCase();
    if (normalizedTarget.includes("wall"))
      return { x1: 230, y1: 140, x2: 770, y2: 620 };
    if (normalizedTarget.includes("floor"))
      return { x1: 120, y1: 700, x2: 880, y2: 980 };
    return { x1: 120, y1: 650, x2: 880, y2: 965 };
  }

  /**
   * ensures anchor box coordinates are within 0-1000 range
   */
  private normalizeAnchorBox(box: AnchorBox): AnchorBox {
    return {
      x1: Math.max(0, Math.min(1000, Math.round(box.x1))),
      y1: Math.max(0, Math.min(1000, Math.round(box.y1))),
      x2: Math.max(0, Math.min(1000, Math.round(box.x2))),
      y2: Math.max(0, Math.min(1000, Math.round(box.y2))),
    };
  }

  /**
   * retrieves a cached ar sprite or generates a new one using imagen
   */
  private async getOrGenerateSprite(objectName: string) {
    const cacheKey = objectName.toLowerCase();
    const cached = this.generatedSpriteCache.get(cacheKey);
    if (cached) return cached;

    const generate = async (prompt: string) => {
      return await this.AI.models.generateImages({
        model: "imagen-3.0-generate-001",
        prompt,
        config: {
          numberOfImages: 1,
          includeRaiReason: true,
          personGeneration: PersonGeneration.ALLOW_ALL,
          safetyFilterLevel: SafetyFilterLevel.BLOCK_ONLY_HIGH,
        },
      });
    };

    const basePrompt = `create a cute, friendly, children's-book style ${objectName} sticker. full body. centered. pure white background. no scenery. no frame. no text. no shadow. bright colors. appealing for ages 2 to 6.`;
    let response = await generate(basePrompt);
    let imageBytes = response.generatedImages?.[0]?.image?.imageBytes;

    // if it failed and it's a common filtered term like doll, try a safer variant
    if (!imageBytes && cacheKey.includes("doll")) {
      console.log(
        `initial generation for ${objectName} failed, retrying with "toy" variant...`,
      );
      const retryPrompt = `create a cute, friendly, children's-book style toy ${objectName} sticker. full body. centered. pure white background. no scenery. no frame. no text. no shadow. bright colors. appealing for ages 2 to 6.`;
      response = await generate(retryPrompt);
      imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
    }

    if (!imageBytes) {
      const raiReason = response.generatedImages?.[0]?.raiFilteredReason;
      console.error(
        `no generated image returned for ${objectName}. RAI reason: ${raiReason}`,
      );
      throw new Error(
        `no generated image returned for ${objectName}${raiReason ? ` (reason: ${raiReason})` : ""}`,
      );
    }

    const dataUrl = `data:image/png;base64,${imageBytes}`;
    this.generatedSpriteCache.set(cacheKey, dataUrl);
    return dataUrl;
  }
}
