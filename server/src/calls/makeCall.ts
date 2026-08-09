/**
 * make_call backing logic. Verifies the dial token, RE-CHECKS every safety rail
 * server-side (defense in depth — never trust that lookup already checked), builds
 * the disclosed first message + hard-ruled system prompt, then dials and polls
 * api.speko.dev via @spekoai/sdk until the call reaches a terminal state.
 */
import { createHash } from "node:crypto";
import type { VoiceDialParams } from "@spekoai/sdk";
import { allowedProvidersFromPins, type AppConfig } from "../config.js";
import {
  DIAL_TOKEN_DEFAULT_TTL_SECONDS,
  AUTH_NEXT_STEP,
  DIAL_INTENT_LANGUAGE,
  DIAL_STT_KEYWORDS,
  EGRESS_CONFIRM_POLL_SECONDS,
  EGRESS_CONFIRM_WINDOW_SECONDS,
  EGRESS_SOURCE_CLOSED_RE,
  FALLBACK_OUTCOME_SNIPPET_CHARS,
  FAST_POLLS,
  FAST_POLL_SECONDS,
  FINALIZE_RETRY_MS,
  HARD_FAILURE_EVENTS,
  HARD_TERMINAL_STATUSES,
  MAKE_CALL_DIAL_NEXT_STEP,
  MAKE_CALL_NEXT_STEP,
  MAX_CALL_SECONDS,
  MIN_CALL_SECONDS,
  NOT_PLACED_STATUS,
  REPORT_GRACE_POLLS,
  ROOM_END_EVENTS,
  SLOW_POLL_SECONDS,
  STUB_DIAL_STATUS,
} from "../constants.js";
import { AppError, RejectionError } from "../lib/errors.js";
import { eventType } from "../lib/events.js";
import {
  bestOutcome,
  calleeTurns,
  countTranscriptTurns,
  extractEndCallReason,
  extractReply,
  lastAgentTurnText,
} from "../lib/transcript.js";
import {
  DialTokenError,
  afterHoursGateReason,
  dialBlockedReason,
  lineTypeBlockedReason,
  verifyDialToken,
} from "../safety/dialToken.js";
import {
  behaviorBlockedReason,
  collectionMatch,
  contextBlockedReason,
  objectiveBlockedReason,
} from "../safety/objective.js";
import {
  appendDialLedger,
  dncAdd,
  dncReason,
  normalizeE164,
  rateCapReason,
  scanCalleeTurnsForOptOut,
} from "../safety/guard.js";
import { buildFirstMessage, buildSystemPrompt, sanitizeName } from "../safety/prompt.js";
import { MAX_CALLER_NAME_CHARS } from "../constants.js";
import { ensureDialAgent, resetDialAgent } from "../speko/agent.js";
import { isAuthFailure, SpekoApiError, type SpekoClient } from "../speko/client.js";
import type { CallSummary, MakeCallInput, SessionDetail } from "../types.js";
import { assessConnection } from "./assess.js";
import { attachDashboardUrl, shapeCallSummary } from "./summary.js";

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type VoiceDialParamsWithTurnHandling = VoiceDialParams & {
  turnHandling?: { greetFirst?: boolean };
};

/**
 * Resolve the outbound caller-ID to dial `from`. An explicit config value wins;
 * otherwise pick the account's first outbound-ready owned number (preferring a
 * bidirectional/outbound line over an inbound-only one). Returns undefined when
 * nothing is resolvable, so the dial can still fall back to the deployment's
 * server-side default if one exists.
 */
async function resolveFromNumber(deps: MakeCallDeps): Promise<string | undefined> {
  if (deps.cfg.fromNumber) return deps.cfg.fromNumber;
  let numbers;
  try {
    numbers = await deps.client.listPhoneNumbers();
  } catch {
    return undefined;
  }
  const ready = numbers.filter(
    (n) => Boolean(n.setupStatus?.outboundReady) && typeof n.e164 === "string" && n.e164.length > 0,
  );
  const preferred = ready.find((n) => n.direction === "both" || n.direction === "outbound");
  return (preferred ?? ready[0])?.e164 ?? undefined;
}

