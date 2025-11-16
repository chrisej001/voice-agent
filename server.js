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

// Audio params (must match Asterisk externalMedia)
const SAMPLE_RATE = 8000; // Hz
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // 16-bit => 2 bytes

// Create HTTP server (Render provides TLS/HTTP, but ws needs server)
const server = createServer();
const wss = new WebSocketServer({ server, path: "/stream" });

console.log("WebSocket server starting on /stream");

wss.on("connection", async (ws, req) => {
  console.log("New connection from Asterisk:", req.socket.remoteAddress);

  // Create an in-memory buffer to hold incoming raw PCM for later upload
  let incomingChunks = [];
  let outgoingChunks = [];

  // Unique id for this call/session
  const sessionId = crypto.randomUUID();

  // Helper: upload combined buffer to Supabase at end
  async function uploadRecording() {
    try {
      const inBuffer = Buffer.concat(incomingChunks);
      const outBuffer = Buffer.concat(outgoingChunks);

      // Save both as separate files
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

      console.log("Uploaded recordings to Supabase for session:", sessionId);
    } catch (err) {
      console.error("Supabase upload error:", err);
    }
  }

  // -------------------------
  // Connect to OpenAI Realtime (WebSocket)
  // -------------------------
  // This uses a generic WebSocket connection to OpenAI Realtime API.
  // Replace the URL and frame format if your SDK expects a different method.
  //
  // We expect:
  // - Send JSON messages of type 'input_audio_buffer.append' with base64 audio
  // - Listen for 'response.audio.delta' messages with base64 chunks to play back
  //
  const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"; // example
  const oaHeaders = {
    Authorization: `Bearer ${OPENAI_KEY}`,
    "OpenAI-Beta": "realtime=v1"
  };

  const openaiWs = new WebSocket(openaiUrl, { headers: oaHeaders });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime WebSocket for session", sessionId);

    // You can optionally send an initial "configure" or "system prompt" message.
    const initSystem = {
      type: "system.prompt",
      voice: VOICE_STYLE,
      content: "You are a friendly hospital receptionist. Keep responses short and helpful."
    };
    try {
      openaiWs.send(JSON.stringify(initSystem));
    } catch (e) {
      console.error("OpenAI init error", e);
    }
  });

  openaiWs.on("message", (data) => {
    // OpenAI messages can be JSON text or binary audio messages encoded as JSON base64.
    // We'll parse JSON and when we see response.audio.delta, decode and forward to Asterisk.
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.audio.delta" && msg.audio) {
        // msg.audio is base64 audio chunk (PCM 16-bit LE assumed)
        const pcmChunk = Buffer.from(msg.audio, "base64");
        // send binary to Asterisk WS
        if (ws.readyState === WebSocket.OPEN) ws.send(pcmChunk);
        // save for upload later
        outgoingChunks.push(pcmChunk);
      } else {
        // handle other event messages (e.g., text transcripts)
        // you may write transcripts to Supabase here (optional)
        // e.g. msg.type === "response.text" -> save msg.text
      }
    } catch (e) {
      // sometimes openai might send non-json; ignore for now
      // console.error("OpenAI message parse error", e, data);
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed for session", sessionId);
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  // -------------------------
  // Asterisk => Render: handle incoming audio frames (binary)
  // -------------------------
  // Asterisk will send raw PCM chunks as binary frames. Forward them (base64) to OpenAI:
  ws.on("message", (msg, isBinary) => {
    if (!isBinary) {
      // Might be control messages (JSON) from Asterisk - ignore or handle
      try {
        const control = JSON.parse(msg.toString());
        console.log("Control message from Asterisk:", control);
      } catch (e) {}
      return;
    }

    // msg is Buffer of PCM audio from Asterisk
    const pcm = Buffer.from(msg);

    // Save chunk for later upload
    incomingChunks.push(pcm);

    // Send audio to OpenAI Realtime as base64 inside a JSON message
    // Note: Confirm your OpenAI Realtime expects 'input_audio_buffer.append' messages.
    const body = {
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64")
    };

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(body));
    } else {
      // Not ready yet - you may buffer audio or drop
    }
  });

  // On close, finalize session: tell OpenAI we're done and upload files
  ws.on("close", async () => {
    console.log("Asterisk connection closed for session", sessionId);

    // Tell OpenAI we've finished sending audio
    try {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        // Optionally request finalization / transcript / summary
        openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (e) {}

    // upload recordings to Supabase
    await uploadRecording();

    // cleanup openaiWs
    try {
      openaiWs.close();
    } catch (e) {}
  });

  ws.on("error", (err) => {
    console.error("Asterisk WS error for session", sessionId, err);
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
