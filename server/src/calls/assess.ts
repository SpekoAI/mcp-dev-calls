/**
 * Connection assessment — the truth layer. A Speko `status` of "ended"/"failed" does NOT by
 * itself tell you whether a real call happened: the platform spins up a LiveKit room + LLM
 * agent even when nothing connects, and conversely flags a LIVE call "failed" on a first-audio
 * timeout. On this deployment `phoneCall.callControlId` and carrier-usage rows are structurally
 * null/zero even on SUCCESSFUL calls, so they are WEAK signals. The STRONG, reliable proof that
 * a real two-way call happened is a transcript turn from the other party (source='user'). We
 * distinguish three things make_call used to conflate:
 *   - answered:  the remote party actually spoke (a non-agent transcript turn) — the ground truth
 *   - connected: a real leg formed (answered, with callControlId/carrier as weak corroboration)
 *   - outcome:   what was accomplished, only meaningful once answered
 */
import { extractReply } from "../lib/transcript.js";
import type { SessionDetail } from "../types.js";

// Carrier/telephony usage providers + metric hints. `speko/session_seconds` and
// `openai/llm_tokens` are the AGENT running, not a phone call — they must NOT count.
const CARRIER_PROVIDERS: ReadonlySet<string> = new Set(["telnyx", "twilio", "plivo", "livekit", "sip", "carrier"]);
const CARRIER_METRIC_RE = /telephony|pstn|\bsip\b|carrier|call[_-]?(seconds|minutes)|dial|outbound[_-]?minutes/i;

function isCarrierUsage(u: { provider?: string; metric?: string } | null | undefined): boolean {
  if (!u) return false;
  if (CARRIER_PROVIDERS.has(String(u.provider ?? "").toLowerCase())) return true;
  return CARRIER_METRIC_RE.test(String(u.metric ?? ""));
}

export interface ConnectionAssessment {
  /** true = leg reached carrier; false = proven no leg; null = could not determine (no session). */
  connected: boolean | null;
  /** Remote party actually spoke. */
  answered: boolean;
  callControlId: string | null;
  carrierBilled: boolean;
}

export function assessConnection(session: SessionDetail | null, transcript: unknown): ConnectionAssessment {
  const answered = extractReply(transcript) !== null;
  if (!session) {
    return { connected: null, answered, callControlId: null, carrierBilled: false };
  }
  const ccidRaw = session.phoneCall?.callControlId;
  const callControlId = typeof ccidRaw === "string" && ccidRaw.trim() ? ccidRaw : null;
  const carrierBilled = Array.isArray(session.usage) && session.usage.some(isCarrierUsage);
  // `answered` (a caller turn) is the ground truth; callControlId/carrier only corroborate and
  // are often absent even on real calls here, so connected falls back to answered.
  const connected = answered || Boolean(callControlId) || carrierBilled;
  return { connected, answered, callControlId, carrierBilled };
}
