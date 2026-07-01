#!/usr/bin/env node
/**
 * assert-two-way-audio.mjs — given a Speko callId/sessionId, decide whether the
 * call ACTUALLY carried two-way audio, or was "connected but silent".
 *
 *   node scripts/assert-two-way-audio.mjs <callId>
 *
 * Exit codes:
 *   0  PASS  — real two-way audio (at least one transcript turn with source='user')
 *   3  SILENT— connected (room_started + sip.dial_started) but NO user turn
 *   4  NOT_CONNECTED — never reached the carrier / hard failure event
 *   2  USAGE / lookup error
 *
 * WHY a user turn is the proof: the agent's STT only emits a source='user'
 * transcript turn when it actually received and transcribed inbound audio from
 * the other party. Connection EVENTS (room_started, sip.dial_started,
 * room_finished) fire even when the callee's audio never reaches the room — a
 * real ended 60s call on this account had {agent:1, user:0} turns (silent),
 * while a 74s call had {agent:1, user:1} (real). Event milestones alone PASS
 * the silent call; the user-turn check is what catches it.
 */
process.loadEnvFile?.("/Users/amirlankalmukhan/mcp-dev-calls/.env");

const raw = (process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "").trim();
const KEY = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
const BASE = (process.env.SPEKO_API_BASE || "https://api.speko.dev").replace(/\/$/, "");

const callId = process.argv[2];
if (!callId) {
  console.error("usage: node scripts/assert-two-way-audio.mjs <callId>");
  process.exit(2);
}

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY}` } });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

// 1) Connection milestones
const ev = await get(`/v1/calls/${callId}/events`);
const events = ev.status === 200 ? (ev.body.events ?? []) : [];
const types = new Set(events.map((e) => e.event_type));
// Only GENUINE, non-recoverable failures count. worker.no_first_audio_timeout is NOT here:
// it fires when the agent's FIRST audio is a little late, then the call often recovers into a
// full conversation — so it must never override actual user turns (the real proof below).
const HARD_FAIL = ["agent.dispatch_failed", "sip.dial_failed"];
const hardFailure = events.find((e) => HARD_FAIL.includes(e.event_type));
const softFlag = events.find((e) => e.failure_cause || e.status === "failed");

const reachedCarrier =
  types.has("sip.dial_started") || types.has("room_started") || types.has("worker.room_connected");
const terminal = types.has("room_finished") || types.has("call.end_tool.completed");

// 2) Two-way audio proof: at least one transcript turn with source='user'
const tr = await get(`/v1/sessions/${callId}/transcript`);
const entries = tr.status === 200 ? (tr.body.entries ?? tr.body.transcript?.entries ?? []) : [];
const bySource = {};
for (const t of entries) bySource[t.source] = (bySource[t.source] ?? 0) + 1;
const userTurns = bySource.user ?? 0;
const agentTurns = bySource.agent ?? 0;

console.log(`call_id        : ${callId}`);
console.log(`events         : ${[...types].join(", ") || "<none>"}`);
console.log(`reachedCarrier : ${reachedCarrier}`);
console.log(`terminal       : ${terminal}`);
console.log(`turns          : agent=${agentTurns} user=${userTurns} (${JSON.stringify(bySource)})`);
if (hardFailure) console.log(`hardFailure    : ${hardFailure.event_type}`);
else if (softFlag) console.log(`note           : soft flag ${softFlag.event_type ?? ""} ${softFlag.failure_cause ?? ""} (recoverable — user turns decide)`);

// User turns are ground truth: real inbound audio was transcribed → two-way audio happened,
// regardless of any soft first-audio timeout the call recovered from.
if (userTurns >= 1) {
  console.log(`\nVERDICT: ✅ PASS — two-way audio confirmed (${userTurns} user turn(s), ${agentTurns} agent turn(s)).`);
  process.exit(0);
}
if (hardFailure || !reachedCarrier) {
  console.log(
    `\nVERDICT: ❌ NOT_CONNECTED — call never reached the carrier or hit a hard failure${hardFailure ? ` (${hardFailure.event_type})` : ""}.`,
  );
  process.exit(4);
}
console.log(`\nVERDICT: 🔇 SILENT — connected but NO inbound (user) audio was ever transcribed.`);
console.log(`         (event milestones alone would FALSELY pass this call.)`);
process.exit(3);
