#!/usr/bin/env node
/**
 * No-call TTS preflight. Confirms the configured TTS pin actually synthesizes audio
 * (HTTP 200 + real audio bytes) BEFORE any dial — the lesson from the silent-call
 * incident, where a bad voice/provider pin produced no audio while still "succeeding".
 *
 *   node scripts/verify-tts.mjs
 *
 * Exits 0 = audio works (safe to dial); non-zero = would be silent (do NOT dial).
 */
process.loadEnvFile?.(".env");

const raw = (process.env.SPEKO_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const BASE = (process.env.SPEKOAI_API_URL || "https://api.speko.dev").replace(/\/+$/, "");
const ttsPin = (process.env.SPEKO_TTS_PIN ?? "").trim() || "elevenlabs:eleven_turbo_v2_5";
const optimizeFor = (process.env.SPEKO_OPTIMIZE_FOR ?? "").trim() || "latency";
const voice = (process.env.SPEKO_DEMO_VOICE ?? "").trim();

// Mirrors the dial's TTS config (pin + the exact voice) so this preflight catches a bad voice.
const body = {
  text: "Hey! Quick heads up, I'm Amirlan's assistant — he asked me to give you a call. You got a sec?",
  intent: { language: "en", optimizeFor },
  ...(voice ? { voice } : {}),
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

console.log(`pin: ${ttsPin}  voice: ${voice || "(default)"}  optimizeFor: ${optimizeFor}`);
console.log(`→ HTTP ${r.status}  content-type=${ct}  x-speko-model=${model}  bytes=${buf.length}`);

const ok = r.status === 200 && ct.startsWith("audio/") && buf.length > 50000;
if (!ok) {
  console.error("\n❌ TTS preflight FAILED — this pin does NOT produce audio. Do NOT dial.");
  if (!ct.startsWith("audio/")) console.error("   body:", buf.slice(0, 300).toString("utf-8"));
  process.exit(1);
}
console.log("\n✅ TTS preflight PASSED — audio synthesizes. Safe to dial.");
