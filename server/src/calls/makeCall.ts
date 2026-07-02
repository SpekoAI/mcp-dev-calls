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
  EGRESS_CONFIRM_POLL_SECONDS,
  EGRESS_CONFIRM_WINDOW_SECONDS,
  EGRESS_SOURCE_CLOSED_RE,
  FAST_POLLS,
  FAST_POLL_SECONDS,
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
import { countTranscriptTurns, extractOutcome, extractReply } from "../lib/transcript.js";
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

  // Both pre-dial lookups are independent; resolve them together. ensureDialAgent
  // re-verifies and repairs the dial agent's live row on EVERY dial (a dashboard
  // edit — endCall off, a pinned voice, a re-attached KB tool — must not ride into
  // this call) and is FAIL-OPEN (null after a bounded wait), so it can never block
  // a dial.
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
    // The dial agent can be deleted out-of-band (dashboard cleanup) in the window
    // between the pre-dial verify and the dial itself; the platform then 404s
    // (AGENT_NOT_FOUND). Same fail-open stance as bootstrap: drop the cached id and
    // place this call agentless (no auto-hangup), with the prompt rebuilt to match.
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

/**
 * True for a serialized `egress_ended` event that says the recording's audio source closed
 * (the phone leg died). The marker can sit in `failure_cause` ("Source closed") or inside the
 * raw LiveKit payload, so match over the whole serialized event.
 */
function isSourceClosedEgressEnd(e: Record<string, unknown>): boolean {
  if (String(e.event_type ?? e.type ?? "").toLowerCase() !== "egress_ended") return false;
  try {
    return EGRESS_SOURCE_CLOSED_RE.test(JSON.stringify(e));
  } catch {
    return false;
  }
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
  // Wall clock, not summed sleep intervals: every iteration also spends real time in the API
  // calls below, so summing intervals understated elapsed and stretched the wait cap far past
  // maxSeconds under API latency. The slept-seconds floor only matters under an instant fake
  // sleep (tests) — in real time the wall clock always dominates — and keeps those tests
  // terminating.
  const startedAtMs = Date.now();
  let sleptSeconds = 0;
  const elapsedSeconds = (): number =>
    Math.max(sleptSeconds, Math.round((Date.now() - startedAtMs) / 1000));
  let polls = 0;
  let ended = false;
  let hardFailed = false;
  // egress_ended fast-path state (armed/consumed once per call — the events list is
  // cumulative, so without the seen-flag one egress_ended would re-arm every poll).
  // egressArmedAtSeconds is in elapsedSeconds() units (same wall-clock/slept hybrid),
  // so the confirm window is measured in real time, not in elastic poll counts.
  let egressEndedSeen = false;
  let egressArmedAtSeconds: number | null = null;
  let turnsAtEgressEnd: number | null = null;
  while (elapsedSeconds() < maxSeconds) {
    const baseInterval = polls < FAST_POLLS ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS;
    // Inside the egress confirm window poll faster, so a dead leg is confirmed soon after
    // the window's wall-clock minimum even during the slow-poll phase.
    const interval =
      egressArmedAtSeconds !== null ? Math.min(baseInterval, EGRESS_CONFIRM_POLL_SECONDS) : baseInterval;
    await sleep(interval * 1000);
    sleptSeconds += interval;
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
    if (egressArmedAtSeconds !== null) {
      try {
        const detail = await deps.client.getCall(callId);
        const turnsNow = countTranscriptTurns(detail.transcript);
        if (turnsNow === null || turnsAtEgressEnd === null || turnsNow > turnsAtEgressEnd) {
          egressArmedAtSeconds = null;
        } else if (
          detail.report != null ||
          elapsedSeconds() - egressArmedAtSeconds >= EGRESS_CONFIRM_WINDOW_SECONDS
        ) {
          ended = true;
          break;
        }
      } catch {
        // Couldn't read this poll — no evidence either way; the window stays armed and the
        // next poll retries (fast-finalizing always requires a successful frozen read).
      }
    } else if (!egressEndedSeen && events !== null && events.some(isSourceClosedEgressEnd)) {
      egressEndedSeen = true;
      try {
        const detail = await deps.client.getCall(callId);
        turnsAtEgressEnd = countTranscriptTurns(detail.transcript);
      } catch {
        turnsAtEgressEnd = null;
      }
      // Arm only with a readable baseline: a turn count we couldn't read (endpoint error or an
      // unrecognized transcript shape) can never prove the transcript went quiet, so the
      // fast-path stands down instead of finalizing on missing evidence.
      if (turnsAtEgressEnd !== null) egressArmedAtSeconds = elapsedSeconds();
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
      const reportOutcome = typeof detail.report?.outcome === "string" ? detail.report.outcome.trim() : "";
      // Ignore bare platform status words ("failed"/"completed"/...) — prefer a substantive report
      // outcome, else an OUTCOME: marker in the transcript.
      const substantive = reportOutcome && !BARE_OUTCOME_RE.test(reportOutcome) ? reportOutcome : "";
      outcome = substantive || extractOutcome(transcript);
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
    if (attempt < 2) await sleep(3000);
  }
  // Report-grace: the platform's report (the substantive outcome label) is written moments
  // AFTER room teardown, so finalizing instantly can race it and degrade the outcome to a
  // transcript scrape. Row presence isn't the gate — the platform's heuristic pass can write
  // the row with a bare status word ("completed") before analysis rewrites the real outcome —
  // so wait up to REPORT_GRACE_POLLS short polls for a SUBSTANTIVE outcome from EITHER source.
  // An OUTCOME: marker already scraped from the transcript is the agent's own explicit statement,
  // so there is nothing left to wait for (the common happy path skips the grace entirely).
  // Bounded, because a substantive outcome that never comes (analysis disabled/failed) must
  // never block termination; the transcript extraction above then stands.
  for (let attempt = 0; !outcome && attempt < REPORT_GRACE_POLLS; attempt += 1) {
    await sleep(3000);
    await readDetail();
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
