/**
 * Shared constants — ported from the Python reference (SpekoAI/platform#582:
 * call_tools.py / dial_token.py) and the prior single-package scaffold. The
 * safety values (line types, objective block-list, after-hours gate, dial-token TTL)
 * are the compliance moat; keep them in sync with the platform.
 */

export const VERSION = "0.2.0";

// ── Disclosure (non-overridable opening line) ────────────────────────────────
export const DISCLOSURE_PREFIX = "Hi, this is an AI assistant calling on behalf of ";

// ── Call duration / polling ──────────────────────────────────────────────────
export const MAX_CALL_SECONDS = 300;
export const MIN_CALL_SECONDS = 30;

export const FAST_POLLS = 5;
export const FAST_POLL_SECONDS = 2;
// Back off after the first ~10s so a long (up to MAX_CALL_SECONDS) call doesn't hammer the events
// endpoint every 2s — the early polls catch fast failures, the slow rate carries a live call.
export const SLOW_POLL_SECONDS = 10;

// voice.dial returns "dialing" on a real dial or "dialing-stub" when the
// deployment has no SIP/telephony configured (call NOT placed → never poll/retry).
export const STUB_DIAL_STATUS = "dialing-stub";
export const NOT_PLACED_STATUS = "not_placed";
// Dial looked accepted ("dialing"), but the authoritative session shows no SIP leg
// ever formed (callControlId null, zero carrier minutes) → the phone never rang.
export const NOT_CONNECTED_STATUS = "not_connected";

// Outbound calls debit prepaid credits; readiness warns below this.
export const MIN_CALL_BALANCE_USD = 0.5;

// GENUINE call endings. NOTE: "failed"/"error" are deliberately EXCLUDED — the platform
// flips the call status to "failed" the instant a first-audio SLA times out (~10-15s), even
// when the call is still live and a full conversation follows. Finalizing on "failed" was
// reporting working calls as not_connected. We instead wait for the room teardown event.
export const HARD_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "ended",
  "no_answer",
  "no-answer",
  "busy",
  "canceled",
  "cancelled",
  "hangup",
]);

// The authoritative "the call is really over" signals from GET /v1/calls/{id}/events.
export const ROOM_END_EVENTS: ReadonlySet<string> = new Set(["room_finished", "call.end_tool.completed"]);

// When the phone leg dies, LiveKit closes the recording egress's audio source immediately and the
// platform stores an `egress_ended` event whose failure_cause/payload says "Source closed" — measured
// 11.5-21.3s BEFORE room_finished on 5/5 live outbound calls (the worker idles out its ~20s
// departureTimeout before tearing the room down). Matched defensively over the whole serialized
// event, since the marker can sit in failure_cause or inside the raw LiveKit payload.
export const EGRESS_SOURCE_CLOSED_RE = /source[\s_-]*closed/i;
// Bounded confirm window after a source-closed egress_ended: at least this much wall clock (with
// polls at most EGRESS_CONFIRM_POLL_SECONDS apart inside it) before the call may finalize without
// room_finished. A poll COUNT is the wrong unit here — in the fast-poll phase 2 polls span only
// ~4s, too short to tell "callee thinking" from "call dead". See runPhoneCallInner for why
// egress_ended alone must never finalize.
export const EGRESS_CONFIRM_WINDOW_SECONDS = 10;
export const EGRESS_CONFIRM_POLL_SECONDS = 5;

// The platform writes the call report (summary/outcome) moments AFTER room teardown; observed
// production call 212be4fb had the analysis pass land more than ~6s after teardown. Wait at most
// this many short polls for a SUBSTANTIVE report outcome — the row can land with a bare status word
// (the platform's heuristic pass) before analysis rewrites it, so row presence alone doesn't stop
// the wait. Bounded, so a report/outcome that never comes can't block termination.
export const REPORT_GRACE_POLLS = 4;
// The other half of the finalize grace budget: the sleep between finalize-time re-reads, shared by
// the transcript-lag retries and the report-grace polls (same retry cadence for both).
export const FINALIZE_RETRY_MS = 3000;

// Genuine non-recoverable failures (the agent never dispatched / the SIP dial failed). Unlike a
// first-audio timeout, these never recover, so stop polling immediately.
export const HARD_FAILURE_EVENTS: ReadonlySet<string> = new Set(["agent.dispatch_failed", "sip.dial_failed"]);

export const OUTCOME_MARKER = "OUTCOME:";

// Cap on the last-agent-line snippet embedded in the "unconfirmed (no report)" fallback
// outcome label - long enough to carry the resolution, short enough to stay a headline.
export const FALLBACK_OUTCOME_SNIPPET_CHARS = 140;

// The platform call-report `outcome` sometimes carries a bare status word (e.g. "failed",
// "completed") rather than a real transactional answer. On a connected call that reads as a
// misleading headline ("outcome: failed" on a call that worked), so these are filtered out and
// we fall back to a transcript OUTCOME: marker / the transcript itself.
export const BARE_OUTCOME_RE =
  /^(failed|abandoned|completed?|error|no[_-]?answer|busy|canceled|cancelled|ended|success|unknown|in[_-]?progress|dialing)$/i;

// voice.dial requires agentId or intent; ad-hoc calls pin a minimal intent.
export const DIAL_INTENT_LANGUAGE = "en";

