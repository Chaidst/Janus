import type { Express } from "express";
import { db } from "./firebase.js";
import { GoogleGenAI } from "@google/genai";

function createAiClient() {
  const useVertex =
    process.env.USE_VERTEX === "1" ||
    process.env.USE_VERTEX === "true" ||
    Boolean(process.env.K_SERVICE);

  if (useVertex) {
    const project =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_PROJECT_ID || "";
    const location =
      process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_LOCATION || "us-central1";

    if (!project) {
      throw new Error("Missing GOOGLE_CLOUD_PROJECT for Vertex AI parent chat.");
    }

    return new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  }

  return new GoogleGenAI({
    apiKey: process.env.API_KEY || "",
    httpOptions: { apiVersion: "v1alpha" },
  });
}

const AI = createAiClient();
const SESSION_VOICE_NAME = "Aoede";
const SUMMARY_AUDIO_MODEL = "gemini-2.5-flash-preview-tts";

type StoredSessionMessage = {
  role?: string;
  text?: string;
  timestamp?: number;
};

type ParentAlert = {
  id: string;
  kind: "distress" | "safety";
  title: string;
  label: string;
  summary: string;
  messageIndex: number;
  timestamp: number;
  clipDuration: string;
  clipStatus: string;
  excerpt: string;
};

function getChildDocument() {
  return db.collection("families").doc("default").collection("children").doc("default");
}

function getSessionsCollection() {
  return db
    .collection("families")
    .doc("default")
    .collection("children")
    .doc("default")
    .collection("sessions");
}

function extractInlineAudio(
  response: Awaited<ReturnType<typeof AI.models.generateContent>>,
) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const audioChunks: Buffer[] = [];
  let mimeType: string | undefined;

  for (const part of parts) {
    if (!part.inlineData?.data) {
      continue;
    }

    if (!mimeType) {
      mimeType = part.inlineData.mimeType;
    }

    audioChunks.push(Buffer.from(part.inlineData.data, "base64"));
  }

  if (audioChunks.length === 0) {
    return null;
  }

  return {
    data: Buffer.concat(audioChunks),
    mimeType,
  };
}

function parseSampleRate(mimeType?: string) {
  if (!mimeType) {
    return 24000;
  }

  const rateMatch =
    mimeType.match(/rate=(\d+)/i) ?? mimeType.match(/sample[_-]?rate=(\d+)/i);
  if (!rateMatch?.[1]) {
    return 24000;
  }

  const sampleRate = Number.parseInt(rateMatch[1], 10);
  return Number.isFinite(sampleRate) ? sampleRate : 24000;
}

function pcmToWav(audioBuffer: Buffer, sampleRate: number) {
  const channelCount = 1;
  const bitsPerSample = 16;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + audioBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(audioBuffer.length, 40);

  return Buffer.concat([header, audioBuffer]);
}

function normalizeMessages(messages: unknown): StoredSessionMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(
      (message): message is StoredSessionMessage =>
        !!message && typeof message === "object",
    )
    .map((message) => {
      const normalizedMessage: StoredSessionMessage = {
        role: typeof message.role === "string" ? message.role : "",
        text: typeof message.text === "string" ? message.text : "",
      };

      if (typeof message.timestamp === "number") {
        normalizedMessage.timestamp = message.timestamp;
      }

      return normalizedMessage;
    });
}

