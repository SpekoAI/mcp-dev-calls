/**
 * make_call backing logic. Verifies the dial token, RE-CHECKS every safety rail
 * server-side (defense in depth — never trust that lookup already checked), builds
 * the disclosed first message + hard-ruled system prompt, then dials and polls
 * api.speko.dev via @spekoai/sdk until the call reaches a terminal state.
 */
import type { VoiceDialParams } from "@spekoai/sdk";
import type { AppConfig } from "../config.js";
import {
  AUTH_NEXT_STEP,
  DIAL_INTENT_LANGUAGE,
  FAST_POLLS,
  FAST_POLL_SECONDS,
  MAKE_CALL_DIAL_NEXT_STEP,
  MAKE_CALL_NEXT_STEP,
  MAX_CALL_SECONDS,
  MIN_CALL_SECONDS,
  NOT_PLACED_STATUS,
  SLOW_POLL_SECONDS,
  STUB_DIAL_STATUS,
  TERMINAL_STATUSES,
} from "../constants.js";
import { AppError, RejectionError } from "../lib/errors.js";
import { extractOutcome } from "../lib/transcript.js";
import {
  DialTokenError,
  dialBlockedReason,
  lineTypeBlockedReason,
  quietHoursReason,
  verifyDialToken,
} from "../safety/dialToken.js";
import { objectiveBlockedReason } from "../safety/objective.js";
import { buildFirstMessage, buildSystemPrompt } from "../safety/prompt.js";
import { MAX_CALLER_NAME_CHARS } from "../constants.js";
import { isAuthFailure, type SpekoClient } from "../speko/client.js";
import type { CallSummary, MakeCallInput } from "../types.js";

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MakeCallDeps {
  client: SpekoClient;
  cfg: AppConfig;
  bearerHash: string;
  sleep?: (ms: number) => Promise<void>;
}

export async function makeCall(input: MakeCallInput, deps: MakeCallDeps): Promise<CallSummary> {
  const sleep = deps.sleep ?? defaultSleep;

  let payload;
  try {
    payload = verifyDialToken(input.dialToken, {
      expectedBearerHash: deps.bearerHash,
      secret: deps.cfg.dialTokenSecret,
    });
  } catch (e) {
    const msg = e instanceof DialTokenError ? e.message : String(e);
    throw new RejectionError(msg, MAKE_CALL_NEXT_STEP);
  }

  const e164 = typeof payload.e164 === "string" ? payload.e164 : "";
  const dialReason = dialBlockedReason(e164);
  if (dialReason) throw new RejectionError(dialReason, MAKE_CALL_NEXT_STEP);

  const lineReason = lineTypeBlockedReason(
    typeof payload.line_type === "string" ? payload.line_type : null,
  );
  if (lineReason) throw new RejectionError(lineReason, MAKE_CALL_NEXT_STEP);

  const offset = typeof payload.utc_offset_minutes === "number" ? payload.utc_offset_minutes : null;
  const quietReason = quietHoursReason(offset);
  if (quietReason) {
    const next =
      offset == null
        ? MAKE_CALL_NEXT_STEP
        : "Wait until destination business hours (08:00-21:00 local time) and run make_call again.";
    throw new RejectionError(quietReason, next);
  }

  const objectiveReason = objectiveBlockedReason(input.objective);
  if (objectiveReason) {
    throw new RejectionError(
      objectiveReason,
      "Rewrite the objective as a single transactional question and retry make_call.",
    );
  }

  const caller = typeof input.callerName === "string" ? input.callerName.trim() : "";
  if (!caller || caller.length > MAX_CALLER_NAME_CHARS) {
    throw new RejectionError(
      `Invalid caller_name: pass the human's name as a non-empty string of at most ${MAX_CALLER_NAME_CHARS} characters`,
      MAKE_CALL_NEXT_STEP,
    );
  }

  const businessName =
    typeof payload.business_name === "string" && payload.business_name
      ? payload.business_name
      : "the business";
  const durationCap = clamp(input.maxDurationSeconds ?? MAX_CALL_SECONDS, MIN_CALL_SECONDS, MAX_CALL_SECONDS);

  const body: VoiceDialParams = {
    to: e164,
    intent: { language: DIAL_INTENT_LANGUAGE },
    firstMessage: buildFirstMessage(caller),
    systemPrompt: buildSystemPrompt(input.objective, input.context ?? null, businessName, caller),
    metadata: {
      source: "speko-mcp-calls-demo",
      objective: input.objective,
      business_name: businessName,
    },
    telephony: { amd: { mode: "agent" } },
  };

  return runPhoneCall(body, durationCap, deps, sleep);
}

async function runPhoneCall(
  body: VoiceDialParams,
  maxSeconds: number,
  deps: MakeCallDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<CallSummary> {
  let dial;
  try {
    dial = await deps.client.dial(body);
  } catch (e) {
    const authFail = isAuthFailure(e);
    throw new AppError((e as Error).message, {
      statusCode: authFail ? 401 : 502,
      nextStep: authFail ? AUTH_NEXT_STEP : MAKE_CALL_DIAL_NEXT_STEP,
    });
  }

  const callId = dial.sessionId || null;
  let status = String(dial.status ?? "").toLowerCase();

  if (status === STUB_DIAL_STATUS) {
    return { status: NOT_PLACED_STATUS, call_id: callId, duration_seconds: 0, outcome: null, transcript: null };
  }
  if (callId == null) {
    throw new AppError(
      "Speko returned a dial response with no session id; the call may not have been placed.",
      { statusCode: 502, nextStep: "Do not assume a call is in flight; check recent calls before retrying." },
    );
  }

  let elapsed = 0;
  let polls = 0;
  while (!TERMINAL_STATUSES.has(status) && elapsed < maxSeconds) {
    const interval = polls < FAST_POLLS ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS;
    await sleep(interval * 1000);
    elapsed += interval;
    polls += 1;
    try {
      const d = await deps.client.getCall(callId);
      status = String(d.status ?? "").toLowerCase();
    } catch (e) {
      // Already dialed: never advise a retry (would re-dial); hand back the call_id.
      throw new AppError((e as Error).message, {
        statusCode: 502,
        nextStep: `Do not dial again; the call (call_id '${callId}') may still be in progress. Check it with get_call('${callId}').`,
      });
    }
  }

  if (!TERMINAL_STATUSES.has(status)) {
    return { status: "timeout", call_id: callId, duration_seconds: elapsed, outcome: null, transcript: null };
  }

  let transcript: unknown = null;
  let transcriptError: string | undefined;
  let outcome: string | null = null;
  try {
    const detail = await deps.client.getCall(callId);
    transcript = detail.transcript ?? null;
    const reportOutcome = detail.report?.outcome;
    outcome =
      typeof reportOutcome === "string" && reportOutcome.trim() ? reportOutcome.trim() : extractOutcome(transcript);
  } catch (e) {
    transcriptError = (e as Error).message;
  }

  const summary: CallSummary = {
    status,
    call_id: callId,
    duration_seconds: elapsed,
    outcome,
    transcript,
  };
  if (transcriptError !== undefined) summary.transcript_error = transcriptError;
  return summary;
}
