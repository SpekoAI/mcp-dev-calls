#!/usr/bin/env node
/**
 * No-call voice A/B/C renderer. Synthesizes a phrase across multiple ElevenLabs
 * voices and delivery speeds via /v1/synthesize, wraps the raw PCM in a WAV header,
 * and writes playable files to voice-samples/. Lets you compare voices instantly
 * without placing a single phone call.
 *
 *   node scripts/voice-samples.mjs                 # uses the default test phrase
 *   node scripts/voice-samples.mjs "your phrase"   # custom phrase
 *
 * Then: open voice-samples/Chris-natural.wav   (etc.)
 */
import { writeFileSync } from "node:fs";

process.loadEnvFile?.(".env");

const raw = (process.env.SPEKO_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const BASE = (process.env.SPEKOAI_API_URL || "https://api.speko.dev").replace(/\/+$/, "");
const ttsPin = (process.env.SPEKO_TTS_PIN ?? "").trim() || "elevenlabs:eleven_turbo_v2_5";
const optimizeFor = (process.env.SPEKO_OPTIMIZE_FOR ?? "").trim() || "latency";

const PHRASE = process.argv[2] || "Hey! So, uh — I just wanted to call and say hi. Honestly, how have you been lately?";

// Same-provider ElevenLabs voices (safe against the ElevenLabs TTS pin — a cross-provider
// voice id routes wrong and goes silent, see the silent-call incident).
const VOICES = [
  { name: "Chris", id: "iP95p4xoKVk53GoZ742B" }, // charming, down-to-earth
  { name: "Noah", id: "iEwEUVNDPmshU0IJrWmj" }, //  young, friendly
  { name: "Eric", id: "cjVigY5qzO86Huf0OWal" }, //  smooth
];
const SPEEDS = [
  { tag: "slow", speed: 0.92 },
  { tag: "natural", speed: 1.0 },
  { tag: "lively", speed: 1.08 },
];

const RATE = 24000; // audio/pcm;rate=24000 — 16-bit signed LE mono

/** Wrap raw 16-bit mono PCM in a 44-byte WAV header so the OS can play it. */
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono * 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

async function synth(voiceId, speed) {
  const body = {
    text: PHRASE,
    intent: { language: "en", optimizeFor },
    voice: voiceId,
    speed,
    constraints: { allowedProviders: { tts: [ttsPin] } },
  };
  const r = await fetch(`${BASE}/v1/synthesize`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ct = r.headers.get("content-type") || "";
  const model = r.headers.get("x-speko-model") || "(none)";
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ct, model, buf };
}

console.log(`phrase : "${PHRASE}"`);
console.log(`pin    : ${ttsPin}   optimizeFor: ${optimizeFor}\n`);

let failures = 0;
for (const v of VOICES) {
  for (const s of SPEEDS) {
    const { status, ct, model, buf } = await synth(v.id, s.speed);
    const ok = status === 200 && ct.startsWith("audio/") && buf.length > 50000;
    const file = `voice-samples/${v.name}-${s.tag}.wav`;
    if (!ok) {
      failures += 1;
      console.log(`❌ ${v.name.padEnd(6)} ${s.tag.padEnd(8)} HTTP ${status} ${ct} ${buf.length}b`);
      if (!ct.startsWith("audio/")) console.log("   " + buf.slice(0, 200).toString("utf-8"));
      continue;
    }
    writeFileSync(file, pcmToWav(buf, RATE));
    console.log(`✅ ${v.name.padEnd(6)} ${s.tag.padEnd(8)} ${model}  ${buf.length}b  → ${file}`);
  }
}

console.log(
  failures === 0
    ? `\nAll 9 rendered. Compare:  open voice-samples/Chris-natural.wav  (Noah / Eric, slow/natural/lively)`
    : `\n${failures} clip(s) failed — see above.`,
);
process.exit(failures === 0 ? 0 : 1);
