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
   🧩 1. Test Webhook Route (for manual testing)
   ========================================================== */
app.post("/webhook", (req, res) => {
  console.log("Webhook received:", req.body);
  res.status(200).send("Webhook received!");
});

/* ==========================================================
   🧩 2. Termii Incoming Route - Multi-turn + Hang-up
   ========================================================== */
app.post("/termii/incoming", async (req, res) => {
  const { caller, status, speech_text, hospital_id } = req.body;
  const callerPhone = caller || "+2348138693864";
  const hospital = hospital_id || "default";

  try {
    if (status === "incoming") {
      // Start a new session
      const prompt = `You are a friendly hospital receptionist for ${hospital} Hospital. Greet the caller warmly, ask one short question about their main problem, and tell them the next step. Keep the reply short and clear (20-30 seconds spoken).`;

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a polite, concise hospital receptionist." },
          { role: "user", content: prompt }
        ],
        max_tokens: 180
      });

      const reply = aiResponse.choices?.[0]?.message?.content?.trim() || 
                    "Hello — thank you for calling. Please hold while we connect you.";

      // Send AI reply as Termii voice message
      const termiiResp = await axios.post("https://v3.api.termii.com/api/sms/send", {
        api_key: process.env.TERMII_KEY,
        to: callerPhone,
        from: process.env.TERMII_SENDER || "FRCare",
        sms: reply,
        type: "plain",
        channel: "voice"
      });

      // Save session in Supabase
      await supabase.from("call_sessions").insert({
        hospital_id: hospital,
        caller_phone: callerPhone,
        ai_summary: reply,
        termii_response: termiiResp.data,
        status: "ongoing"
      });

      console.log("Started session for:", callerPhone, "AI Reply:", reply);
    } 
    
    else if (status === "speech" && speech_text) {
      // Multi-turn conversation: follow-up input
      const session = await supabase.from("call_sessions")
        .select("*")
        .eq("caller_phone", callerPhone)
        .eq("status", "ongoing")
        .order("id", { ascending: false })
        .limit(1)
        .single();

      if (session.data) {
        const prompt = `You are a friendly hospital receptionist. Continue the conversation based on this previous AI summary: "${session.data.ai_summary}". The caller just said: "${speech_text}". Reply concisely, politely, and give next step instructions if needed.`;

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a polite, concise hospital receptionist." },
            { role: "user", content: prompt }
          ],
          max_tokens: 180
        });

        const reply = aiResponse.choices?.[0]?.message?.content?.trim() || 
                      "Thank you. Please hold while we connect you.";

        await axios.post("https://v3.api.termii.com/api/sms/send", {
          api_key: process.env.TERMII_KEY,
          to: callerPhone,
          from: process.env.TERMII_SENDER || "FRCare",
          sms: reply,
          type: "plain",
          channel: "voice"
        });

        await supabase.from("call_sessions")
          .update({ ai_summary: reply })
          .eq("id", session.data.id);

        console.log("Follow-up AI reply sent:", reply);
      }
    }

    else if (status === "disconnected" || status === "call_ended") {
      // Caller hung up
      const session = await supabase.from("call_sessions")
        .select("*")
        .eq("caller_phone", callerPhone)
        .eq("status", "ongoing")
        .order("id", { ascending: false })
        .limit(1)
        .single();

      if (session.data) {
        await supabase.from("call_sessions")
          .update({ status: "completed" })
          .eq("id", session.data.id);
        console.log(`Session for ${callerPhone} ended due to hang-up`);
      }
    }

    res.status(200).send("OK");

  } catch (error) {
    console.error("Error handling Termii webhook:", error.response?.data || error.message);
    res.status(500).send("Server error");
  }
});

/* ==========================================================
   🧩 3. Render-friendly Server Setup
   ========================================================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Voice Agent running on port ${PORT}`));
