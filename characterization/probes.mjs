/**
 * The characterization probe matrix. Every probe is a deterministic, offline observation
 * of the bundle's black-box surface: CLI invocations and MCP stdio tool calls with a dummy
 * key and a network sinkhole (nothing ever dials; anything passing all rails dies at the
 * sinkhole with a normalized <NETERR> marker — which IS the observable "reached the dial
 * layer" signal).
 *
 * Structure: sessions (one spawned MCP server per env recipe) + CLI probes.
 * Baseline = these probes run against the published 0.4.9 tarball (frozen).
 * Target   = same probes against the local 0.5.0 build.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_API_KEY, PROBE_SECRET, mintToken, offsetForLocalHour } from "./lib/token.mjs";

const SINKHOLE = "http://127.0.0.1:9";
const NUM = "+14155550142"; // reserved fictional (555-01xx)
const NUM_UNMAPPED = "+19075550142"; // 907 not in the NANP area map -> offset unknown
const CALLER = "Probe";
// Wait cap for probes that PASS every rail and reach the dial layer: the sinkhole refuses
// instantly so this rarely binds, but a slow retry/backoff in the bundle must not read as
// PROBE_TIMEOUT. One named constant instead of the literal smeared across the dial-reaching probes.
const DIAL_TIMEOUT_MS = 90_000;

/** Seed a guard dir with 3 recent same-number dial-ledger rows (for rate-cap / trusted probes). */
function seedThreeLedgerCalls(dir, now = Date.now()) {
  const lines = [1, 2, 3]
    .map((i) => JSON.stringify({ ts: new Date(now - i * 60_000).toISOString(), e164: NUM, call_id: null }))
    .join("\n");
  writeFileSync(join(dir, "ledger.jsonl"), `${lines}\n`);
}

function baseSessionEnv(guardDir) {
  return {
    SPEKO_API_KEY: PROBE_API_KEY,
    SPEKOAI_API_URL: SINKHOLE,
    SPEKO_DIAL_TOKEN_SECRET: PROBE_SECRET,
    SPEKO_GUARD_STATE_DIR: guardDir,
  };
}

const DAY = () => offsetForLocalHour(14);
const NIGHT = () => offsetForLocalHour(23);

function callNumberArgs(overrides = {}) {
  return {
    phone_number: NUM,
    objective: "Ask if they have a table for four tonight at eight.",
    caller_name: CALLER,
    utc_offset_minutes: DAY(),
    ...overrides,
  };
}

/**
 * Returns { sessions, cli }.
 * sessions: [{ key, env?, seed?(dir), probes: [{ id, tool, args()|meta, timeoutMs? }] }]
 *   - env: extra env vars merged over baseSessionEnv (optional).
 *   - seed(dir): pre-populate the probe's fresh guard-state dir (optional).
 *   - probe.args() is a thunk (evaluated at run time so DAY()/NIGHT()/token exp are current).
 * cli: [{ id, argv }] — invocations of the bundle's CLI entrypoint.
 */