export interface MakeCallDeps {
  client: SpekoClient;
  cfg: AppConfig;
  bearerHash: string;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock source for the poll-loop wait cap (tests inject one tied to their fake sleep). */
  now?: () => number;
  /**
   * Server-side ONLY — set by the direct-dial (`call_number`) path, which is itself
   * gated by cfg.allowDirectDial. Skips the business-lines-only check so personal calls
   * can ring mobiles. NEVER plumbed from agent-supplied input, so the business make_call
   * tool can't use it to bypass the mobile block.
   */
  allowAnyLineType?: boolean;
  /** Internal owner/OTP calls must never inherit SPEKO_TRUSTED_NUMBERS exemptions. */
  forceFullRails?: boolean;
  /** Internal verification calls only: possession flow is user-initiated and may skip the time gate. */
  skipAfterHoursGate?: boolean;
  /** Internal prompt overrides. Never populated from an MCP request body. */
  firstMessageOverride?: string;
  systemPromptOverride?: (endCallTool: boolean) => string;
  /** Internal metadata used to recover call_me semantics through get_call. */
  metadataSource?: string;
  metadataExtra?: Record<string, string | number | boolean | null>;
  /** Return immediately after the platform supplies a real call id. */
  returnAfterDial?: boolean;
  /** Runs once immediately before the first platform dial (used for the OTP-call ledger). */
  beforeDial?: () => void;
  /** Runs immediately after the platform returns a call id, before polling or returning. */
  onDialAccepted?: (callId: string) => void;
  /** Internal: set only by makeCall so runPhoneCall unit tests do not write guard state. */
  afterHoursConfirmationForLedger?: string | null;
}

function turnHandlingForCall(input: MakeCallInput, cfg: AppConfig): VoiceDialParamsWithTurnHandling["turnHandling"] | undefined {
  // Explicit per-call value wins (false MUST be sent — the worker default is ON);
  // omitted falls back to the env-gated fleet default.
  if (typeof input.greetFirst === "boolean") return { greetFirst: input.greetFirst };
  return cfg.dialGreetFirst !== false ? { greetFirst: true } : undefined;
}

