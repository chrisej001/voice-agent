import dotenv from "dotenv";
dotenv.config();

import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const VOICE_STYLE = process.env.VOICE_STYLE || "female-warm-receptionist";

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_KEY / OPENAI_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ----------------------------
// HTTP SERVER (MANDATORY FOR RENDER)
// ----------------------------
const server = createServer((req, res) => {
  // Basic health-check endpoint
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("AI Call Agent is running.\n");
  }
});

// ----------------------------
// WEBSOCKET SERVER
// ----------------------------
const wss = new WebSocketServer({ server, path: "/stream" });
console.log("WebSocket server starting on /stream");

// Audio params (must match Asterisk externalMedia)
const SAMPLE_RATE = 8000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

wss.on("connection", async (ws, req) => {
  console.log("New connection from Asterisk:", req.socket.remoteAddress);

  let incomingChunks = [];
  let outgoingChunks = [];
  const sessionId = crypto.randomUUID();

  async function uploadRecording() {
    try {
      const inBuffer = Buffer.concat(incomingChunks);
      const outBuffer = Buffer.concat(outgoingChunks);

      await supabase.storage.from("call-recordings").upload(
        `raw/${sessionId}-in.raw`,
        inBuffer,
        { upsert: true }
      );

      await supabase.storage.from("call-recordings").upload(
        `raw/${sessionId}-out.raw`,
        outBuffer,
        { upsert: true }
      );

      console.log("Uploaded recordings:", sessionId);
    } catch (err) {
      console.error("Supabase upload error:", err);
    }
  }

  // -------------------------
  // CONNECT TO OPENAI REALTIME WS
  // -------------------------
  const openaiUrl =
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

  const openaiWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI WS:", sessionId);

    const initSystem = {
      type: "system.prompt",
      voice: VOICE_STYLE,
      content:
        "You are a friendly hospital receptionist. Keep responses short and helpful.",
    };

    try {
      openaiWs.send(JSON.stringify(initSystem));
    } catch (e) {
      console.error("OpenAI init send error", e);
    }
  });

  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "response.audio.delta" && msg.audio) {
        const pcmChunk = Buffer.from(msg.audio, "base64");

        if (ws.readyState === WebSocket.OPEN) ws.send(pcmChunk);

        outgoingChunks.push(pcmChunk);
      }
    } catch (e) {
      // ignore non-JSON messages
    }
  });

  openaiWs.on("error", (err) => console.error("OpenAI WS error:", err));
  openaiWs.on("close", () =>
    console.log("OpenAI WS closed:", sessionId)
  );

  // -------------------------
  // ASTERISK → AI AUDIO STREAM
  // -------------------------
  ws.on("message", (msg, isBinary) => {
    if (!isBinary) {
      try {
        console.log("Control message from Asterisk:", JSON.parse(msg));
      } catch (_) {}
      return;
    }

    const pcm = Buffer.from(msg);
    incomingChunks.push(pcm);

    const body = {
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    };

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(body));
    }
  });

  ws.on("close", async () => {
    console.log("Asterisk WS closed:", sessionId);

    try {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (_) {}

    await uploadRecording();

    try {
      openaiWs.close();
    } catch (_) {}
  });

  ws.on("error", (err) => {
    console.error("Asterisk WS error:", sessionId, err);
  });
});

// ----------------------------
// START SERVER (💯 IMPORTANT FOR RENDER)
// ----------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
