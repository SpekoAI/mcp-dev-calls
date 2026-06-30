/**
 * Shared call-summary shaping. Both the live make_call path and the get_call
 * recovery path turn (transcript + outcome + authoritative session) into the same
 * honest CallSummary: connected/answered are derived from the session, and a call
 * with no telephony leg is reported as not_connected — never as success.
 */
import { NOT_CONNECTED_STATUS } from "../constants.js";
import type { CallSummary, SessionDetail } from "../types.js";
import { assessConnection } from "./assess.js";

const NOT_CONNECTED_REASON =
  "No real two-way call took place — the AI agent started but the other party was never heard " +
  "(no answer, voicemail, or the call did not truly connect).";
const NO_ANSWER_REASON =
  "The call connected but the other party never spoke (no answer / voicemail / hung up before responding).";

export interface ShapeInput {
  callId: string;
  to: string | null;
  from: string | null;
  status: string;
  transcript: unknown;
  outcome: string | null;
  transcriptError?: string;
  session: SessionDetail | null;
  /** Used only when the session has no duration (e.g. our poll elapsed). */
  fallbackDuration: number;
}

export function shapeCallSummary(input: ShapeInput): CallSummary {
  const assessment = assessConnection(input.session, input.transcript);
  const connected = assessment.connected !== false; // false only when proven no leg
  const sessionDuration =
    typeof input.session?.durationSeconds === "number" ? input.session.durationSeconds : null;

  const summary: CallSummary = {
    status: input.status,
    call_id: input.callId,
    duration_seconds: connected ? (sessionDuration ?? input.fallbackDuration) : 0,
    connected,
    answered: assessment.answered,
    caller_id: input.from,
    dialed_number: input.to,
    outcome: connected ? input.outcome : null,
    transcript: input.transcript,
  };
  if (input.transcriptError !== undefined) summary.transcript_error = input.transcriptError;

  if (assessment.connected === false) {
    summary.status = NOT_CONNECTED_STATUS;
    summary.reason = NOT_CONNECTED_REASON;
  } else if (connected && !assessment.answered) {
    // Connected but the other party never spoke (voicemail / no pickup). Normalize the status
    // so a stale "dialing" never leaks through (the event-driven poll loop doesn't refresh it).
    summary.status = "no_answer";
    summary.reason = NO_ANSWER_REASON;
  } else if (connected && assessment.answered) {
    // The platform can mark a call "failed" (a first-audio SLA flag) even when a full
    // conversation happened. A call the other party actually spoke on IS a completed call —
    // normalize so we never surface "failed" for a real two-way conversation.
    summary.status = "completed";
  }
  return summary;
}