function afterHoursNextStep(opts: {
  direct: boolean;
  offset: number | null;
  collectionMatched: boolean;
}): string {
  const tool = opts.direct ? "call_number" : "make_call";
  if (opts.collectionMatched) {
    if (opts.offset == null) {
      return opts.direct
        ? "Re-run call_number with utc_offset_minutes for the destination's city so the FDCPA 8am-9pm window can be verified."
        : "Run lookup_business with utc_offset_minutes to mint a token whose destination-local time can be verified, then retry make_call.";
    }
    return `Wait until the destination is inside the FDCPA 8am-9pm local-time window, then retry ${tool}.`;
  }
  const confirm =
    `Re-run ${tool} with after_hours_confirmation set to the human's own words confirming they want to place this call now.`;
  if (opts.offset == null && opts.direct) {
    return (
      `${confirm} If you know the destination's timezone, you can instead pass utc_offset_minutes ` +
      "(e.g. -420 US Pacific summer, -300 US Eastern)."
    );
  }
  return confirm;
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

  const normalizedE164 = normalizeE164(e164);
  const trusted = !deps.forceFullRails && (deps.cfg.trustedNumbers ?? []).includes(normalizedE164);

  const dnc = dncReason(e164, deps.cfg.guardStateDir);
  if (dnc) {
    throw new RejectionError(
      dnc,
      `Run speko dnc list to review local do-not-call entries, or speko dnc remove ${normalizedE164} to remove this number before retrying.`,
    );
  }

  if (!deps.allowAnyLineType) {
    const lineReason = lineTypeBlockedReason(
      typeof payload.line_type === "string" ? payload.line_type : null,
    );
    if (lineReason) throw new RejectionError(lineReason, MAKE_CALL_NEXT_STEP);
  }

  const offset = typeof payload.utc_offset_minutes === "number" ? payload.utc_offset_minutes : null;
  if (!trusted) {
    const rateReason = rateCapReason(e164, {
      dir: deps.cfg.guardStateDir,
      perHour: deps.cfg.rateCapPerNumberHour,
      perDay: deps.cfg.rateCapPerNumberDay,
    });
    if (rateReason) {
      throw new RejectionError(
        rateReason,
        "Retry after the wait time shown in the rate-cap message, when the oldest counted attempt ages out.",
      );
    }

    if (!deps.skipAfterHoursGate) {
      const collectionMatched = collectionMatch([input.objective, input.behavior, input.context]);
      const afterHoursReason = afterHoursGateReason(
        offset,
        input.afterHoursConfirmation,
        collectionMatched,
      );
      if (afterHoursReason) {
        throw new RejectionError(
          afterHoursReason,
          afterHoursNextStep({ direct: deps.allowAnyLineType === true, offset, collectionMatched }),
        );
      }
    }
  }

  const objectiveReason = objectiveBlockedReason(input.objective);
  if (objectiveReason) {
    throw new RejectionError(
      objectiveReason,
      "Rewrite the objective as a single transactional question and retry make_call.",
    );
  }

  // The behavior channel is private steering, never spoken — but it must not become a bypass for
  // the no-sell/no-spam objective screen, so screen it too (empty behavior is fine).
  const behaviorReason = behaviorBlockedReason(input.behavior);
  if (behaviorReason) {
    throw new RejectionError(
      behaviorReason,
      "Remove any selling/harassment/impersonation instructions from behavior and retry make_call.",
    );
  }

  const contextReason = contextBlockedReason(input.context);
  if (contextReason) {
    throw new RejectionError(
      contextReason,
      "Remove any selling/harassment/impersonation instructions from context and retry make_call.",
    );
  }

  const rawCaller = typeof input.callerName === "string" ? input.callerName.trim() : "";
  if (!rawCaller || rawCaller.length > MAX_CALLER_NAME_CHARS) {
    throw new RejectionError(
      `Invalid caller_name: pass the human's name as a non-empty string of at most ${MAX_CALLER_NAME_CHARS} characters`,
      MAKE_CALL_NEXT_STEP,
    );
  }
  // Reduce to a real name (strips symbols and any smuggled second sentence) so it can't inject
  // spoken content into the disclosure opener or a fake rule line into the system prompt.
  const caller = sanitizeName(rawCaller);
  if (!caller) {
    throw new RejectionError(
      "Invalid caller_name: provide the human's name using letters (it was empty after removing symbols).",
      MAKE_CALL_NEXT_STEP,
    );
  }

  // Every rail has passed — now the replay guard. Placed last so a rejected call never
  // registers a fingerprint, and a duplicate is only ever compared against a REAL dial.
  const replayKey = dialFingerprint(e164, input.objective);
  const now = Date.now();
  for (const [key, entry] of dialReplayCache) {
    if (entry.expiresAt <= now) dialReplayCache.delete(key);
  }
  const priorDial = dialReplayCache.get(replayKey);
  if (priorDial) {
    throw new RejectionError(
      "This exact call — same number and objective — was already placed moments ago" +
        (priorDial.callId ? ` as call_id '${priorDial.callId}'` : "") +
        "; dialing again would ring the same person twice for the same ask.",
      priorDial.callId
        ? `Do not re-dial. Check the existing call with get_call('${priorDial.callId}').`
        : "Do not re-dial. The first attempt is still being placed; wait a moment and check recent calls with get_call.",
    );
  }
  dialReplayCache.set(replayKey, {
    callId: null,
    expiresAt: now + DIAL_TOKEN_DEFAULT_TTL_SECONDS * 1000,
  });

  const businessName =
    typeof payload.business_name === "string" && payload.business_name
      ? payload.business_name
      : "the business";
  const durationCap = clamp(input.maxDurationSeconds ?? MAX_CALL_SECONDS, MIN_CALL_SECONDS, MAX_CALL_SECONDS);

  // Both pre-dial lookups are independent; resolve them together. ensureDialAgent
  // re-verifies and repairs the dial agent's live row on EVERY dial (a dashboard
  // edit — endCall off, a pinned voice, a re-attached KB tool — must not ride into
  // this call) and is FAIL-OPEN (null after a bounded wait), so it can never block
  // a dial.
  const [fromNumber, dialAgentId] = await Promise.all([resolveFromNumber(deps), ensureDialAgent(deps)]);

  // agentId is rebuilt per attempt (see the retry below), and the prompt's rule set must
  // mirror it: the end_call instructions are emitted ONLY when the endCall-enabled agent
  // rides along, because that's what makes the worker register the hangup tool.
  const buildBody = (agentId: string | null): VoiceDialParams => {
    const turnHandling = turnHandlingForCall(input, deps.cfg);
    const body: VoiceDialParamsWithTurnHandling = {
      to: e164,
      ...(fromNumber ? { from: fromNumber } : {}),
      // The persisted "speko-mcp-dial" agent exists solely to enable the worker's end_call
      // hangup tool; every field below overrides the agent's defaults per-call.
      ...(agentId ? { agentId } : {}),
      // optimizeFor=latency is best for a LIVE call: it routes to a fast streaming STT + a low
      // time-to-first-token LLM, avoiding the multi-second dead air the balanced/accuracy modes
      // introduce. The actual LLM/TTS/STT models are pinned below via constraints
      // (cfg.llmPin / cfg.ttsPin / cfg.sttPin), not left to the selector.
      intent: { language: DIAL_INTENT_LANGUAGE, optimizeFor: deps.cfg.optimizeFor },
      // A specific `voice` (cfg.voice) is safe ONLY because it's an ElevenLabs voice matching the
      // ElevenLabs TTS pin below — always verify a voice with scripts/verify-tts.mjs first. A voice
      // id from a different provider (Cartesia/OpenAI) routes wrong and produces SILENT audio.
      ...(deps.cfg.voice ? { voice: deps.cfg.voice } : {}),
      constraints: { allowedProviders: allowedProvidersFromPins(deps.cfg) },
      sttOptions: { keywords: [caller, businessName, ...DIAL_STT_KEYWORDS] },
      ttsOptions: { speed: deps.cfg.ttsSpeed ?? 1.0 },
      llm: { temperature: 0.5, maxTokens: 100 },
      firstMessage: deps.firstMessageOverride ?? buildFirstMessage(caller, input.objective),
      systemPrompt:
        deps.systemPromptOverride?.(agentId != null) ??
        buildSystemPrompt(
          input.objective,
          input.context ?? null,
          businessName,
          caller,
          input.behavior ?? null,
          agentId != null,
        ),
      metadata: {
        source: deps.metadataSource ?? "speko-mcp-calls-demo",
        objective: input.objective,
        business_name: businessName,
        ...(deps.metadataExtra ?? {}),
        // Persist to/from so get_call can report dialed_number/caller_id (CallDetail has no top-level
        // to/from; the poll/recovery path reads them back from metadata).
        to: e164,
        from: fromNumber ?? null,
      },
      // Narrow local extension until the SpekoAI/platform PR adding turnHandling.greetFirst
      // lands in @spekoai/sdk's VoiceDialParams type.
      ...(turnHandling ? { turnHandling } : {}),
      telephony: { amd: { mode: "agent" } },
    };
    return body;
  };

  let beforeDialRecorded = false;
  const beforeDialOnce = (): void => {
    if (beforeDialRecorded) return;
    // Mark the callback independently so a later ordinary-ledger write failure cannot repeat a
    // side-effectful OTP reservation during the deleted-agent retry path.
    beforeDialRecorded = true;
    deps.beforeDial?.();
    appendDialLedger(
      {
        e164,
        call_id: null,
        after_hours_confirmation: input.afterHoursConfirmation ?? undefined,
      },
      deps.cfg.guardStateDir,
    );
  };

  const placeCall = async (agentId: string | null): Promise<CallSummary> =>
    attachDashboardUrl(
      await runPhoneCall(
        buildBody(agentId),
        durationCap,
        {
          ...deps,
          // wait:false is the agent-facing form of returnAfterDial: hand back the call_id the
          // moment the platform accepts the dial (every pre-dial rail above has already run, and
          // the replay guard below still registers the real call_id before this function returns)
          // so an MCP host with a short tool-call timeout never has to retry a live dial.
          returnAfterDial: deps.returnAfterDial === true || input.wait === false,
          // `placeCall` can run twice only when a deleted persisted agent makes the first
          // platform request fail before a phone leg exists. Guard both local ledgers so one
          // invocation still consumes exactly one ordinary attempt and one OTP attempt.
          beforeDial: beforeDialOnce,
          afterHoursConfirmationForLedger: undefined,
        },
        sleep,
      ),
      deps.cfg.dashboardBaseUrl,
    );

  try {
    let summary: CallSummary;
    try {
      summary = await placeCall(dialAgentId);
    } catch (e) {
      // The dial agent can be deleted out-of-band (dashboard cleanup) in the window
      // between the pre-dial verify and the dial itself; the platform then 404s
      // (AGENT_NOT_FOUND). Same fail-open stance as bootstrap: drop the cached id and
      // place this call agentless (no auto-hangup), with the prompt rebuilt to match.
      if (dialAgentId != null && e instanceof AppError && e.code === "AGENT_NOT_FOUND") {
        resetDialAgent();
        console.error(`[dial-agent] agent ${dialAgentId} gone at dial time; retrying without auto-hangup`);
        summary = await placeCall(null);
      } else {
        throw e;
      }
    }
    // A real dial happened — remember its id so a duplicate attempt can point the agent at it.
    dialReplayCache.set(replayKey, {
      callId: summary.call_id,
      expiresAt: now + DIAL_TOKEN_DEFAULT_TTL_SECONDS * 1000,
    });
    return summary;
  } catch (e) {
    // The dial itself failed — evict so a genuine retry isn't locked out by the guard.
    dialReplayCache.delete(replayKey);
    throw e;
  }
}

