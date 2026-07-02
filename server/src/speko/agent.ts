/**
 * Find-or-create the persisted "speko-mcp-dial" agent whose ONLY job is to carry
 * endCall:{enabled:true} into every dial. The platform registers the worker's
 * end_call hangup tool solely from a persisted agent row (the dial route's schema
 * has no endCall field), and the per-call body this server sends overrides every
 * other agent default (intent/constraints/voice/systemPrompt/firstMessage/llm/
 * tts/stt) — so dialing with this agentId adds exactly one behavior: the AI can
 * hang up after its goodbye instead of idling until the callee hangs up and the
 * LiveKit room drains (~20s).
 */
import type { AgentCreateParams, AgentRow, AgentUpdateParams } from "@spekoai/sdk";
import { DIAL_INTENT_LANGUAGE } from "../constants.js";
import type { SpekoClient } from "./client.js";

export const DIAL_AGENT_NAME = "speko-mcp-dial";

// How long a dial may WAIT on agent bootstrap. The bound applies to the wait,
// not the work: a slow bootstrap keeps resolving in the background for the next
// call while this call dials agentless (without auto-hangup).
const BOOTSTRAP_WAIT_MS = 5_000;

// SDK 0.4.3 doesn't type `endCall` on agent rows/params yet; the platform
// accepts it on create/update and returns it on every serialized row.
type AgentRowWithEndCall = AgentRow & { endCall?: { enabled?: boolean } | null };
type AgentCreateParamsWithEndCall = AgentCreateParams & { endCall: { enabled: boolean } };
type AgentUpdateParamsWithEndCall = AgentUpdateParams & { endCall: { enabled: boolean } };

export interface DialAgentDeps {
  client: SpekoClient;
  /** Override for the bootstrap wait bound (tests). */
  bootstrapWaitMs?: number;
}

let cachedAgentId: string | null = null;
let inFlight: Promise<string | null> | null = null;

/** Test-only: clear the process-wide cache and in-flight memo between tests. */
export function resetDialAgentForTests(): void {
  cachedAgentId = null;
  inFlight = null;
}

/**
 * Drop the cached id after a dial proved the agent row no longer exists (deleted
 * out-of-band). Without this a long-lived process would attach the dead agentId —
 * and 404 — on every call until restart; the next ensureDialAgent re-resolves.
 */
export function resetDialAgent(): void {
  cachedAgentId = null;
}

/**
 * Resolve the dial agent's id, creating or repairing the row as needed. A non-null
 * return is a PROMISE that the worker will register the end_call tool (the caller
 * gates the prompt's end_call instruction on it), so an existing row with endCall
 * off/absent must be successfully updated — recreating is not an option (name
 * collision), and an update failure falls through to the fail-open null below.
 */
async function resolveDialAgent(client: SpekoClient): Promise<string> {
  const rows = (await client.listAgents()) as AgentRowWithEndCall[];
  const existing = rows.find((row) => row.name === DIAL_AGENT_NAME);
  if (!existing) {
    const params: AgentCreateParamsWithEndCall = {
      name: DIAL_AGENT_NAME,
      // Required by the create schema but never used: every dial from this server
      // sends its own per-call systemPrompt/firstMessage/intent, which win over
      // these agent defaults in the platform's merge.
      systemPrompt: "You are a polite assistant placing a brief, disclosed phone call on the caller's behalf.",
      intent: { language: DIAL_INTENT_LANGUAGE },
      endCall: { enabled: true },
    };
    const created = await client.createAgent(params);
    return created.id;
  }
  if (existing.endCall?.enabled !== true) {
    const params: AgentUpdateParamsWithEndCall = { endCall: { enabled: true } };
    await client.updateAgent(existing.id, params);
  }
  return existing.id;
}

/** Resolve to the work's result, or null once the wait bound passes (the work continues). */
function boundedWait(work: Promise<string | null>, waitMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `[dial-agent] bootstrap still running after ${waitMs}ms; dialing this call without auto-hangup`,
      );
      resolve(null);
    }, waitMs);
    work.then(
      (id) => {
        clearTimeout(timer);
        resolve(id);
      },
      () => {
        // Unreachable in practice (the memoized chain never rejects) — belt and braces.
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Id of the persisted dial agent for this process, or null when it can't be
 * resolved in time. FAIL-OPEN by design: a call without auto-hangup is better
 * than no call, so any bootstrap error logs one stderr line and returns null.
 * Success is cached for the process lifetime; failures are NOT cached (the next
 * dial retries), and concurrent dials share one in-flight resolution so they
 * can never race two creates.
 */
export function ensureDialAgent(deps: DialAgentDeps): Promise<string | null> {
  if (cachedAgentId) return Promise.resolve(cachedAgentId);
  if (!inFlight) {
    inFlight = resolveDialAgent(deps.client)
      .then((id) => {
        cachedAgentId = id;
        return id;
      })
      .catch((e: unknown) => {
        console.error(
          `[dial-agent] bootstrap failed; dialing without auto-hangup: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return boundedWait(inFlight, deps.bootstrapWaitMs ?? BOOTSTRAP_WAIT_MS);
}
