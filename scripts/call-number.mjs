#!/usr/bin/env node
/**
 * Test the call_number (direct-dial) path — the mechanism behind the npx hero flow
 * ("find a place via web search → call it"). Dials the number you pass with the disclosed
 * AI opening + your objective, polls until the call ends, and prints an honest verdict.
 *
 *   node scripts/call-number.mjs +14155551234 "Ask if you're open and have carnitas" Amir
 *
 * Only ever dial a number you have consent to call. Requires the demo server running
 * (npm run start:server) and a SPEKO_API_KEY in .env.
 */
const BASE = process.env.SPEKO_MCP_SERVER_URL || "http://127.0.0.1:8787";

const phone = process.argv[2];
const objective = process.argv[3] || "Ask if you're open right now and whether you have carnitas tacos.";
const caller = process.argv[4] || "Amir";

if (!phone) {
  console.error('Usage: node scripts/call-number.mjs <+E164> ["objective"] ["CallerName"]');
  process.exit(1);
}

console.log(`→ calling ${phone}  (caller: ${caller})`);
console.log(`→ objective: ${objective}`);
console.log("→ caller-ID auto-resolved server-side; polling until the call ends\n");

const r = await fetch(`${BASE}/call-number`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone_number: phone, objective, caller_name: caller }),
});
const call = await r.json().catch(() => ({}));

// Pre-dial rejection (quiet hours, blocked objective, bad caller-ID) → nothing was placed.
if (!r.ok || call.error) {
  console.log(`\n⛔ REJECTED before dialing — nothing was placed (HTTP ${r.status})`);
  console.log(`  reason : ${call.error ?? "unknown error"}`);
  if (call.next_step) console.log(`  next   : ${call.next_step}`);
  process.exit(2);
}

const ring =
  call.connected === true ? "✅ a real call leg reached the carrier" : "❌ NO call leg — the phone never rang";
const talk = call.answered === true ? "✅ the other party spoke" : "❌ no one responded";
console.log(`\nVERDICT`);
console.log(`  status    : ${call.status}`);
console.log(`  connected : ${ring}`);
console.log(`  answered  : ${talk}`);
console.log(`  duration  : ${call.duration_seconds}s   call_id: ${call.call_id ?? "-"}`);
if (call.reason) console.log(`  reason    : ${call.reason}`);
if (call.outcome) console.log(`  outcome   : ${call.outcome}`);
console.log(`\nVerify two-way audio:  node scripts/assert-two-way-audio.mjs ${call.call_id ?? "<call_id>"}`);