/** A CallSummary skeleton with the honest defaults (nothing connected/answered yet). */
function baseSummary(callId: string | null, to: string | null, from: string | null): CallSummary {
  return {
    status: "",
    call_id: callId,
    duration_seconds: 0,
    connected: false,
    answered: false,
    caller_id: from,
    dialed_number: to,
    outcome: null,
    transcript: null,
  };
}

/**
 * True for a serialized `egress_ended` event that says the recording's audio source closed
 * (the phone leg died). The marker can sit in `failure_cause` ("Source closed") or inside the
 * raw LiveKit payload, so match over the whole serialized event.
 */
function isSourceClosedEgressEnd(e: Record<string, unknown>): boolean {
  if (eventType(e) !== "egress_ended") return false;
  try {
    return EGRESS_SOURCE_CLOSED_RE.test(JSON.stringify(e));
  } catch {
    return false;
  }
}

/**
 * Dial replay guard (issue #37 M3): an in-process fingerprint cache so a RETRIED dial —
 * an agent re-invoking make_call/call_number after a timeout — can't ring the same person
 * twice for the same ask. Fingerprint = number + normalized objective (deliberately NOT the
 * dial token: call_number mints a fresh token per attempt, which would defeat the guard).
 * Entries live for the dial-token TTL; a dial that fails outright is evicted so a genuine
 * retry is never locked out. Best-effort and in-process by design — the platform-side
 * Idempotency-Key remains the v1.0 fix (docs/ROADMAP.md).
 */
