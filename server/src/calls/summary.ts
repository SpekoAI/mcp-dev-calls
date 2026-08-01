/**
 * Shared call-summary shaping. Both the live make_call path and the get_call
 * recovery path turn (transcript + outcome + authoritative session) into the same
 * honest CallSummary: connected/answered are derived from the session, and a call
 * with no telephony leg is reported as not_connected — never as success.
 */
import { NOT_CONNECTED_STATUS } from "../constants.js";
import type { CallSummary, SessionDetail } from "../types.js";
import { detectControlTokenLeak } from "../lib/transcript.js";
import { assessConnection } from "./assess.js";

const NOT_CONNECTED_REASON =
  "No real two-way call took place — the AI agent started but the other party was never heard " +
  "(no answer, voicemail, or the call did not truly connect). If your caller-ID connected on other " +
  "calls, this is a destination-side no-answer, not a trunk problem — try again later.";
const DIAL_FAILED_REASON =
  "The outbound call leg failed to dial (a SIP/trunk or caller-ID failure), so the phone never rang. " +
  "Re-dialing will not help until the deployment's outbound trunk / caller-ID is fixed.";
const NO_ANSWER_REASON =
  "The call connected but the other party never spoke (no answer / voicemail / hung up before responding).";
const UNCONFIRMED_REASON =
  "The call ended, but its session couldn't be read to confirm a real connection and no reply from " +
  "the other party was captured — so a successful call can't be claimed here. Re-check with get_call " +
  "in a few seconds.";
const IN_PROGRESS_STATUS = "in_progress";
const IN_PROGRESS_REASON =
  "The call is still live — it hasn't ended yet, so the transcript and outcome may be incomplete. " +
  "Re-check with get_call in a few seconds.";

export interface ShapeInput {
  callId: string;
  to: string | null;
  from: string | null;
  status: string;
  transcript: unknown;
  outcome: string | null;
  transcriptError?: string;
  session: SessionDetail | null;
  /** Used only when the session has no duration (e.g. our poll elapsed, or live elapsed). */
  fallbackDuration: number;
  /**
   * true = the leg terminated on a hard dial failure (sip.dial_failed / agent.dispatch_failed) → a
   * real trunk/caller-ID failure. false/omitted = the room finished normally, so a not_connected is
   * a destination-side no-answer, NOT a trunk problem (E1: stop blaming the trunk unconditionally).
   */
  dialFailed?: boolean;
  /**
   * false = the call has NOT reached a terminal state yet (still live) → report `in_progress`
   * and never a normalized `completed`/outcome. Omitted/true = terminal (the make_call finalize
   * path only shapes once the call has ended, so it relies on the default).
   */
  isTerminal?: boolean;
}

/**
 * Attach a dashboard deep link to a summary when we have both a call_id and a base URL.
 * Immutable — returns a new summary. The dashboard route is /sessions/{id} where id === call_id.
 */
export function attachDashboardUrl(summary: CallSummary, dashboardBaseUrl: string | undefined): CallSummary {
  if (!summary.call_id || !dashboardBaseUrl) return summary;
  let end = dashboardBaseUrl.length;
  while (end > 0 && dashboardBaseUrl.charCodeAt(end - 1) === 47) end -= 1;
  const base = dashboardBaseUrl.slice(0, end);
  return { ...summary, dashboard_url: `${base}/sessions/${summary.call_id}` };
}

export function shapeCallSummary(input: ShapeInput): CallSummary {
  const assessment = assessConnection(input.session, input.transcript);
  const connected = assessment.connected !== false; // false only when proven no leg
  const sessionDuration =
    typeof input.session?.durationSeconds === "number" ? input.session.durationSeconds : null;
  const controlTokenLeak = detectControlTokenLeak(input.transcript);

  // Still live: the call hasn't reached a terminal event yet. Report it honestly as in_progress
  // (with a live/elapsed duration) instead of force-normalizing to completed/0s/outcome — a live
  // transcript already has a user turn, which would otherwise read as a finished, successful call.
  if (input.isTerminal === false) {
    const live: CallSummary = {
      status: IN_PROGRESS_STATUS,
      call_id: input.callId,
      duration_seconds: sessionDuration ?? input.fallbackDuration,
      connected,
      answered: assessment.answered,
      caller_id: input.from,
      dialed_number: input.to,
      outcome: null,
      transcript: input.transcript,
      reason: IN_PROGRESS_REASON,
    };
    if (input.transcriptError !== undefined) live.transcript_error = input.transcriptError;
    if (controlTokenLeak) live.receptionist_control_token_leak = true;
    return live;
  }

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
  if (controlTokenLeak) summary.receptionist_control_token_leak = true;

  if (assessment.connected === false) {
    summary.status = NOT_CONNECTED_STATUS;
    summary.reason = input.dialFailed ? DIAL_FAILED_REASON : NOT_CONNECTED_REASON;
  } else if (assessment.connected === null && !assessment.answered) {
    // Session unreadable AND no caller turn captured → we can't confirm a real connection, so don't
    // imply the phone rang ("no_answer"). Report it honestly as unconfirmed (not_connected).
    summary.status = NOT_CONNECTED_STATUS;
    summary.reason = UNCONFIRMED_REASON;
    summary.connected = false;
    summary.duration_seconds = 0;
    summary.outcome = null;
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
