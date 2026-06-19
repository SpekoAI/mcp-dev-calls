/**
 * Connection assessment — the truth layer. A Speko `status: "ended"` does NOT mean
 * a phone rang: the platform creates a LiveKit room + LLM agent (which emits the
 * greeting) even when no outbound SIP leg is established. The only reliable proof a
 * real call reached the carrier is the session's `phoneCall.callControlId` plus
 * carrier usage rows. We distinguish three things make_call used to conflate:
 *   - connected: an outbound telephony leg actually reached the carrier
 *   - answered:  the remote party actually spoke (a non-agent transcript turn)
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
  // A real outbound call always has a callControlId; carrier minutes are extra proof.
  const connected = Boolean(callControlId) || carrierBilled || answered;
  return { connected, answered, callControlId, carrierBilled };
}
