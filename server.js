import 'dotenv/config';
import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// Connect to Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Connect to OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

/* ==========================================================
   AI-powered Termii Incoming Route (replace existing one)
   ========================================================== */
app.post("/termii/incoming", async (req, res) => {
  const call = req.body;
  console.log("Incoming call:", call);

  const hospitalId = call.hospital_id || "default";
  const caller = call.from || call.caller || call.msisdn || "+2348138693864";

  // Build a concise prompt so the reply fits nicely in voice
  const prompt = `You are a friendly hospital receptionist for ${hospitalId} Hospital. Greet the caller warmly, ask one short question about their main problem, and tell them the next step. Keep the reply short and clear (about 20-30 seconds spoken).`;

  try {
    // 1) Ask OpenAI for a short reply
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a polite, concise hospital receptionist." },
        { role: "user", content: prompt }
      ],
      max_tokens: 180
    });

    const reply = (aiResponse.choices && aiResponse.choices[0] && aiResponse.choices[0].message && aiResponse.choices[0].message.content)
      ? aiResponse.choices[0].message.content.trim()
      : "Hello — thank you for calling. Please hold while we connect you.";

    console.log("AI Reply:", reply);

    // 2) Send the reply to Termii as a voice message
    const termiiResp = await axios.post("https://v3.api.termii.com/api/sms/send", {
      api_key: process.env.TERMII_KEY,
      to: caller,
      from: process.env.TERMII_SENDER || "FRCare", // set TERMII_SENDER in Render (approved short sender id)
      sms: reply,
      type: "plain",
      channel: "voice"
    });

    console.log("Termii voice response:", termiiResp.data);

    // 3) Store call + AI reply in Supabase for dashboard & follow-up
    await supabase.from("call_sessions").insert({
      hospital_id: hospitalId,
      caller_phone: caller,
      ai_summary: reply,
      termii_response: termiiResp.data
    });

    return res.status(200).send("Voice AI reply sent successfully");
  } catch (error) {
    console.error("Error processing call:", error.response ? error.response.data : error.message);
    return res.status(500).send("Server error");
  }
});

/* ==========================================================
   🧩 2. Webhook Test Route (For manual testing via ReqBin)
   ========================================================== */
app.post("/webhook", async (req, res) => {
  try {
    const { caller } = req.body;
    console.log("Webhook received:", req.body);

    const reply = "Hello! This is your hospital's AI voice assistant speaking.";

    const response = await axios.post("https://v3.api.termii.com/api/sms/send", {
      api_key: process.env.TERMII_KEY,
      to: caller || "+2348138693864",
      from: "FRCare",
      sms: reply,
      type: "plain",
      channel: "voice"
    });

    console.log("Termii response:", response.data);
    res.status(200).send("AI voice reply sent");
  } catch (error) {
    console.error("Error sending reply:", error.response ? error.response.data : error.message);
    res.status(500).send("Error sending reply");
  }
});

/* ==========================================================
   🧩 3. Server Setup
   ========================================================== */
app.listen(8080, () => console.log("✅ Voice Agent running on port 8080"));



