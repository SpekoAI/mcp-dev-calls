#!/usr/bin/env node
/**
 * No-call Russian voice picker. Renders the ACTUAL message your mom will hear,
 * in several NATIVE Russian ElevenLabs voices, so you can choose the warmest one
 * before the single real call. Writes playable WAVs to voice-samples/ and prints
 * each voice's id (pass it as arg3 to scripts/call.mjs).
 *
 *   node scripts/russian-voices.mjs
 *   open voice-samples/ru-Elena.wav   (Victoria / Liza / Maxim / Vladimir)
 */
import { writeFileSync } from "node:fs";
process.loadEnvFile?.(".env");

const raw = (process.env.SPEKO_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const BASE = (process.env.SPEKOAI_API_URL || "https://api.speko.dev").replace(/\/+$/, "");
const TTS_PIN = (process.env.SPEKO_TTS_PIN ?? "elevenlabs:eleven_turbo_v2_5").trim();

// The real message, so each voice is judged on the actual words.
const TEXT =
  "Здравствуйте! Это короткое тестовое сообщение, чтобы оценить, насколько естественно звучит голос. " +
  "Надеюсь, у вас всё хорошо, и желаю вам прекрасного дня.";

// Native Russian voices, warmest first (female conversational → calm male → deep male).
const VOICES = [
  { name: "Elena", id: "0ArNnoIAWKlT4WweaVMY", note: "warm conversational female (top pick)" },
  { name: "Victoria", id: "D5RRIJYa9pFwxiSpbGbR", note: "gentle, warm female" },
  { name: "Liza", id: "KzqxCy7zSSePwgb1Cz0Q", note: "natural conversational female, Moscow" },
  { name: "Maxim", id: "HcaxAsrhw4ByUo4CBCBN", note: "calm male, Moscow" },
  { name: "Vladimir", id: "NkBkAMqIBNjZUjXKAA7r", note: "deep male narrator" },
];

const RATE = 24000;
function pcmToWav(pcm, sampleRate) {
  const h = Buffer.alloc(44), len = pcm.length;
  h.write("RIFF", 0); h.writeUInt32LE(36 + len, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(len, 40);
  return Buffer.concat([h, pcm]);
}

console.log(`text: "${TEXT}"\npin : ${TTS_PIN}\n`);
let fails = 0;
for (const v of VOICES) {
  const r = await fetch(`${BASE}/v1/synthesize`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      text: TEXT,
      intent: { language: "ru", optimizeFor: "latency" },
      voice: v.id,
      constraints: { allowedProviders: { tts: [TTS_PIN] } },
    }),
  });
  const ct = r.headers.get("content-type") || "";
  const buf = Buffer.from(await r.arrayBuffer());
  const ok = r.status === 200 && ct.startsWith("audio/") && buf.length > 50000;
  const file = `voice-samples/ru-${v.name}.wav`;
  if (!ok) {
    fails++;
    console.log(`❌ ${v.name.padEnd(9)} HTTP ${r.status} ${ct} ${buf.length}b  — ${buf.slice(0,160).toString("utf-8")}`);
    continue;
  }
  writeFileSync(file, pcmToWav(buf, RATE));
  console.log(`✅ ${v.name.padEnd(9)} id=${v.id}  ${buf.length}b  → ${file}   (${v.note})`);
}
console.log(
  fails === 0
    ? `\nAll rendered. Listen:  open voice-samples/ru-Elena.wav   then pick → pass its id to scripts/call.mjs`
    : `\n${fails} failed — see above.`,
);
process.exit(fails === 0 ? 0 : 1);
