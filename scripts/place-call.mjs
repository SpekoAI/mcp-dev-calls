#!/usr/bin/env node
/**
 * One-shot demo runner: lookup "Sakura Sushi" (demo mode resolves the consented
 * target + mints a dial token) → place the disclosed reservation call → print
 * the transcript + outcome. Avoids shell/python quoting fragility.
 */
const BASE = process.env.SPEKO_MCP_SERVER_URL || "http://127.0.0.1:8787";

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
};

const lookup = await post("/lookup", { name: "Sakura Sushi" });
const cand = lookup?.candidates?.[0];
if (!cand?.dial_token) {
  console.error("No dial token returned:\n" + JSON.stringify(lookup, null, 2));
  process.exit(1);
}
console.log(`→ target: ${cand.name}  ${cand.phone}  (${cand.line_type}, allowed=${cand.allowed})`);
console.log("→ dialing… caller-ID auto-resolved server-side; polling until the call ends\n");

const call = await post("/call", {
  dial_token: cand.dial_token,
  objective: "Reserve a table for 4 people tonight at 8:00 PM under the name Amirlan, and confirm the booking.",
  caller_name: "Amirlan",
  context: "Party of 4, tonight at 8pm. If 8pm is unavailable, ask for the closest available time.",
});

// Honest verdict first, raw payload second.
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
console.log(`\n--- raw ---\n${JSON.stringify(call, null, 2)}`);
