#!/usr/bin/env node
/**
 * Read-only diagnostic: dump everything the Speko platform knows about a call —
 * SDK CallDetail plus the raw session/call/transcript endpoints — so we can see
 * the REAL status, duration, and any hangup/SIP failure cause (not our poll loop).
 *
 *   node scripts/inspect-call.mjs <callId>
 */
import { Speko } from "@spekoai/sdk";

process.loadEnvFile?.(".env");

const raw = (process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "").trim();
const apiKey = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const baseUrl =
  (process.env.SPEKOAI_API_URL || process.env.SPEKO_API_BASE || process.env.SPEKOAI_BASE_URL || "").trim() ||
  "https://api.speko.dev";

const callId = process.argv[2];
if (!callId) {
  console.error("usage: node scripts/inspect-call.mjs <callId>");
  process.exit(1);
}

const dump = (label, v) => console.log(`\n===== ${label} =====\n` + JSON.stringify(v, null, 2));

// 1) SDK view
try {
  const speko = new Speko({ apiKey, baseUrl, timeout: 30_000 });
  const detail = await speko.calls.get(callId);
  dump("SDK calls.get()", detail);
} catch (e) {
  dump("SDK calls.get() ERROR", { message: String(e?.message ?? e), status: e?.status });
}

// 2) Raw platform endpoints — show every field the SDK might drop
const rawGet = async (path) => {
  try {
    const r = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    dump(`RAW GET ${path}  (HTTP ${r.status})`, body);
  } catch (e) {
    dump(`RAW GET ${path} ERROR`, { message: String(e?.message ?? e) });
  }
};

await rawGet(`/v1/sessions/${callId}`);
await rawGet(`/v1/calls/${callId}`);
await rawGet(`/v1/sessions/${callId}/transcript`);
