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

export function setupParentChatRoutes(app: Express) {
  // Get all sessions
  app.get("/api/sessions", async (req, res) => {
    try {
      const sessionsSnapshot = await getSessionsCollection()
        .orderBy("startedAt", "desc")
        .get();

      const sessions = sessionsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        messages: undefined, // Don't send full history in list view
      }));

      res.json(sessions);
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  // Get specific session details
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const sessionDoc = await getSessionsCollection().doc(req.params.id).get();

      if (!sessionDoc.exists) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      res.json({
        id: sessionDoc.id,
        ...sessionDoc.data(),
      });
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
