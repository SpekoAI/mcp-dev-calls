/**
 * Hermetic test-mode fake of the Speko platform (SPEKO_TEST_MODE=1). Implements the same
 * surface as SpekoClient with deterministic in-memory physics and ZERO network I/O, so any
 * agent platform can exercise all six MCP tools offline with no key and no telephony.
 *
 * What is fake here is ONLY the platform: dial/poll/transcript/report/session/agent rows.
 * Everything upstream stays REAL — dial-token mint+verify, content screens, DNC, rate caps,
 * the after-hours gate (on the frozen test clock), and the owner lease — so a rejected call
 * in test mode is byte-identical to a rejected call in real mode (plus the test_mode marker
 * the backend layer adds).
 *
 * Marking discipline: every simulated transcript line and outcome string carries the
 * `[SIMULATED]` prefix. Two deliberate exceptions inside the call_me converse transcript,
 * forced by the REAL read-back parser this mode exists to exercise: the agent's read-back
 * frame must START with the literal READBACK_PREFIX, and the owner's acceptance must be the
 * literal word CONFIRMED — so those two lines carry the marker inside the instruction payload
 * instead ("[SIMULATED] proceed with the plan").
 *
 * Scenario selection is Stripe-style magic numbers (see the TEST_* constants below).
 */
import type {
  AgentCreateParams,
  AgentRow,
  AgentToolRow,
  AgentUpdateParams,
  CallDetail,
  OrganizationBalance,
  PhoneNumberRow,
  VoiceDialParams,
  VoiceDialResult,
} from "@spekoai/sdk";
import type { AppConfig } from "../config.js";
import { READBACK_PREFIX, READBACK_SUFFIX } from "../calls/callMePrompt.js";
import { readOwnerProfile, writeOwnerProfile } from "../owner/state.js";
import { dialBlockedReason, mintDialToken } from "../safety/dialToken.js";
import type { LookupResult, SessionDetail } from "../types.js";
import { SpekoApiError } from "./client.js";

// ── Fixtures (magic numbers + owner) ─────────────────────────────────────────
/** Connected + answered; scripted transcript ends with a real OUTCOME line. */
export const TEST_CONNECTED_NUMBER = "+15005550001";
/** not_connected — honest fields exactly like a real destination-side no-answer. */
export const TEST_NO_PICKUP_NUMBER = "+15005550002";
/** Connected but nobody responded (connected=true, answered=false). */
export const TEST_SILENT_NUMBER = "+15005550003";
/** Fixture owner auto-seeded into the (temp) owner state dir at backend init. */
export const TEST_OWNER_PHONE = "+15005550100";
export const TEST_OWNER_NAME = "Test Owner";
export const TEST_BUSINESS_NAME = "Test Bistro";
/** Simulated outbound caller-ID resolved by resolveFromNumber via listPhoneNumbers. */
export const TEST_CALLER_ID = "+15005550199";

export const SIMULATED = "[SIMULATED]";
export const TEST_CONNECTED_OUTCOME = "table for 2 confirmed for 7pm";
export const TEST_FINAL_INSTRUCTION = `${SIMULATED} proceed with the plan`;

/**
 * Seed the fixture owner so call_me works out of the box in test mode — no OTP, no flag.
 * Never overwrites an existing (explicitly configured) owner profile.
 */
export function seedTestModeOwner(cfg: AppConfig): void {
  if (!cfg.testMode || !cfg.ownerStateDir) return;
  if (readOwnerProfile(cfg.ownerStateDir)) return;
  writeOwnerProfile({ ownerPhone: TEST_OWNER_PHONE, ownerName: TEST_OWNER_NAME }, cfg.ownerStateDir);
}

/**
 * Test-mode business lookup: any name resolves to one candidate — "Test Bistro" at
 * +15005550001. An agent-provided phone_number is kept (so every magic-number scenario is
 * reachable through the real lookup_business → make_call path), and the dial_token is REAL:
 * minted and later verified with the process's own HMAC secret, so the token rails are
 * exercised, not stubbed. The emergency/premium number screen still applies.
 */
