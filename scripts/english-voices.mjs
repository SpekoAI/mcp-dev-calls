#!/usr/bin/env node
/**
 * No-call English naturalness picker. Renders a natural, filler-rich conversational
 * line across the most humanlike English voices using ElevenLabs' MOST natural model
 * (eleven_v3, per Speko's own benchmark: quality 0.96), plus a turbo_v2_5 render of the
 * top picks so you can hear the naturalness-vs-latency tradeoff. Writes playable files
 * to voice-samples/ and is content-type aware (v3 may return mp3; turbo returns pcm).
 *
 *   node scripts/english-voices.mjs
 *   open voice-samples/en-v3-Lauren.mp3   (Hugh / Siren / Chris / Noah / Will)
 */
import { writeFileSync } from "node:fs";
process.loadEnvFile?.(".env");

const raw = (process.env.SPEKO_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const BASE = (process.env.SPEKOAI_API_URL || "https://api.speko.dev").replace(/\/+$/, "");

// Natural, conversational, filler-rich — judges humanness, not just timbre.
const TEXT =
  "Hey! Yeah, it's me — sorry to call kind of out of the blue. I, uh, I won't keep you long, " +
  "promise. Honestly I just wanted to hear your voice and see how you're doing. So... how've you been lately?";

const VOICES = [
  { name: "Lauren", id: "l4Coq6695JDX9xtLqXDE", note: "warm, HUMANLIKE, friendly female" },
  { name: "Hugh", id: "2UMI2FME0FFUFMlUoRER", note: "natural conversational agent, male, british" },
  { name: "Siren", id: "eXpIbVcVbLo8ZJQDlDnl", note: "natural realistic, female, chill" },
  { name: "Chris", id: "iP95p4xoKVk53GoZ742B", note: "charming, down-to-earth, male (proven)" },
  { name: "Noah", id: "iEwEUVNDPmshU0IJrWmj", note: "conversational, chill, young male" },
  { name: "Will", id: "bIHbv24MWmeRgasZH58o", note: "relaxed optimist, young male" },
];

// v3 = max naturalness for everyone; turbo = latency-feel reference for the top 3.
const JOBS = [
  ...VOICES.map((v) => ({ ...v, model: "eleven_v3", tag: "v3" })),
  ...VOICES.slice(0, 3).map((v) => ({ ...v, model: "eleven_turbo_v2_5", tag: "turbo" })),
];

function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44), len = pcm.length;
  h.write("RIFF", 0); h.writeUInt32LE(36 + len, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(len, 40);
  return Buffer.concat([h, pcm]);
}

console.log(`text: "${TEXT}"\n`);
let fails = 0;
for (const j of JOBS) {
  const r = await fetch(`${BASE}/v1/synthesize`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      text: TEXT,
      intent: { language: "en", optimizeFor: j.tag === "v3" ? "balanced" : "latency" },
      voice: j.id,
      constraints: { allowedProviders: { tts: [`elevenlabs:${j.model}`] } },
    }),
  });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const model = r.headers.get("x-speko-model") || j.model;
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200 || !ct.startsWith("audio/") || buf.length < 20000) {
    fails++;
    console.log(`❌ ${j.tag.padEnd(5)} ${j.name.padEnd(8)} HTTP ${r.status} ${ct} ${buf.length}b  ${buf.slice(0,140).toString("utf-8")}`);
    continue;
  }
  // Save with the right container so it plays.
  let ext, out;
  if (ct.includes("pcm")) { ext = "wav"; out = pcmToWav(buf); }
  else if (ct.includes("mpeg") || ct.includes("mp3")) { ext = "mp3"; out = buf; }
  else if (ct.includes("wav")) { ext = "wav"; out = buf; }
  else { ext = "audio"; out = buf; }
  const file = `voice-samples/en-${j.tag}-${j.name}.${ext}`;
  writeFileSync(file, out);
  console.log(`✅ ${j.tag.padEnd(5)} ${j.name.padEnd(8)} model=${model} ${ct} ${buf.length}b → ${file}   (${j.note})`);
}
console.log(fails === 0 ? `\nAll rendered. Listen, then tell me your voice + model pick.` : `\n${fails} failed — see above (v3 may be unavailable; turbo is the fallback).`);
process.exit(fails === 0 ? 0 : 1);
