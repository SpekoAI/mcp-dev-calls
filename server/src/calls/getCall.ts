/**
 * get_call — recovery / diagnosis. Re-derives an honest CallSummary for an existing
 * call_id WITHOUT re-dialing: reads the call detail (transcript, outcome, to/from
 * from metadata) plus the authoritative session, and shapes the same summary
 * make_call would. Safe to call repeatedly; never places a call.
 */
import { AUTH_NEXT_STEP } from "../constants.js";
import { AppError } from "../lib/errors.js";
import { extractOutcome } from "../lib/transcript.js";
import { isAuthFailure, type SpekoClient } from "../speko/client.js";
import type { CallSummary, SessionDetail } from "../types.js";
import { shapeCallSummary } from "./summary.js";

function strField(md: Record<string, unknown> | undefined, key: string): string | null {
  const v = md?.[key];
  return typeof v === "string" && v ? v : null;
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
  const reportOutcome = detail.report?.outcome;
  const outcome =
    typeof reportOutcome === "string" && reportOutcome.trim() ? reportOutcome.trim() : extractOutcome(transcript);

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
    fallbackDuration: typeof detail.duration_seconds === "number" ? detail.duration_seconds : 0,
  });
}
