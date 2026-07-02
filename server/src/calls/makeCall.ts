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
  BARE_OUTCOME_RE,
  DIAL_INTENT_LANGUAGE,
  DIAL_STT_KEYWORDS,
  FAST_POLLS,
  FAST_POLL_SECONDS,
  HARD_FAILURE_EVENTS,
  HARD_TERMINAL_STATUSES,
  MAKE_CALL_DIAL_NEXT_STEP,
  MAKE_CALL_NEXT_STEP,
  MAX_CALL_SECONDS,
  MIN_CALL_SECONDS,
  NOT_PLACED_STATUS,
  ROOM_END_EVENTS,
  SLOW_POLL_SECONDS,
  STUB_DIAL_STATUS,
} from "../constants.js";
import { AppError, RejectionError } from "../lib/errors.js";
import { extractOutcome, extractReply } from "../lib/transcript.js";
import {
  DialTokenError,
  dialBlockedReason,
  lineTypeBlockedReason,
  quietHoursReason,
  verifyDialToken,
} from "../safety/dialToken.js";
import { behaviorBlockedReason, objectiveBlockedReason } from "../safety/objective.js";
import { buildFirstMessage, buildSystemPrompt, sanitizeName } from "../safety/prompt.js";
import { MAX_CALLER_NAME_CHARS } from "../constants.js";
import { ensureDialAgent, resetDialAgent } from "../speko/agent.js";
import { isAuthFailure, SpekoApiError, type SpekoClient } from "../speko/client.js";
import type { CallSummary, MakeCallInput, SessionDetail } from "../types.js";
import { attachDashboardUrl, shapeCallSummary } from "./summary.js";

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /**
   * Server-side ONLY — set by the direct-dial (`call_number`) path, which is itself
   * gated by cfg.allowDirectDial. Skips the business-lines-only check so personal calls
   * can ring mobiles. NEVER plumbed from agent-supplied input, so the business make_call
   * tool can't use it to bypass the mobile block.
   */
  allowAnyLineType?: boolean;
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

  if (!deps.allowAnyLineType) {
    const lineReason = lineTypeBlockedReason(
      typeof payload.line_type === "string" ? payload.line_type : null,
    );
    if (lineReason) throw new RejectionError(lineReason, MAKE_CALL_NEXT_STEP);
  }

  const offset = typeof payload.utc_offset_minutes === "number" ? payload.utc_offset_minutes : null;
  const quietReason = quietHoursReason(offset);
  if (quietReason) {
    // Path-aware recovery: the call_number (direct) path has no dial_token to re-mint, so guide
    // it back to call_number + utc_offset_minutes rather than lookup_business/make_call.
    const direct = deps.allowAnyLineType === true;
    const next =
      offset == null
        ? direct
          ? "Re-run call_number with utc_offset_minutes for the destination's city (e.g. -420 US Pacific summer, -300 US Eastern)."
          : MAKE_CALL_NEXT_STEP
        : `Wait until destination business hours (08:00-21:00 local time) and run ${direct ? "call_number" : "make_call"} again.`;
    throw new RejectionError(quietReason, next);
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
      "Remove any selling/promotion/survey/fundraising instructions from behavior and retry make_call.",
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

  const businessName =
    typeof payload.business_name === "string" && payload.business_name
      ? payload.business_name
      : "the business";
  const durationCap = clamp(input.maxDurationSeconds ?? MAX_CALL_SECONDS, MIN_CALL_SECONDS, MAX_CALL_SECONDS);

  // Both pre-dial lookups are independent; resolve them together. ensureDialAgent is
  // FAIL-OPEN (null after a bounded wait), so agent bootstrap can never block a dial.
  const [fromNumber, dialAgentId] = await Promise.all([resolveFromNumber(deps), ensureDialAgent(deps)]);

  // agentId is rebuilt per attempt (see the retry below), and the prompt's rule set must
  // mirror it: the end_call instructions are emitted ONLY when the endCall-enabled agent
  // rides along, because that's what makes the worker register the hangup tool.
  const buildBody = (agentId: string | null): VoiceDialParams => ({
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
    constraints: {
      allowedProviders: {
        tts: [deps.cfg.ttsPin],
        stt: [deps.cfg.sttPin],
        ...(deps.cfg.llmPin
          ? { llm: deps.cfg.llmPin.split(",").map((m) => m.trim()).filter(Boolean) }
          : {}),
      },
    },
    sttOptions: { keywords: [caller, businessName, ...DIAL_STT_KEYWORDS] },
    ttsOptions: { speed: deps.cfg.ttsSpeed ?? 1.0 },
    llm: { temperature: 0.5, maxTokens: 100 },
    firstMessage: buildFirstMessage(caller, input.objective),
    systemPrompt: buildSystemPrompt(
      input.objective,
      input.context ?? null,
      businessName,
      caller,
      input.behavior ?? null,
      agentId != null,
    ),
    metadata: {
      source: "speko-mcp-calls-demo",
      objective: input.objective,
      business_name: businessName,
      // Persist to/from so get_call can report dialed_number/caller_id (CallDetail has no top-level
      // to/from; the poll/recovery path reads them back from metadata).
      to: e164,
      from: fromNumber ?? null,
    },
    telephony: { amd: { mode: "agent" } },
  });

  try {
    return attachDashboardUrl(
      await runPhoneCall(buildBody(dialAgentId), durationCap, deps, sleep),
      deps.cfg.dashboardBaseUrl,
    );
  } catch (e) {
    // The cached dial agent can be deleted out-of-band (dashboard cleanup) after this
    // long-lived process resolved it; the platform then 404s (AGENT_NOT_FOUND) on EVERY
    // dial until restart. Same fail-open stance as bootstrap: drop the cache and place
    // this call agentless (no auto-hangup), with the prompt rebuilt to match.
    if (dialAgentId != null && e instanceof AppError && e.code === "AGENT_NOT_FOUND") {
      resetDialAgent();
      console.error(`[dial-agent] agent ${dialAgentId} gone at dial time; retrying without auto-hangup`);
      return attachDashboardUrl(
        await runPhoneCall(buildBody(null), durationCap, deps, sleep),
        deps.cfg.dashboardBaseUrl,
      );
    }
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

let callInFlight = false;

export async function runPhoneCall(
  body: VoiceDialParams,
  maxSeconds: number,
  deps: MakeCallDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<CallSummary> {
  // D-INF1 mitigation: the platform currently routes concurrent legs into one LiveKit room
  // (>2 participants garble each other), so serialize calls within this process. ON by default;
  // SPEKO_SERIALIZE_CALLS=0 disables it once the platform ships per-call room isolation (#903).
  const serialize = deps.cfg.serializeCalls === true;
  if (serialize && callInFlight) {
    throw new RejectionError(
      "A call is already in progress on this MCP session, so this one wasn't placed. The platform " +
        "currently routes simultaneous calls into a shared room where their audio garbles each other, " +
        "so only one call runs at a time here.",
      "Wait for the current call to finish (check it with get_call), then place the next one. Concurrent " +
        "calls are disabled until the platform ships per-call room isolation.",
    );
  }
  if (serialize) callInFlight = true;
  try {
    return await runPhoneCallInner(body, maxSeconds, deps, sleep);
  } finally {
    if (serialize) callInFlight = false;
  }
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
    dial = await deps.client.dial(body);
  } catch (e) {
    const authFail = isAuthFailure(e);
    throw new AppError((e as Error).message, {
      statusCode: authFail ? 401 : 502,
      nextStep: authFail ? AUTH_NEXT_STEP : MAKE_CALL_DIAL_NEXT_STEP,
      // Preserve the platform's machine code (e.g. AGENT_NOT_FOUND) so makeCall can
      // recover from a deleted dial agent instead of failing every call until restart.
      ...(e instanceof SpekoApiError ? { code: e.code } : {}),
    });
  }

  const callId = dial.sessionId || null;
  const from = typeof dial.from === "string" && dial.from ? dial.from : (body.from ?? null);
  let status = String(dial.status ?? "").toLowerCase();
  const dialCallControlId = String(dial.callControlId ?? "").trim();

  // Diagnostic log (server stdout; the MCP runs this as a separate process).
  console.log(
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

  // Poll until the call REALLY ends. The platform flips `status` to "failed" the moment a
  // first-audio SLA times out (~10-15s) even when the call is live and a full conversation
  // follows — so the authoritative end signal is the room-teardown EVENT, not the status.
  // (Finalizing on the premature "failed" was reporting working calls as not_connected.)
  let elapsed = 0;
  let polls = 0;
  let ended = false;
  let hardFailed = false;
  while (elapsed < maxSeconds) {
    const interval = polls < FAST_POLLS ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS;
    await sleep(interval * 1000);
    elapsed += interval;
    polls += 1;
    let events: Array<Record<string, unknown>>;
    try {
      events = await deps.client.getEvents(callId);
    } catch {
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
      continue;
    }
    const types = new Set(events.map((e) => String(e.event_type ?? e.type ?? "").toLowerCase()));
    // Room teardown = the call is genuinely over; a hard failure (agent never dispatched /
    // SIP dial failed) never recovers. A bare "failed" status without these is ignored.
    const roomEnded = [...ROOM_END_EVENTS].some((t) => types.has(t));
    const hardFailure = [...HARD_FAILURE_EVENTS].some((t) => types.has(t));
    if (roomEnded || hardFailure) {
      ended = true;
      hardFailed = hardFailure; // sip.dial_failed / agent.dispatch_failed → a real trunk failure (E1)
      break;
    }
    // The PHONE leg can die long before the room does: when either side hangs up, the
    // Telnyx call.hangup webhook stamps the session's endedAt immediately, while the
    // agent keeps idling in the LiveKit room (~45-60s) before room_finished fires.
    // Without this check a human hanging up left the caller stuck "in call" until the
    // room drained. endedAt (not status!) is the signal — the platform flips status to
    // "failed" prematurely on first-audio SLA while calls are still live.
    try {
      const session = await deps.client.getSession(callId);
      if (typeof session.endedAt === "string" && session.endedAt) {
        ended = true;
        break;
      }
    } catch {
      // Best effort — the events loop above remains the primary end signal.
    }
  }

  if (!ended) {
    return {
      ...baseSummary(callId, to, from),
      status: "timeout",
      duration_seconds: elapsed,
      connected: true,
      reason: "Reached the wait limit before the call ended; it may still be in progress.",
    };
  }

  return finalize(callId, to, from, status, elapsed, deps, hardFailed);
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
  // The transcript can lag the room-teardown event by a moment; re-fetch briefly until the
  // caller's turns appear (or attempts run out) so a real conversation isn't under-reported
  // as not_connected just because we read it a beat too early.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const detail = await deps.client.getCall(callId);
      transcript = detail.transcript ?? null;
      const reportOutcome = typeof detail.report?.outcome === "string" ? detail.report.outcome.trim() : "";
      // Ignore bare platform status words ("failed"/"completed"/...) — prefer a substantive report
      // outcome, else an OUTCOME: marker in the transcript.
      const substantive = reportOutcome && !BARE_OUTCOME_RE.test(reportOutcome) ? reportOutcome : "";
      outcome = substantive || extractOutcome(transcript);
      transcriptError = undefined;
    } catch (e) {
      transcriptError = (e as Error).message;
    }
    if (extractReply(transcript) !== null) break;
    if (attempt < 2) await sleep(3000);
  }

  let session: SessionDetail | null = null;
  try {
    session = await deps.client.getSession(callId);
  } catch {
    // Best effort — without it we can't disprove a connection, so we don't claim one failed.
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
  console.log(
    `[result] session=${callId} platformStatus=${status} -> reported=${summary.status} connected=${summary.connected} answered=${summary.answered}`,
  );
  return summary;
}
