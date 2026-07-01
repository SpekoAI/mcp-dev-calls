/**
 * get_call — recovery / diagnosis. Re-derives an honest CallSummary for an existing
 * call_id WITHOUT re-dialing: reads the call detail (transcript, outcome, to/from
 * from metadata) plus the authoritative session, and shapes the same summary
 * make_call would. Safe to call repeatedly; never places a call.
 */
import { AUTH_NEXT_STEP, BARE_OUTCOME_RE, HARD_FAILURE_EVENTS, ROOM_END_EVENTS } from "../constants.js";
import { AppError } from "../lib/errors.js";
import { extractOutcome } from "../lib/transcript.js";
import { isAuthFailure, type SpekoClient } from "../speko/client.js";
import type { CallSummary, SessionDetail } from "../types.js";
import { shapeCallSummary } from "./summary.js";

function strField(md: Record<string, unknown> | undefined, key: string): string | null {
  const v = md?.[key];
  return typeof v === "string" && v ? v : null;
}

/** True if the event timeline shows a room teardown or a hard failure — the call genuinely ended. */
function hasTerminalEvent(events: Array<Record<string, unknown>>): boolean {
  const types = new Set(events.map((e) => String(e.event_type ?? e.type ?? "").toLowerCase()));
  return [...ROOM_END_EVENTS].some((t) => types.has(t)) || [...HARD_FAILURE_EVENTS].some((t) => types.has(t));
}

export async function describeCall(callId: string, client: SpekoClient): Promise<CallSummary> {
  let detail;
  try {
    detail = await client.getCall(callId);
  } catch (e) {
    const authFail = isAuthFailure(e);
    throw new AppError((e as Error).message, {
      statusCode: authFail ? 401 : 502,
      nextStep: authFail ? AUTH_NEXT_STEP : `Could not load call '${callId}'. Verify the call_id and retry.`,
    });
  }

  const status = String(detail.status ?? "").toLowerCase();
  const transcript = detail.transcript ?? null;
  const to = strField(detail.metadata, "to") ?? strField(detail.metadata, "dialedNumber");
  const from = strField(detail.metadata, "from");
  const reportOutcome = typeof detail.report?.outcome === "string" ? detail.report.outcome.trim() : "";
  // Ignore bare platform status words ("failed"/"completed"/...); prefer a substantive outcome
  // or a transcript OUTCOME: marker.
  const substantive = reportOutcome && !BARE_OUTCOME_RE.test(reportOutcome) ? reportOutcome : "";
  const outcome = substantive || extractOutcome(transcript);

  // Terminality — AUTHORITATIVE signals only. The platform flips `status` to "failed" on a
  // first-audio SLA timeout while the call is still LIVE, so status must NOT be trusted here
  // (that was the bug: a live call read as completed/0s). A room-teardown/hard-failure event or a
  // populated `ended_at` are the real "the call ended" signals; absent both, the call is still live.
  let events: Array<Record<string, unknown>> = [];
  try {
    events = await client.getEvents(callId);
  } catch {
    // Best effort — fall back to `ended_at` below.
  }
  const endedAt = typeof detail.ended_at === "string" && detail.ended_at ? detail.ended_at : null;
  const isTerminal = hasTerminalEvent(events) || endedAt !== null;

  // Duration: the platform value when terminal; otherwise live elapsed from created_at so a live
  // call never reports a bogus 0 that looks finished.
  const createdMs = typeof detail.created_at === "string" ? Date.parse(detail.created_at) : NaN;
  const liveElapsed = Number.isFinite(createdMs) ? Math.max(0, Math.round((Date.now() - createdMs) / 1000)) : 0;
  const fallbackDuration = isTerminal
    ? typeof detail.duration_seconds === "number"
      ? detail.duration_seconds
      : 0
    : liveElapsed;

  let session: SessionDetail | null = null;
  try {
    session = await client.getSession(callId);
  } catch {
    // Best effort.
  }

  return shapeCallSummary({
    callId,
    to,
    from,
    status,
    transcript,
    outcome,
    session,
    fallbackDuration,
    isTerminal,
  });
}
