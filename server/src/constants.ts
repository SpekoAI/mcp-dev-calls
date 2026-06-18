/**
 * Shared constants — ported from the Python reference (SpekoAI/platform#582:
 * call_tools.py / dial_token.py) and the prior single-package scaffold. The
 * safety values (line types, objective block-list, quiet hours, dial-token TTL)
 * are the compliance moat; keep them in sync with the platform.
 */

export const VERSION = "0.1.0";

// ── Disclosure (non-overridable opening line) ────────────────────────────────
export const DISCLOSURE_PREFIX = "Hi, this is an AI assistant calling on behalf of ";

// ── Call duration / polling ──────────────────────────────────────────────────
export const MAX_CALL_SECONDS = 300;
export const MIN_CALL_SECONDS = 30;

export const FAST_POLLS = 5;
export const FAST_POLL_SECONDS = 2;
export const SLOW_POLL_SECONDS = 5;

// voice.dial returns "dialing" on a real dial or "dialing-stub" when the
// deployment has no SIP/telephony configured (call NOT placed → never poll/retry).
export const STUB_DIAL_STATUS = "dialing-stub";
export const NOT_PLACED_STATUS = "not_placed";

// Outbound calls debit prepaid credits; readiness warns below this.
export const MIN_CALL_BALANCE_USD = 0.5;

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "ended",
  "failed",
  "no_answer",
  "no-answer",
  "busy",
  "canceled",
  "cancelled",
  "error",
  "hangup",
]);

export const OUTCOME_MARKER = "OUTCOME:";

// voice.dial requires agentId or intent; ad-hoc calls pin a minimal intent.
export const DIAL_INTENT_LANGUAGE = "en";

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
  /\bsell\b|sales pitch|promot|discount|sponsor|advertis|marketing|survey|donat|fundrais|vote|campaign|debt|warranty|crypto|investment/i;

// ── Dial token ───────────────────────────────────────────────────────────────
export const DIAL_TOKEN_DEFAULT_TTL_SECONDS = 900;
export const DIAL_TOKEN_SECRET_ENV = "SPEKO_DIAL_TOKEN_SECRET";

// ── Quiet hours (destination local) ──────────────────────────────────────────
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

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