function deriveAlertsFromHistory(
  messages: StoredSessionMessage[],
  startedAt: number,
): ParentAlert[] {
  const alerts: ParentAlert[] = [];
  let hasDistress = false;
  let hasSafety = false;

  const safetyPattern =
    /\b(hurt me|hurt|bully|bullying|threat|threatened|unsafe|not go back|don't want to go back|scared to go back|school said|kill|weapon)\b/i;
  const distressPattern =
    /\b(sad|scared|afraid|fear|miss him|miss her|miss daddy|miss mommy|lonely|cry|upset|worried|anxious|separation)\b/i;

  messages.forEach((message, index) => {
    if (message.role !== "user" || !message.text) {
      return;
    }

    if (!hasSafety && safetyPattern.test(message.text)) {
      const matchesSchoolThreat =
        /\bschool\b/i.test(message.text) &&
        /\b(hurt me|threat|bully|bullying|don't want to go back|not go back|scared to go back)\b/i.test(
          message.text,
        );

      alerts.push({
        id: `safety-${index}`,
        kind: "safety",
        title: "Safety Concern",
        label: "High Alert",
        summary: matchesSchoolThreat
          ? "Child reported a potential bullying or threat situation at school. Gemini immediately reassured the child and notified a parent alert. Recommend follow-up conversation."
          : "Child reported a potential bullying or threat situation. Gemini immediately reassured the child and flagged the session for a parent follow-up.",
        messageIndex: index,
        timestamp: message.timestamp || startedAt,
        clipDuration: "0:47",
        clipStatus: "Conversation in progress",
        excerpt: message.text,
      });
      hasSafety = true;
    }

    if (!hasDistress && distressPattern.test(message.text)) {
      const matchesSeparationDistress =
        /\b(miss him|miss her|miss daddy|miss mommy|sad|scared|fear)\b/i.test(
          message.text,
        );

      alerts.push({
        id: `distress-${index}`,
        kind: "distress",
        title: "Emotional Distress",
        label: "Notice",
        summary: matchesSeparationDistress
          ? "Child expressed feelings of sadness and fear related to separation. Gemini responded with comfort and redirected to healthy coping strategies."
          : "Child expressed sadness or fear during the conversation. Gemini responded with comfort and redirected toward healthy coping strategies.",
        messageIndex: index,
        timestamp: message.timestamp || startedAt,
        clipDuration: "1:12",
        clipStatus: "Normal session activity",
        excerpt: message.text,
      });
      hasDistress = true;
    }
  });

  return alerts.sort((left, right) => left.messageIndex - right.messageIndex);
}

function resolveChildName(childData: Record<string, unknown> | undefined) {
  const candidates = [
    childData?.childName,
    childData?.displayName,
    childData?.name,
    childData?.nickname,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "Emma";
}

function shapeSessionForParent(
  sessionId: string,
  sessionData: Record<string, any>,
  childName: string,
  includeMessages: boolean,
) {
  const startedAt =
    typeof sessionData.startedAt === "number" ? sessionData.startedAt : Date.now();
  const messages = normalizeMessages(sessionData.messages);
  const alerts = deriveAlertsFromHistory(messages, startedAt);

  return {
    id: sessionId,
    startedAt,
    endedAt: typeof sessionData.endedAt === "number" ? sessionData.endedAt : undefined,
    summary: typeof sessionData.summary === "string" ? sessionData.summary : "",
    messageCount: messages.length,
    activities: Array.isArray(sessionData.activities) ? sessionData.activities : [],
    coPlayState: sessionData.coPlayState || null,
    childName,
    alertCount: alerts.length,
    alerts,
    messages: includeMessages ? messages : undefined,
  };
}

export function setupParentChatRoutes(app: Express) {
  // Get all sessions
  app.get("/api/sessions", async (req, res) => {
    try {
      const childDoc = await getChildDocument().get();
      const childName = resolveChildName(
        childDoc.data() as Record<string, unknown> | undefined,
      );
      const sessionsSnapshot = await getSessionsCollection()
        .orderBy("startedAt", "desc")
        .get();

      const sessions = sessionsSnapshot.docs.map((doc) =>
        shapeSessionForParent(doc.id, doc.data(), childName, false),
      );

      res.json(sessions);
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  // Get specific session details
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const childDoc = await getChildDocument().get();
      const childName = resolveChildName(
        childDoc.data() as Record<string, unknown> | undefined,
      );
      const sessionDoc = await getSessionsCollection().doc(req.params.id).get();

      if (!sessionDoc.exists) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      res.json(
        shapeSessionForParent(
          sessionDoc.id,
          sessionDoc.data() as Record<string, any>,
          childName,
          true,
        ),
      );
    } catch (error) {
      console.error("Error fetching session:", error);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.get("/api/sessions/:id/audio", async (req, res) => {
    try {
      const sessionDoc = await getSessionsCollection().doc(req.params.id).get();

      if (!sessionDoc.exists) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const sessionData = sessionDoc.data();
      const summary =
        typeof sessionData?.summary === "string"
          ? sessionData.summary.trim()
          : "";

      if (!summary) {
        res.status(400).json({ error: "Session summary is not available" });
        return;
      }

      const response = await AI.models.generateContent({
        model: SUMMARY_AUDIO_MODEL,
        contents: `Read this session summary exactly as written in a warm, natural voice for a parent.\n\n${summary}`,
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: SESSION_VOICE_NAME,
              },
            },
          },
        },
      });

      const generatedAudio = extractInlineAudio(response);
      if (!generatedAudio) {
        throw new Error("Gemini did not return audio data.");
      }

      const mimeType = generatedAudio.mimeType?.toLowerCase();
      const wavBuffer = mimeType?.includes("wav")
        ? generatedAudio.data
        : pcmToWav(
            generatedAudio.data,
            parseSampleRate(generatedAudio.mimeType),
          );

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.send(wavBuffer);
    } catch (error) {
      console.error("Error generating session audio:", error);
      res.status(500).json({ error: "Failed to generate session audio" });
    }
  });

  // Parent chat
  app.post("/api/parent/chat", async (req, res) => {
    const { message, conversationHistory } = req.body;

    if (!message) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    try {
      // Fetch the last 5 sessions to provide context
      const sessionsSnapshot = await getSessionsCollection()
        .orderBy("startedAt", "desc")
        .limit(5)
        .get();

      let contextText =
        "Here are the recent conversations between the child and their AI companion:\n\n";
      sessionsSnapshot.forEach((doc) => {
        const data = doc.data();
        const startedAt = new Date(data.startedAt).toLocaleString();
        contextText += `--- Session from ${startedAt} ---\n`;
        contextText += `Summary: ${data.summary}\n`;
        contextText += `Transcript:\n`;
        (data.messages || []).forEach((msg: any) => {
          contextText += `${msg.role}: ${msg.text}\n`;
        });
        contextText += `\n`;
      });

      const systemPrompt = `You are an AI assistant for parents, helping them monitor and understand their child's interactions with an AI companion.
You have access to the transcripts of the child's recent sessions.
Be helpful, analytical, and reassuring. Answer the parent's questions about what the child has been learning, inquiring about, or doing, based strictly on the provided session context.
Always maintain a supportive and constructive tone. If the parent asks something outside the scope of the transcripts, politely mention that you only have access to the recent session history.

${contextText}`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let history = (conversationHistory || []).map((msg: any) => {
        return {
          role: msg.role === "model" ? "model" : "user",
          parts: [{ text: msg.text }],
        };
      });

      // Add the new message
      history.push({ role: "user", parts: [{ text: message }] });

      const responseStream = await AI.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: history,
        config: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
        },
      });

      for await (const chunk of responseStream) {
        if (chunk.text) {
          res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Error in parent chat:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to process chat response" });
      } else {
        res.write(
          `data: ${JSON.stringify({ error: "Failed to process chat response" })}\n\n`,
        );
        res.end();
      }
    }
  });
}
