import dotenv from "dotenv";
dotenv.config();

import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ADD THIS BLOCK ONLY – everything else in your server.js stays 100% the same
import ari from 'ari-client';

const ARI_URL = 'ws://148.230.120.157:8088/ari/events';
const ARI_USER = 'arianai';
const ARI_PASS = 'Emelifejnr1995!';   // ← the password you set in ari.conf
const ARI_APP = 'openai-realtime';

function connectARI() {
  ari.connect(url + ?api_key=user:pass&app=appname)
    .then(client => {
      console.log('✓ ARI connected to Asterisk');

      client.on('StasisStart', async (event, channel) => {
        console.log(`✓ New call ${channel.caller.number} → ${channel.dialplan.exten}`);

        try {
          await channel.answer();
          console.log('Channel answered');

          // Stop MOH immediately
          await channel.stopMoh();

          // Create the WebSocket to YOUR OWN /stream endpoint
          const ws = new WebSocket('wss://voice-agent-8jbd.onrender.com/stream');

          ws.on('open', () => console.log('WebSocket to OpenAI stream opened'));

          // Caller audio → OpenAI
          channel.on('ChannelDtmfReceived', (ev) => {
            ws.send(JSON.stringify({ type: 'dtmf', digit: ev.digit }));
          });

          // Raw PCM streaming both ways
          const externalMedia = await channel.externalMedia({
            channelId: channel.id,
            format: 'ulaw',
            direction: 'both',
            connectionType: 'client',
            remote: '127.0.0.1',   // dummy – we use raw data events
          });

          externalMedia.on('data', chunk => {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          });

          ws.on('message', data => {
            if (Buffer.isBuffer(data)) {
              externalMedia.send(data);
            }
          });

          channel.on('StasisEnd', () => {
            ws.terminate();
            externalMedia.close();
          });

        } catch (err) {
          console.error('ARI error:', err);
          channel.hangup();
        }
      });
    })
    .catch(err => {
      console.error('ARI connection failed – retrying in 5s', err.message);
      setTimeout(connectARI, 5000);
    });
}

connectARI();   // start + auto-reconnect forever
// Environment variables
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

// Create HTTP server
const server = createServer((req, res) => {
  // Basic HTTP response so Render detects the port
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voice Agent WebSocket Server is running\n");
});

// WebSocket server for Asterisk
const wss = new WebSocketServer({ server, path: "/stream" });

console.log("WebSocket server starting on /stream");

// Handle Asterisk connections
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

      console.log("Uploaded recordings to Supabase for session:", sessionId);
    } catch (err) {
      console.error("Supabase upload error:", err);
    }
  }

  // -------------------------
  // Connect to OpenAI Realtime
  // -------------------------
  const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const oaHeaders = {
    Authorization: `Bearer ${OPENAI_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };

  const openaiWs = new WebSocket(openaiUrl, { headers: oaHeaders });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime WebSocket for session", sessionId);

    const initSystem = {
      type: "system.prompt",
      voice: VOICE_STYLE,
      content: "You are a friendly hospital receptionist. Keep responses short and helpful.",
    };
    openaiWs.send(JSON.stringify(initSystem));
  });

  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.audio.delta" && msg.audio) {
        const pcmChunk = Buffer.from(msg.audio, "base64");
        if (ws.readyState === WebSocket.OPEN) ws.send(pcmChunk);
        outgoingChunks.push(pcmChunk);
      }
    } catch (e) {}
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed for session", sessionId));
  openaiWs.on("error", (err) => console.error("OpenAI WS error:", err));

  // -------------------------
  // Handle incoming audio from Asterisk
  // -------------------------
  ws.on("message", (msg, isBinary) => {
    if (!isBinary) return;

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
    console.log("Asterisk connection closed for session", sessionId);

    try {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (e) {}

    await uploadRecording();

    try { openaiWs.close(); } catch (e) {}
  });

  ws.on("error", (err) => console.error("Asterisk WS error for session", sessionId, err));
});

// Listen on Render-provided port
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
if (isNaN(PORT)) {
  console.error("Invalid PORT:", process.env.PORT);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

