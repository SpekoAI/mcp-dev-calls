#!/usr/bin/env node
/**
 * READ-ONLY diagnostic for the silent ambient call. Places NO call and mutates
 * nothing — it just reads back: (1) what actually persisted on the carrier agent
 * (voice / stackPreferences / backgroundAudio), (2) the most recent call's
 * resolved pipeline_config (the providers the worker really used), (3) the
 * transcript (did the agent ever produce a turn?), and (4) call events (errors).
 *
 *   node scripts/inspect-ambient.mjs
 */
import { Speko } from "@spekoai/sdk";

process.loadEnvFile?.(".env");
const raw = (process.env.SPEKO_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const AGENT_NAME = "amirlan-personal-ambience";

const speko = new Speko({ apiKey: KEY });

const agent = (await speko.agents.list()).find((a) => a.name === AGENT_NAME);
if (!agent) {
  console.error(`No agent named '${AGENT_NAME}' — the create step may have failed before dialing.`);
  process.exit(1);
}

console.log("=== AGENT ROW (what actually persisted) ===");
console.log(JSON.stringify({
  id: agent.id,
  voice: agent.voice,
  intent: agent.intent,
  stackPreferences: agent.stackPreferences,
  backgroundAudio: agent.backgroundAudio,
  systemPromptChars: agent.systemPrompt?.length ?? 0,
}, null, 2));

const page = await speko.agents.listCalls(agent.id).catch((e) => {
  console.error("listCalls failed:", e?.message || e);
  return null;
});
const calls = page?.calls ?? page?.entries ?? [];
console.log(`\n=== RECENT CALLS for this agent (${calls.length}) ===`);
for (const c of calls.slice(0, 5)) {
  console.log(`  ${c.created_at}  ${c.id}  status=${c.status}  dur=${c.duration_seconds ?? "?"}s`);
}
if (!calls.length) {
  console.log("  (none) — the dial likely never created a call leg for this agent.");
  process.exit(0);
}

const latest = calls[0];
console.log(`\n=== LATEST CALL ${latest.id} ===`);
const detail = await speko.calls.get(latest.id);
console.log(JSON.stringify({
  status: detail.status,
  duration_seconds: detail.duration_seconds,
  agent_id: detail.agent_id,
  recording_status: detail.recording_status,
  pipeline_config: detail.pipeline_config,
}, null, 2));

const entries = detail?.transcript?.entries ?? [];
console.log(`\n=== TRANSCRIPT (${entries.length} turns) ===`);
for (const e of entries) console.log(`  ${e.source.padEnd(6)} [${e.provider ?? "-"}/${e.model ?? "-"}] ${e.text}`);
if (!entries.length) console.log("  (empty) — pipeline produced no turns.");

const ev = await speko.calls.events(latest.id).catch((e) => ({ events: [], err: e?.message }));
console.log(`\n=== EVENTS (${ev.events?.length ?? 0}) ===`);
for (const e of ev.events ?? []) {
  const blob = JSON.stringify(e);
  if (/error|fail|silent|tts|audio|no_key|missing|decline|reject/i.test(blob)) console.log("  ⚠️ " + blob);
}
console.log("  (full event dump:)");
console.log(JSON.stringify(ev.events ?? ev, null, 2).slice(0, 4000));