export function simulatedLookup(
  input: { name: string; location?: string | null; phoneNumber?: string | null; utcOffsetMinutes?: number | null },
  deps: { cfg: AppConfig; bearerHash: string },
): LookupResult {
  const provided = typeof input.phoneNumber === "string" ? input.phoneNumber.replace(/[^\d+]/g, "") : "";
  const e164 = provided || TEST_CONNECTED_NUMBER;
  const utcOffsetMinutes = typeof input.utcOffsetMinutes === "number" ? input.utcOffsetMinutes : 0;
  const blocked = dialBlockedReason(e164);
  const base = {
    name: TEST_BUSINESS_NAME,
    address: `${SIMULATED} 100 Test Street, Testville`,
    phone: e164,
    line_type: "voip",
    utc_offset_minutes: utcOffsetMinutes,
  };
  if (blocked) {
    return {
      candidates: [{ ...base, allowed: false, blocked_reason: blocked, dial_token: null }],
      source: "simulated",
    };
  }
  const dialToken = mintDialToken({
    e164,
    lineType: "voip",
    businessName: TEST_BUSINESS_NAME,
    utcOffsetMinutes,
    bearerHash: deps.bearerHash,
    secret: deps.cfg.dialTokenSecret,
  });
  return {
    candidates: [{ ...base, allowed: true, blocked_reason: null, dial_token: dialToken }],
    source: "simulated",
  };
}

// ── The fake platform client ─────────────────────────────────────────────────

interface SimulatedCall {
  id: string;
  status: string;
  transcript: unknown;
  report: { outcome: string; analysis_status: string } | null;
  metadata: Record<string, unknown>;
  createdAtIso: string;
  endedAtIso: string;
  durationSeconds: number;
  session: SessionDetail;
}

interface FakeAgentRow {
  id: string;
  name: string;
  voice: string | null;
  endCall: { enabled?: boolean } | null;
}

interface ScenarioShape {
  status: string;
  transcript: unknown;
  report: SimulatedCall["report"];
  durationSeconds: number;
  /** false = the session proves no telephony leg ever formed (the real no-answer shape). */
  legFormed: boolean;
}

const turn = (source: "agent" | "user", text: string): { source: string; text: string } => ({ source, text });

