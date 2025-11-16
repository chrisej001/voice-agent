import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Ari from 'ari-client';
import fs from 'fs';
import { exec } from 'child_process';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

// ARI settings
const ARI_URL = 'http://127.0.0.1:8088';
const ARI_USER = 'asterisk-user';
const ARI_PASS = 'StrongARIpass123';
const APP_NAME = 'ai-agent';

// TTS helper (replace with your TTS engine if needed)
function textToAudio(text, filePath) {
  return new Promise((resolve, reject) => {
    exec(`say -o ${filePath} --data-format=LEF32@22050 "${text}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Connect to ARI
Ari.connect(`${ARI_URL}/ari`, ARI_USER, ARI_PASS)
  .then(client => {
    console.log('✅ Connected to Asterisk ARI');

    client.on('StasisStart', async (event, channel) => {
      await channel.answer();
      console.log(`Incoming call from ${channel.name}`);

      // Read hospital ID from channel variables (set in extensions.conf)
      const hospital = channel.variables.HOSPITAL_ID || 'default';

      // Create new session in Supabase
      const { data: sessionData } = await supabase.from('call_sessions').insert({
        caller_phone: channel.name,
        hospital_id: hospital,
        status: 'ongoing',
        ai_summary: ''
      });
      const sessionId = sessionData?.[0]?.id;

      let lastReply = '';

      // Initial AI greeting
      const prompt = `You are a friendly receptionist for ${hospital} Hospital. Greet the caller warmly and ask their main problem briefly. Keep it short.`;

      const aiResp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a polite hospital receptionist.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 180
      });

      lastReply = aiResp.choices[0].message.content.trim();
      console.log('AI Reply:', lastReply);

      // Convert AI reply to audio and play on channel
      const audioFile = `/tmp/${channel.name}_reply.wav`;
      await textToAudio(lastReply, audioFile);
      await channel.play({ media: `file://${audioFile}` });

      // Update session in Supabase
      await supabase.from('call_sessions').update({ ai_summary: lastReply }).eq('id', sessionId);

      // Listen for speech input (replace DTMF with real STT engine)
      channel.on('DTMFReceived', async (dtmf) => {
        const callerText = dtmf.digit; // placeholder

        const prompt2 = `Continue conversation based on last AI summary: "${lastReply}". Caller just said: "${callerText}". Reply concisely for ${hospital} Hospital.`;

        const aiResp2 = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a polite hospital receptionist.' },
            { role: 'user', content: prompt2 }
          ],
          max_tokens: 180
        });

        lastReply = aiResp2.choices[0].message.content.trim();
        console.log('Follow-up AI reply:', lastReply);

        const followupAudio = `/tmp/${channel.name}_reply2.wav`;
        await textToAudio(lastReply, followupAudio);
        await channel.play({ media: `file://${followupAudio}` });

        await supabase.from('call_sessions').update({ ai_summary: lastReply }).eq('id', sessionId);
      });

      channel.on('ChannelDestroyed', async () => {
        console.log(`Call with ${channel.name} ended`);
        await supabase.from('call_sessions').update({ status: 'completed' }).eq('id', sessionId);
      });
    });

    client.start(APP_NAME);
  })
  .catch(err => console.error('ARI connection error:', err));