const dialReplayCache = new Map<string, { callId: string | null; expiresAt: number }>();

function dialFingerprint(e164: string, objective: string): string {
  const normalizedObjective = (objective ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${e164}|${normalizedObjective}`, "utf-8").digest("hex");
}

/** Test hook — clears the replay cache (mirrors resetDialAgent). */
export function resetDialReplayGuard(): void {
  dialReplayCache.clear();
}

let callInFlight = false;

export async function runPhoneCall(
  body: VoiceDialParams,
  maxSeconds: number,
  deps: MakeCallDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<CallSummary> {
  // Serialize guard — OFF by default. Platform per-call room isolation (#903) shipped and was
  // verified under concurrency (#37 M4: simultaneous dials get distinct rooms + clean audio), so
  // this is now an opt-in kill switch: SPEKO_SERIALIZE_CALLS=1 re-enables one-call-at-a-time.
  const serialize = deps.cfg.serializeCalls === true;
  if (serialize && callInFlight) {
    throw new RejectionError(
      "A call is already in progress on this MCP session, so this one wasn't placed — this deployment " +
        "has serialized calls turned on (SPEKO_SERIALIZE_CALLS=1), so only one call runs at a time here.",
      "Wait for the current call to finish (check it with get_call), then place the next one. To allow " +
        "concurrent calls, unset SPEKO_SERIALIZE_CALLS (concurrent dials get isolated per-call rooms).",
    );
  }
  if (serialize) callInFlight = true;
  try {
    return await runPhoneCallInner(body, maxSeconds, deps, sleep);
  } finally {
    if (serialize) callInFlight = false;
  }
}

/**
 * egress_ended fast-path lifecycle: idle (no source-closed egress seen yet) -> armed (confirm
 * window open, carrying the wall-clock arm time and the frozen-turn baseline) -> done (stood
 * down or consumed; the events list is cumulative, so the fast-path never re-arms).
 */
type EgressFastPath =
  | { phase: "idle" }
  | { phase: "armed"; atSeconds: number; turns: number }
  | { phase: "done" };

function isTurnHandlingSchema400(e: unknown): boolean {
  const status =
    e instanceof SpekoApiError
      ? e.status
      : typeof (e as { status?: unknown } | null)?.status === "number"
        ? ((e as { status: number }).status)
        : null;
  if (status !== 400) return false;
  // The platform's zod handler puts the offending key only in the response `issues` array; the
  // SDK's SpekoApiError keeps just `error` ("Invalid request") + `code` ("VALIDATION_ERROR"), so
  // the key name never reaches the message. Any 400 VALIDATION_ERROR on a body that carried
  // turnHandling is worth ONE keyless retry: if the 400 was about something else, the retry
  // fails identically and that error surfaces. The message test stays for servers that do name keys.
  const message = e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? "");
  if (/\b(?:turnHandling|greetFirst)\b/i.test(message)) return true;
  const code = e instanceof SpekoApiError ? e.code : (e as { code?: unknown } | null)?.code;
  return code === "VALIDATION_ERROR";
}

function omitTurnHandling(body: VoiceDialParams): VoiceDialParams {
  const { turnHandling: _turnHandling, ...retryBody } = body as VoiceDialParamsWithTurnHandling;
  return retryBody;
}

function dialFailure(e: unknown): AppError {
  const authFail = isAuthFailure(e);
  return new AppError((e as Error).message, {
    statusCode: authFail ? 401 : 502,
    nextStep: authFail ? AUTH_NEXT_STEP : MAKE_CALL_DIAL_NEXT_STEP,
    // Preserve the platform's machine code (e.g. AGENT_NOT_FOUND) so makeCall can
    // recover from a deleted dial agent instead of failing every call until restart.
    ...(e instanceof SpekoApiError ? { code: e.code } : {}),
  });
}

async function runPhoneCallInner(
  body: VoiceDialParams,
  maxSeconds: number,
  deps: MakeCallDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<CallSummary> {
  const to = body.to ?? null;
  let dial;
  try {
    deps.beforeDial?.();
    if (deps.afterHoursConfirmationForLedger !== undefined && to) {
      appendDialLedger(
        {
          e164: to,
          call_id: null,
          after_hours_confirmation: deps.afterHoursConfirmationForLedger ?? undefined,
        },
        deps.cfg.guardStateDir,
      );
    }
    try {
      dial = await deps.client.dial(body);
    } catch (e) {
      const sentTurnHandling = (body as VoiceDialParamsWithTurnHandling).turnHandling !== undefined;
      if (!sentTurnHandling || !isTurnHandlingSchema400(e)) throw e;
      console.error("[dial] platform rejected turnHandling.greetFirst; retrying without turnHandling");
      dial = await deps.client.dial(omitTurnHandling(body));
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw dialFailure(e);
  }

  const callId = dial.sessionId || null;
  const from = typeof dial.from === "string" && dial.from ? dial.from : (body.from ?? null);
  let status = String(dial.status ?? "").toLowerCase();
  const dialCallControlId = String(dial.callControlId ?? "").trim();

  // Diagnostic log — stderr, NEVER stdout: in single-process mode this runs inside the
  // MCP server, whose stdout is reserved for JSON-RPC frames.
  console.error(
    `[dial] session=${callId ?? "-"} status=${status} callControlId=${dialCallControlId || "(none)"} to=${to ?? "-"} from=${from ?? "-"}`,
  );

  // No telephony leg at dial time: stub deployment OR no call-control id returned →
  // the platform never created an outbound SIP call, so nothing will ring.
  if (status === STUB_DIAL_STATUS || !dialCallControlId) {
    return {
      ...baseSummary(callId, to, from),
      status: NOT_PLACED_STATUS,
      reason:
        "The dial was accepted but no telephony leg was created (no outbound SIP trunk / caller-ID configured " +
        "for this deployment), so the phone never rang.",
    };
  }
  if (callId == null) {
    throw new AppError(
      "Speko returned a dial response with no session id; the call may not have been placed.",
      { statusCode: 502, nextStep: "Do not assume a call is in flight; check recent calls before retrying." },
    );
  }

  try {
    deps.onDialAccepted?.(callId);
  } catch (error) {
    throw new AppError(`The call was accepted, but its local recovery binding could not be saved: ${(error as Error).message}`, {
      statusCode: 502,
      nextStep: `Do not dial again; call '${callId}' may be in progress. Inspect it with get_call('${callId}').`,
    });
  }

  if (deps.returnAfterDial) {
    return {
      ...baseSummary(callId, to, from),
      status: "dialing",
      reason: "The call was placed and is continuing in the background.",
      next_step: `Poll get_call('${callId}') until it reaches a terminal status. Do not place another call.`,
    };
  }

  // Poll until the call REALLY ends. The platform flips `status` to "failed" the moment a
  // first-audio SLA times out (~10-15s) even when the call is live and a full conversation
  // follows — so the authoritative end signal is the room-teardown EVENT, not the status.
  // (Finalizing on the premature "failed" was reporting working calls as not_connected.)
  // Wall clock, not summed sleep intervals: every iteration also spends real time in the API
  // calls below, so summing intervals understated elapsed and stretched the wait cap far past
  // maxSeconds under API latency.
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const elapsedSeconds = (): number => Math.round((now() - startedAtMs) / 1000);
  let polls = 0;
  let ended = false;
  let hardFailed = false;
  // `armed.atSeconds` is in elapsedSeconds() units (wall clock), so the confirm window is
  // measured in real time, not in elastic poll counts.
  let egress: EgressFastPath = { phase: "idle" };
  while (elapsedSeconds() < maxSeconds) {
    const baseInterval = polls < FAST_POLLS ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS;
    // Inside the egress confirm window poll faster, so a dead leg is confirmed soon after
    // the window's wall-clock minimum even during the slow-poll phase.
    const interval =
      egress.phase === "armed" ? Math.min(baseInterval, EGRESS_CONFIRM_POLL_SECONDS) : baseInterval;
    await sleep(interval * 1000);
    polls += 1;

    let events: Array<Record<string, unknown>> | null = null;
    try {
      events = await deps.client.getEvents(callId);
    } catch {
      // Events endpoint hiccup — the session endedAt check below still runs this iteration
      // (before this restructure it was skipped, so a hiccup could hide an ended call), and
      // the call-status fallback after it keeps us from hanging silently.
    }

    if (events !== null) {
      const types = new Set(events.map(eventType));
      // Room teardown = the call is genuinely over; a hard failure (agent never dispatched /
      // SIP dial failed) never recovers. A bare "failed" status without these is ignored.
      const roomEnded = [...ROOM_END_EVENTS].some((t) => types.has(t));
      const hardFailure = [...HARD_FAILURE_EVENTS].some((t) => types.has(t));
      if (roomEnded || hardFailure) {
        ended = true;
        hardFailed = hardFailure; // sip.dial_failed / agent.dispatch_failed → a real trunk failure (E1)
        break;
      }
    }

    // Cheap redundancy, NOT an early signal: endedAt is stamped by the platform AT room
    // teardown (measured 0.5s apart from room_finished on live calls — these dials go out via
    // LiveKit SIP, so the Telnyx call.hangup webhook never fires for them and nothing stamps
    // endedAt early). It is kept so a missed/failed events read still ends the loop. The EARLY
    // end signals are call.end_tool.completed (agent hangs up; in ROOM_END_EVENTS) and the
    // egress_ended fast-path below (phone leg died; the room drains ~20s before room_finished).
    // endedAt, never `status` — the platform flips status to "failed" prematurely on a
    // first-audio SLA while the call is still live.
    try {
      const session = await deps.client.getSession(callId);
      if (typeof session.endedAt === "string" && session.endedAt) {
        ended = true;
        break;
      }
    } catch {
      // Best effort — the events loop above remains the primary end signal.
    }

    if (events === null) {
      // Events endpoint hiccup — fall back to the call status so we never hang silently.
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
      if (HARD_TERMINAL_STATUSES.has(status)) {
        ended = true;
        break;
      }
    }

    // egress_ended fast-path: when the phone leg dies, LiveKit closes the recording egress's
    // audio source at once ("Source closed"), 11.5-21.3s BEFORE room_finished (measured on 5/5
    // live calls — the worker idles out its ~20s departureTimeout before tearing the room down).
    // But an egress can also die MID-CALL from a recording failure while the conversation
    // continues, so egress_ended alone must NEVER finalize. Instead: arm a confirm window of at
    // least EGRESS_CONFIRM_WINDOW_SECONDS of wall clock (a poll count is too elastic — 2 fast
    // polls span only ~4s, not enough to tell "callee thinking" from "call dead"). If a real end
    // signal (room_finished / endedAt / a hard status) lands meanwhile, the checks above finalize
    // normally. The fast-path itself finalizes ONLY on frozen evidence: a readable turn count
    // that has not grown since the egress died — then a call report row (normally written at
    // teardown) shortens the frozen wait, and otherwise the window's expiry ends it. The report
    // alone never finalizes: reports can exist on live calls (see the platform's unguarded
    // POST /calls/:id/report/finalize), so new turns during the window — or a turn count we
    // cannot read — mean the fast-path can't prove the call is over: stand down for good and
    // rely on the normal end signals.
    if (egress.phase === "armed") {
      try {
        const detail = await deps.client.getCall(callId);
        const turnsNow = countTranscriptTurns(detail.transcript);
        if (turnsNow === null || turnsNow > egress.turns) {
          egress = { phase: "done" };
        } else if (
          detail.report != null ||
          elapsedSeconds() - egress.atSeconds >= EGRESS_CONFIRM_WINDOW_SECONDS
        ) {
          ended = true;
          break;
        }
      } catch {
        // Couldn't read this poll — no evidence either way; the window stays armed and the
        // next poll retries (fast-finalizing always requires a successful frozen read).
      }
    } else if (egress.phase === "idle" && events !== null && events.some(isSourceClosedEgressEnd)) {
      let turns: number | null;
      try {
        const detail = await deps.client.getCall(callId);
        turns = countTranscriptTurns(detail.transcript);
      } catch {
        turns = null;
      }
      // Arm only with a readable baseline: a turn count we couldn't read (endpoint error or an
      // unrecognized transcript shape) can never prove the transcript went quiet, so the
      // fast-path stands down instead of finalizing on missing evidence.
      egress = turns !== null ? { phase: "armed", atSeconds: elapsedSeconds(), turns } : { phase: "done" };
    }
  }

  if (!ended) {
    return {
      ...baseSummary(callId, to, from),
      status: "timeout",
      duration_seconds: elapsedSeconds(),
      connected: true,
      reason: "Reached the wait limit before the call ended; it may still be in progress.",
    };
  }

  return finalize(callId, to, from, status, elapsedSeconds(), deps, hardFailed);
}

/**
 * Turn a terminal call into an honest summary: pull the transcript + outcome, then
 * read the authoritative session to decide whether a real telephony leg ever formed.
 * A platform "ended" with no SIP leg (no callControlId, no carrier minutes, no caller
 * turn) is reported as not_connected — never as a successful call.
 */
async function finalize(
  callId: string,
  to: string | null,
  from: string | null,
  status: string,
  elapsed: number,
  deps: MakeCallDeps,
  dialFailed: boolean,
): Promise<CallSummary> {
  const sleep = deps.sleep ?? defaultSleep;
  let transcript: unknown = null;
  let transcriptError: string | undefined;
  let outcome: string | null = null;
  let anyReadOk = false;
  const readDetail = async (): Promise<void> => {
    try {
      const detail = await deps.client.getCall(callId);
      transcript = detail.transcript ?? null;
      outcome = bestOutcome(detail.report, transcript);
      anyReadOk = true;
      transcriptError = undefined;
    } catch (e) {
      // A refresh failing after an earlier successful read must not brand the summary with
      // transcript_error — we already hold a real transcript.
      if (!anyReadOk) transcriptError = (e as Error).message;
    }
  };
  // The transcript can lag the room-teardown event by a moment; re-fetch briefly until the
  // caller's turns appear (or attempts run out) so a real conversation isn't under-reported
  // as not_connected just because we read it a beat too early.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await readDetail();
    if (extractReply(transcript) !== null) break;
    if (attempt < 2) await sleep(FINALIZE_RETRY_MS);
  }
  // Report-grace: the platform's report (the substantive outcome label) is written moments
  // AFTER room teardown, so finalizing instantly can race it and degrade the outcome to a
  // transcript scrape. Row presence isn't the gate — the platform's heuristic pass can write
  // the row with a bare status word ("completed") before analysis rewrites the real outcome —
  // so wait up to REPORT_GRACE_POLLS short polls for a SUBSTANTIVE outcome from EITHER source.
  // An OUTCOME: marker already scraped from the transcript is the agent's own explicit statement,
  // so there is nothing left to wait for (the common happy path skips the grace entirely).
  // Bounded, because a substantive outcome that never comes (analysis disabled/failed) must
  // never block termination; the transcript extraction above then stands. Skipped entirely on a
  // hard dial failure: a call that never connected can never produce a report or transcript
  // outcome, so the grace would only delay the failure report.
  if (!dialFailed) {
    for (let attempt = 0; !outcome && attempt < REPORT_GRACE_POLLS; attempt += 1) {
      await sleep(FINALIZE_RETRY_MS);
      await readDetail();
    }
  }
  // Only after the grace is done waiting: the end_call tool's reason is a decent outcome
  // ("exact requested time not available, offered 9pm instead") but it exists from the first
  // read, so folding it into bestOutcome would short-circuit the grace loop above and lock in
  // a worse label than the substantive report about to land.
  if (!outcome) outcome = extractEndCallReason(transcript);

  let session: SessionDetail | null = null;
  try {
    session = await deps.client.getSession(callId);
  } catch {
    // Best effort — without it we can't disprove a connection, so we don't claim one failed.
  }

  if (!outcome) {
    // Connection evidence for the last-resort label: the assessment's `connected` when the
    // session was readable, else its `answered` (callee turns), which assessConnection
    // computes from the transcript even when getSession failed - so a session-read outage
    // never silently bypasses the fallback on a call the transcript proves was two-way.
    const assessment = assessConnection(session, transcript);
    if (assessment.connected === true || assessment.answered) {
      const text = lastAgentTurnText(transcript);
      if (text) {
        // Last-resort label for the immediate make_call response. get_call re-derives a clean
        // report outcome on later reads once the platform analysis row lands. Inner double
        // quotes become single quotes so the label's delimiters stay balanced.
        outcome = `unconfirmed (no report): last agent line: "${text.slice(0, FALLBACK_OUTCOME_SNIPPET_CHARS).replaceAll('"', "'")}"`;
      }
    }
  }

  try {
    if (to) {
      const turns = calleeTurns(transcript);
      if (turns) {
        const optOut = scanCalleeTurnsForOptOut(turns);
        if (optOut.matched) {
          dncAdd(
            to,
            { source: "auto", call_id: callId, ...(optOut.phrase ? { phrase: optOut.phrase } : {}) },
            deps.cfg.guardStateDir,
          );
        }
      }
    }
  } catch {
    // Opt-out detection is best-effort and must never break finalization.
  }

  const summary = shapeCallSummary({
    callId,
    to,
    from,
    status,
    transcript,
    outcome,
    transcriptError,
    session,
    fallbackDuration: elapsed,
    dialFailed,
  });
  console.error(
    `[result] session=${callId} platformStatus=${status} -> reported=${summary.status} connected=${summary.connected} answered=${summary.answered}`,
  );
  return summary;
}