function scenarioFor(to: string | null, firstMessage: string, metadata: Record<string, unknown>): ScenarioShape {
  // Owner (call_me) dials carry their own deterministic scripts, keyed off the REAL metadata
  // the call_me path attaches — so the whole lease/read-back pipeline runs unmodified.
  if (metadata.source === "speko-mcp-calls/call_me") {
    if (metadata.call_me_mode === "notify") {
      return {
        status: "completed",
        transcript: {
          entries: [
            turn("agent", `${SIMULATED} ${firstMessage}`),
            turn("user", `${SIMULATED} Okay, thanks. Goodbye.`),
          ],
        },
        report: { outcome: `${SIMULATED} notification delivered to the owner`, analysis_status: "completed" },
        durationSeconds: 18,
        legFormed: true,
      };
    }
    return {
      status: "completed",
      transcript: {
        entries: [
          turn("agent", `${SIMULATED} ${firstMessage}`),
          turn("user", `${SIMULATED} Yes, I am listening.`),
          // The read-back frame and the acceptance token below must stay literal for the real
          // parser; the [SIMULATED] marker rides inside the instruction payload instead.
          turn("agent", `${READBACK_PREFIX} ${TEST_FINAL_INSTRUCTION}. ${READBACK_SUFFIX}`),
          turn("user", "CONFIRMED"),
          turn("agent", `${SIMULATED} Confirmed. Goodbye.`),
        ],
      },
      report: { outcome: `${SIMULATED} owner confirmed the read-back instruction`, analysis_status: "completed" },
      durationSeconds: 32,
      legFormed: true,
    };
  }
  if (to === TEST_NO_PICKUP_NUMBER) {
    // Real destination-side no-answer physics: the dial is accepted, the room finishes, but the
    // authoritative session shows no leg (no callControlId, no carrier usage) and no transcript.
    return { status: "no_answer", transcript: null, report: null, durationSeconds: 0, legFormed: false };
  }
  if (to === TEST_SILENT_NUMBER) {
    // Connected but nobody responded: agent-only transcript, no substantive outcome.
    return {
      status: "completed",
      transcript: {
        entries: [
          turn("agent", `${SIMULATED} ${firstMessage}`),
          turn("agent", `${SIMULATED} I could not hear anyone on the line, so I am ending the call.`),
        ],
      },
      report: null,
      durationSeconds: 21,
      legFormed: true,
    };
  }
  // Default: the connected-and-answered physics of TEST_CONNECTED_NUMBER, with the fixture
  // outcome on the canonical number and a generic one everywhere else.
  const outcomeText = to === TEST_CONNECTED_NUMBER ? TEST_CONNECTED_OUTCOME : "the requested objective was completed";
  return {
    status: "completed",
    transcript: {
      entries: [
        turn("agent", `${SIMULATED} ${firstMessage}`),
        turn("user", `${SIMULATED} Sure, we can do that.`),
        turn("agent", `${SIMULATED} Great, thank you. Goodbye.`),
        turn("agent", `${SIMULATED} OUTCOME: ${outcomeText}`),
      ],
    },
    report: { outcome: `${SIMULATED} ${outcomeText}`, analysis_status: "completed" },
    durationSeconds: 24,
    legFormed: true,
  };
}

/**
 * Drop-in fake for SpekoClient (structurally identical public surface; injected in
 * http/context.ts, which is the ONLY constructor of platform clients). Dependency-free and
 * fetch-free by design: stubbing global fetch to throw must not affect any test-mode flow.
 */
export class FakeSpekoClient {
  private counter = 0;
  private agentCounter = 0;
  private readonly calls = new Map<string, SimulatedCall>();
  private readonly agentRows: FakeAgentRow[] = [];
  private readonly agentTools: Array<{ id: string; name: string }> = [];

  async dial(params: VoiceDialParams): Promise<VoiceDialResult> {
    this.counter += 1;
    const id = `sim-call-${this.counter}`;
    const callControlId = `sim-ccid-${this.counter}`;
    const to = typeof params.to === "string" && params.to ? params.to : null;
    const from = typeof params.from === "string" && params.from ? params.from : TEST_CALLER_ID;
    const metadata = (params.metadata ?? {}) as Record<string, unknown>;
    const firstMessage =
      typeof params.firstMessage === "string" && params.firstMessage ? params.firstMessage : "Hello.";
    const shape = scenarioFor(to, firstMessage, metadata);
    const nowIso = new Date().toISOString();
    this.calls.set(id, {
      id,
      status: shape.status,
      transcript: shape.transcript,
      report: shape.report,
      metadata,
      createdAtIso: nowIso,
      endedAtIso: nowIso,
      durationSeconds: shape.durationSeconds,
      session: shape.legFormed
        ? {
            status: "ended",
            endedAt: nowIso,
            durationSeconds: shape.durationSeconds,
            phoneCall: { callControlId },
            usage: [{ provider: "telnyx", metric: "call_minutes", quantity: 1, cost: 0 }],
          }
        : {
            status: "ended",
            endedAt: nowIso,
            durationSeconds: 0,
            phoneCall: { callControlId: null },
            usage: [],
          },
    });
    return {
      sessionId: id,
      callControlId,
      roomName: `sim-room-${this.counter}`,
      status: "dialing",
      to: to ?? "",
      from,
    } as VoiceDialResult;
  }