// Base proper-noun/vocab hints to bias the STT (merged with caller + business name
// at call time). Casing matters for proper nouns.
export const DIAL_STT_KEYWORDS = ["reservation", "table for", "tonight", "8 PM"] as const;

// ── Validation bounds ────────────────────────────────────────────────────────
export const MAX_CALLER_NAME_CHARS = 80;
export const OBJECTIVE_MIN_CHARS = 8;

// Keep in sync with the E.164 regex across the codebase.
export const E164_RE = /^\+[1-9]\d{6,14}$/;

// ── Line types & dialing predicates ──────────────────────────────────────────
export const ALLOWED_LINE_TYPES: ReadonlySet<string> = new Set([
  "landline",
  "fixedVoip",
  "nonFixedVoip",
  "tollFree",
  "voip",
]);

export const US_PREMIUM_RE = /^\+1(900|976)\d{7}$/;
export const EMERGENCY_NUMBERS: ReadonlySet<string> = new Set([
  "+911",
  "+1911",
  "+112",
  "+999",
  "+988",
  "+1988",
]);

// ── Objective screen (block-list wins over transactional wording) ────────────
export const OBJECTIVE_BLOCK_RE =
  /\bsell\b|sales pitch|promot|discount|sponsor|advertis|marketing|survey|donat|fundrais|vote|campaign|debt|warranty|crypto|investment|persuad|convinc|solicit|upsell|telemarket|\bcold.?call\b|\bprospect(?:ing|s)?\s+(?:call|list|for)\b|\blead.?gen(?:eration)?\b|\bsales outreach\b/i;

export const HARASSMENT_BLOCK_RE =
  /\b(?:harass|prank(?:\s+(?:call|him|her|them|my))|threat(?:en|s)?|intimidat\w*|revenge|get back at|stalk\w*|(?:to|keep)\s+annoy(?:ing)?|mess with\s+(?:him|her|them|my)|wake\s+(?:him|her|them)\s+up|humiliat\w*|embarrass\w*|(?:repeatedly|repeated)\s+call|call\s+(?:\S+\s+){0,3}repeatedly|keep\s+(?:calling|dialing|phoning)(?:\s+\S+)?\s+until|call\s+(?:(?:him|her|them|it)\s+)?every\s+\d+\s*(?:minutes|mins|hours)|scare\s+(?:him|her|them|my)|teach\s+(?:him|her|them|my\s+\w+)\s+a\s+lesson)\b/i;

export const IMPERSONATION_BLOCK_RE =
  /\b(?:pretend\s+(?:to\s+be|you'?re|that)|impersonat\w*|pos(?:e|ing)\s+as|pretext|claim(?:ing)?\s+to\s+be|say\s+(?:you'?re|i'?m|we'?re)\s+(?:from|with|calling\s+from)|(?:you'?re|i'?m|we'?re|he'?s|she'?s)\s+(?:from|with)\s+the\s+(?:irs|fbi|ssa|social security|medicare|police|sheriff|court|government|immigration|ice)\b)/i;

export const COLLECTION_RE =
  /\b(?:owes?|overdue|past.?due|collect\s+(?:a\s+)?payment|pay\s+(?:his|her|their|the|an?)\s+(?:bill|invoice|balance)|money\s+(?:he|she|they)\s+owes?|debt)\b/i;

// ── Dial token ───────────────────────────────────────────────────────────────
export const DIAL_TOKEN_DEFAULT_TTL_SECONDS = 900;
export const DIAL_TOKEN_SECRET_ENV = "SPEKO_DIAL_TOKEN_SECRET";

// ── After-hours gate (destination local) ─────────────────────────────────────
export const AFTER_HOURS_START_HOUR = 21;
export const AFTER_HOURS_END_HOUR = 8;
export const MIN_AFTER_HOURS_CONFIRMATION_CHARS = 5;

// ── Per-number rate caps ─────────────────────────────────────────────────────
export const RATE_CAP_PER_NUMBER_HOUR = 3;
export const RATE_CAP_PER_NUMBER_DAY = 8;

// ── Actionable next-step guidance (embedded in API errors → tool errors) ─────
export const LOOKUP_BUSINESS_NEXT_STEP =
  "Pass a non-empty business name and an optional location, " +
  "for example lookup_business(name=\"Joe's Pizza\", location='New York').";

export const MAKE_CALL_NEXT_STEP =
  "Run lookup_business(name, location) to mint a fresh dial_token, then call " +
  "make_call(dial_token=..., objective='Do you have a table for 4 at 8pm?', caller_name='<human name>').";

export const MAKE_CALL_DIAL_NEXT_STEP =
  "The dial request was rejected. If this is a caller-ID/telephony configuration error " +
  "(no caller ID or SIP configured), run check_call_readiness — re-running lookup_business cannot fix it. " +
  "Otherwise run lookup_business to mint a fresh dial_token and retry make_call.";

export const CHECK_READINESS_NEXT_STEP =
  "Run check_call_readiness for a read-only report of auth, credit balance, and outbound caller-ID before placing a call.";

export const AUTH_NEXT_STEP =
  "Check the demo server's SPEKO_API_KEY (set it in the repo-root .env) and retry.";
