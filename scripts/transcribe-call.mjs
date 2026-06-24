#!/usr/bin/env node
/**
 * READ-ONLY. Pulls a finished call's logged transcript AND, because that logging is
 * flaky, downloads the call recording and runs it back through Speko's transcription
 * (STT) to reconstruct the FULL speech of the call.
 *
 *   node scripts/transcribe-call.mjs <sessionId> [lang]
 */
import { Speko } from "@spekoai/sdk";
process.loadEnvFile?.(".env");

const raw = (process.env.SPEKO_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const ID = (process.argv[2] || "").trim();
const LANG = (process.argv[3] || "en").trim();
if (!ID) { console.error("Usage: node scripts/transcribe-call.mjs <sessionId> [lang]"); process.exit(1); }

const speko = new Speko({ apiKey: KEY });

const d = await speko.calls.get(ID);
console.log(`status=${d.status}  duration=${d.duration_seconds}s  logged_turns=${d?.transcript?.entries?.length || 0}  outcome=${d?.report?.outcome || "-"}`);
const entries = d?.transcript?.entries ?? [];
if (entries.length) {
  console.log("\n--- LOGGED TRANSCRIPT ---");
  for (const e of entries) console.log(e.source.toUpperCase().padEnd(6) + " | " + e.text);
}

let rec;
try { rec = await speko.calls.recording(ID); } catch (e) { console.log("\nno recording available:", e?.message || e); }
if (rec?.url) {
  console.log("\nrecording: " + rec.url);
  const r = await fetch(rec.url);
  if (!r.ok) { console.log("recording download failed: HTTP " + r.status); process.exit(0); }
  const audio = new Uint8Array(await r.arrayBuffer());
  console.log(`downloaded ${audio.length} bytes; transcribing (${LANG}) …`);
  try {
    const t = await speko.transcribe(audio, { language: LANG });
    console.log("\n=== FULL TRANSCRIPTION (reconstructed from the recording) ===\n");
    console.log(t.text || JSON.stringify(t, null, 2));
  } catch (e) {
    console.log("transcribe failed:", e?.message || e);
  }
}