  private require(callId: string): SimulatedCall {
    const record = this.calls.get(callId);
    if (!record) throw new SpekoApiError(`Simulated call '${callId}' not found`, 404, "SESSION_NOT_FOUND");
    return record;
  }

  async getCall(callId: string): Promise<CallDetail> {
    const record = this.require(callId);
    return {
      id: record.id,
      call_id: record.id,
      status: record.status,
      transcript: record.transcript,
      report: record.report,
      metadata: record.metadata,
      created_at: record.createdAtIso,
      ended_at: record.endedAtIso,
      duration_seconds: record.durationSeconds,
    } as unknown as CallDetail;
  }

  async getBalance(): Promise<OrganizationBalance> {
    return { balanceUsd: 42 } as OrganizationBalance;
  }

  async listPhoneNumbers(): Promise<PhoneNumberRow[]> {
    return [
      {
        id: "sim-number-1",
        e164: TEST_CALLER_ID,
        direction: "outbound",
        source: "managed",
        agentId: null,
        setupStatus: {
          status: "ready",
          inboundReady: false,
          outboundReady: true,
          agentReady: true,
          forwardingRequired: false,
          sipConnectionReady: true,
          issues: [],
        },
      },
    ] as unknown as PhoneNumberRow[];
  }

  // Agent rows model the SAME platform physics the shared test helper documents: create lands
  // DIRTY (a voice is auto-picked, the KB builtin tool auto-attaches) and update applies
  // voice/endCall verbatim — so ensureDialAgent's verify/repair pass runs for real in test mode.
  async listAgents(): Promise<AgentRow[]> {
    return this.agentRows.map((row) => ({ ...row })) as unknown as AgentRow[];
  }

  async createAgent(params: AgentCreateParams): Promise<AgentRow> {
    this.agentCounter += 1;
    const row: FakeAgentRow = {
      id: `sim-agent-${this.agentCounter}`,
      name: params.name,
      voice: "sim-auto-picked-voice",
      endCall: ((params as unknown as Record<string, unknown>).endCall as FakeAgentRow["endCall"]) ?? null,
    };
    this.agentRows.push(row);
    this.agentTools.push({ id: `sim-tool-kb-${this.agentCounter}`, name: "search_knowledge_base" });
    return { ...row } as unknown as AgentRow;
  }

  async getAgent(agentId: string): Promise<AgentRow> {
    const row = this.agentRows.find((r) => r.id === agentId);
    if (!row) throw new SpekoApiError("Agent not found", 404, "AGENT_NOT_FOUND");
    return { ...row } as unknown as AgentRow;
  }

  async updateAgent(agentId: string, params: AgentUpdateParams): Promise<AgentRow> {
    const row = this.agentRows.find((r) => r.id === agentId);
    if (!row) throw new SpekoApiError("Agent not found", 404, "AGENT_NOT_FOUND");
    const patch = params as Record<string, unknown>;
    if ("voice" in patch) row.voice = patch.voice as string | null;
    if ("endCall" in patch) row.endCall = patch.endCall as FakeAgentRow["endCall"];
    return { ...row } as unknown as AgentRow;
  }

  async listAgentTools(_agentId: string): Promise<AgentToolRow[]> {
    return this.agentTools.map((tool) => ({ ...tool })) as unknown as AgentToolRow[];
  }

  async deleteAgentTool(_agentId: string, toolId: string): Promise<{ deleted: boolean }> {
    const index = this.agentTools.findIndex((tool) => tool.id === toolId);
    if (index < 0) throw new SpekoApiError("Tool not found", 404, "TOOL_NOT_FOUND");
    this.agentTools.splice(index, 1);
    return { deleted: true };
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    return this.require(sessionId).session;
  }

  async getEvents(callId: string): Promise<Array<Record<string, unknown>>> {
    this.require(callId);
    // Every simulated call is already terminal: the poll loop finalizes on its first read.
    return [{ event_type: "room_finished" }];
  }
}
