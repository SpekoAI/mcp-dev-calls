/**
 * get_call — recovery / diagnosis. Re-derives an honest CallSummary for an existing
 * call_id WITHOUT re-dialing: reads the call detail (transcript, outcome, to/from
 * from metadata) plus the authoritative session, and shapes the same summary
 * make_call would. Safe to call repeatedly; never places a call.
 */
import { AUTH_NEXT_STEP, HARD_FAILURE_EVENTS, ROOM_END_EVENTS } from "../constants.js";
import { AppError } from "../lib/errors.js";
import { eventType } from "../lib/events.js";
import { bestOutcome, extractEndCallReason } from "../lib/transcript.js";
import {
  readOwnerCallBinding,
  readOwnerProfile,
  releaseOwnerCallLeaseByCallId,
} from "../owner/state.js";
import { isAuthFailure, type SpekoClient } from "../speko/client.js";
import type { CallSummary, SessionDetail } from "../types.js";
import {
  callMeMetadata,
  decorateCallMeSummary,
  isCallMeTerminal,
} from "./callMeResult.js";
import { attachDashboardUrl, shapeCallSummary } from "./summary.js";

function strField(md: Record<string, unknown> | undefined, key: string): string | null {
  const v = md?.[key];
  return typeof v === "string" && v ? v : null;
}

function eventTypeSet(events: Array<Record<string, unknown>>): Set<string> {
  return new Set(events.map(eventType));
}

export async function describeCall(
  callId: string,
  client: SpekoClient,
  dashboardBaseUrl?: string,
  ownerStateDir?: string,
): Promise<CallSummary> {
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
  // Finished-call re-check: no grace loop to protect here, so the end_call reason is a
  // safe last fallback after the report and the OUTCOME marker.
  const outcome = bestOutcome(detail.report, transcript) ?? extractEndCallReason(transcript);

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
  const types = eventTypeSet(events);
  const hardFailure = [...HARD_FAILURE_EVENTS].some((t) => types.has(t));
  const isTerminal = [...ROOM_END_EVENTS].some((t) => types.has(t)) || hardFailure || endedAt !== null;
  // A hard-failure event (sip.dial_failed / agent.dispatch_failed) means a real trunk/caller-ID
  // failure — so a not_connected here must blame the trunk, matching make_call for the same call
  // (without this, get_call always reported a destination-side no-answer instead — E1 parity).
  const dialFailed = hardFailure;

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

  const summary = attachDashboardUrl(
    shapeCallSummary({
      callId,
      to,
      from,
      status,
      transcript,
      outcome,
      session,
      fallbackDuration,
      isTerminal,
      dialFailed,
    }),
    dashboardBaseUrl,
  );
  const ownerMetadata = callMeMetadata(detail.metadata as Record<string, unknown> | undefined);
  if (isCallMeTerminal(summary.status)) {
    try {
      releaseOwnerCallLeaseByCallId(callId, { dir: ownerStateDir });
    } catch {
      // A corrupt local owner ledger must not break ordinary get_call results. It only prevents
      // promotion into trusted owner fields below.
    }
  }
  let binding: ReturnType<typeof readOwnerCallBinding>;
  try {
    binding = readOwnerCallBinding(callId, { dir: ownerStateDir });
  } catch {
    return summary;
  }
  const owner = readOwnerProfile(ownerStateDir);
  const bindingMatches = Boolean(
    ownerMetadata &&
      binding &&
      owner &&
      binding.instanceId === owner.instance_id &&
      binding.ownerPhone === owner.owner_phone &&
      to === owner.owner_phone &&
      ownerMetadata.instanceId === binding.instanceId &&
      ownerMetadata.mode === binding.mode &&
      ownerMetadata.message === binding.message &&
      ownerMetadata.context === binding.context,
  );
  if (!bindingMatches || !binding) return summary;
  const decorated = decorateCallMeSummary(summary, {
    mode: binding.mode,
    message: binding.message,
    context: binding.context,
    instanceId: binding.instanceId,
  });
  return decorated;
}