export function buildMatrix() {
  const sessions = [
    {
      key: "main",
      seed: null,
      probes: [
        { id: "mcp.initialize", meta: "initialize" },
        { id: "mcp.tools-list", meta: "tools-list" },

        // call_number rails - number-level blocks
        { id: "rail.emergency", tool: "call_number", args: () => callNumberArgs({ phone_number: "+1911" }) },
        { id: "rail.premium", tool: "call_number", args: () => callNumberArgs({ phone_number: "+19005551234" }) },
        { id: "rail.invalid-e164", tool: "call_number", args: () => callNumberArgs({ phone_number: "12345" }) },

        // objective screens
        { id: "rail.objective-short", tool: "call_number", args: () => callNumberArgs({ objective: "hi" }) },
        { id: "rail.objective-sell", tool: "call_number", args: () => callNumberArgs({ objective: "Sell them our new subscription plan" }) },
        { id: "rail.objective-survey", tool: "call_number", args: () => callNumberArgs({ objective: "Run a customer survey about their habits" }) },
        { id: "rail.objective-fundraise", tool: "call_number", args: () => callNumberArgs({ objective: "Ask them to donate to our fundraiser" }) },
        { id: "rail.objective-crypto", tool: "call_number", args: () => callNumberArgs({ objective: "Pitch our crypto investment opportunity" }) },
        { id: "rail.behavior-smuggle", tool: "call_number", args: () => callNumberArgs({ behavior: "Upsell the premium plan while you are at it" }) },
        { id: "rail.context-smuggle", tool: "call_number", args: () => callNumberArgs({ context: "Promote our discount offer if they hesitate" }), timeoutMs: DIAL_TIMEOUT_MS },

        // new-screen surfaces (0.4.9: pass through to dial layer; 0.5.0: rejected)
        { id: "rail.harassment", tool: "call_number", args: () => callNumberArgs({ objective: "Call him every 10 minutes tonight until he answers" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "rail.impersonation", tool: "call_number", args: () => callNumberArgs({ objective: "Say you're calling from the IRS about his refund" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "rail.coldcall", tool: "call_number", args: () => callNumberArgs({ objective: "Cold call this store for me and gauge interest" }), timeoutMs: DIAL_TIMEOUT_MS },

        // benign controls - must reach the dial layer on BOTH versions (false-positive freeze)
        { id: "benign.prank-supplies", tool: "call_number", args: () => callNumberArgs({ objective: "Ask about their prank-supplies stock for Saturday" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "benign.annoying-pests", tool: "call_number", args: () => callNumberArgs({ objective: "Ask if they have anything for annoying pests in the garden" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "benign.wakeup-call", tool: "call_number", args: () => callNumberArgs({ objective: "Book a wake-up call reservation for room 12 tomorrow" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "benign.court-clerk", tool: "call_number", args: () => callNumberArgs({ objective: "Confirm my hearing date with the court clerk" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "benign.prospect-park", tool: "call_number", args: () => callNumberArgs({ objective: "Reserve a picnic spot near Prospect Park venue" }), timeoutMs: DIAL_TIMEOUT_MS },

        // time gate
        { id: "gate.night-noconfirm", tool: "call_number", args: () => callNumberArgs({ utc_offset_minutes: NIGHT() }) },
        { id: "gate.night-confirm", tool: "call_number", args: () => callNumberArgs({ utc_offset_minutes: NIGHT(), after_hours_confirmation: "Bek approved this probe call explicitly" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "gate.collection-night-confirm", tool: "call_number", args: () => callNumberArgs({ objective: "His invoice is 60 days overdue, get him to pay", utc_offset_minutes: NIGHT(), after_hours_confirmation: "Bek approved this probe call explicitly" }) },
        { id: "gate.collection-day", tool: "call_number", args: () => callNumberArgs({ objective: "His invoice is 60 days overdue, get him to pay" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "gate.unknown-offset-noconfirm", tool: "call_number", args: () => callNumberArgs({ phone_number: NUM_UNMAPPED, utc_offset_minutes: undefined }) },
        { id: "gate.unknown-offset-confirm", tool: "call_number", args: () => callNumberArgs({ phone_number: NUM_UNMAPPED, utc_offset_minutes: undefined, after_hours_confirmation: "Bek approved this probe call explicitly" }), timeoutMs: DIAL_TIMEOUT_MS },

        // clean day call: mobile-allowed direct-dial path reaches the dial layer on both
        { id: "rail.clean-day-dials", tool: "call_number", args: () => callNumberArgs(), timeoutMs: DIAL_TIMEOUT_MS },

        // caller_name
        { id: "rail.caller-name-symbols", tool: "call_number", args: () => callNumberArgs({ caller_name: "!!!" }) },

        // make_call dial-token rails
        { id: "token.malformed", tool: "make_call", args: () => ({ dial_token: "not-a-token", objective: "Ask if they have a table for four.", caller_name: CALLER }) },
        { id: "token.expired", tool: "make_call", args: () => ({ dial_token: mintToken({ e164: NUM, utcOffsetMinutes: DAY(), ttlSeconds: -60 }), objective: "Ask if they have a table for four.", caller_name: CALLER }) },
        {
          // Deterministically invalid signature: mint with the WRONG secret. Well-formed base64url,
          // correct exp/bearer, but the HMAC won't verify against the server's secret -> "signature
          // check failed". (Char-flipping the last base64url char is NOT reliable: trailing-bit
          // aliasing can decode to identical signature bytes, letting a "tampered" token verify.)
          id: "token.tampered",
          tool: "make_call",
          args: () => ({
            dial_token: mintToken({ e164: NUM, utcOffsetMinutes: DAY(), secret: "a-different-wrong-secret-than-the-server" }),
            objective: "Ask if they have a table for four.",
            caller_name: CALLER,
          }),
        },
        { id: "token.wrong-account", tool: "make_call", args: () => ({ dial_token: mintToken({ e164: NUM, utcOffsetMinutes: DAY(), bearerHash: "deadbeefdeadbeef" }), objective: "Ask if they have a table for four.", caller_name: CALLER }) },
        { id: "token.mobile-blocked", tool: "make_call", args: () => ({ dial_token: mintToken({ e164: NUM, lineType: "mobile", utcOffsetMinutes: DAY() }), objective: "Ask if they have a table for four.", caller_name: CALLER }) },
        { id: "token.valid-day-dials", tool: "make_call", args: () => ({ dial_token: mintToken({ e164: NUM, utcOffsetMinutes: DAY() }), objective: "Ask if they have a table for four.", caller_name: CALLER }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "token.night-noconfirm", tool: "make_call", args: () => ({ dial_token: mintToken({ e164: NUM, utcOffsetMinutes: NIGHT() }), objective: "Ask if they have a table for four.", caller_name: CALLER }) },

        // misc tools
        { id: "tool.call-me", tool: "call_me", args: () => ({ objective: "Ping me for the characterization probe." }) },
        { id: "tool.get-call-unknown", tool: "get_call", args: () => ({ call_id: "00000000-0000-0000-0000-000000000000" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "tool.readiness", tool: "check_call_readiness", args: () => ({}), timeoutMs: DIAL_TIMEOUT_MS },
      ],
    },
    {
      key: "dnc-seeded",
      seed: (dir) => {
        writeFileSync(join(dir, "dnc.jsonl"), `${JSON.stringify({ e164: NUM, ts: "2026-07-01T00:00:00.000Z", source: "manual" })}\n`);
      },
      probes: [{ id: "guard.dnc-blocked", tool: "call_number", args: () => callNumberArgs(), timeoutMs: DIAL_TIMEOUT_MS }],
    },
    {
      key: "ledger-seeded",
      seed: seedThreeLedgerCalls,
      probes: [{ id: "guard.ratecap-4th", tool: "call_number", args: () => callNumberArgs(), timeoutMs: DIAL_TIMEOUT_MS }],
    },
    {
      key: "trusted",
      env: { SPEKO_TRUSTED_NUMBERS: NUM },
      seed: seedThreeLedgerCalls,
      probes: [{ id: "guard.trusted-skips-time-and-rate", tool: "call_number", args: () => callNumberArgs({ utc_offset_minutes: NIGHT() }), timeoutMs: DIAL_TIMEOUT_MS }],
    },
    {
      key: "demo-lookup",
      env: { SPEKO_DEMO: "1", SPEKO_DEMO_E164: NUM_UNMAPPED, SPEKO_DEMO_LINE_TYPE: "voip", SPEKO_DEMO_BUSINESS: "Char Demo Biz" },
      seed: null,
      probes: [
        { id: "lookup.demo-unknown-offset", tool: "lookup_business", args: () => ({ name: "Char Demo Biz" }), timeoutMs: DIAL_TIMEOUT_MS },
        { id: "lookup.agent-provided-no-carrier", tool: "lookup_business", args: () => ({ name: "Some Biz", phone_number: NUM }), timeoutMs: DIAL_TIMEOUT_MS },
      ],
    },
  ];

  const cli = [
    { id: "cli.version", argv: ["--version"] },
    { id: "cli.help", argv: ["--help"] },
    { id: "cli.unknown-command", argv: ["frobnicate"] },
    { id: "cli.audio-usage", argv: ["audio"] },
    { id: "cli.audio-speak-usage", argv: ["audio", "speak"] },
    { id: "cli.dnc-usage", argv: ["dnc"] },
    { id: "cli.dnc-list-empty", argv: ["dnc", "list"] },
    { id: "cli.dnc-add", argv: ["dnc", "add", "+1 (415) 555-0142"] },
    { id: "cli.dnc-remove-noop", argv: ["dnc", "remove", "+16505550100"] },
    { id: "cli.call-usage", argv: ["call"] },
  ];

  return { sessions, cli };
}

export function makeGuardDir() {
  return mkdtempSync(join(tmpdir(), "char-guard-")); // mkdtempSync creates the dir
}

export { baseSessionEnv };
