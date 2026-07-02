/**
 * Find-or-create AND per-dial verify the persisted "speko-mcp-dial" agent whose
 * ONLY job is to carry endCall:{enabled:true} into every dial. The platform
 * registers the worker's end_call hangup tool solely from a persisted agent row
 * (the dial route's schema has no endCall field), so dialing with this agentId
 * must add exactly one behavior: the AI can hang up after its goodbye instead of
 * idling until the callee hangs up and the LiveKit room drains (~20s).
 *
 * That "exactly one behavior" contract does NOT hold for a raw platform row, so
 * the row has to be actively kept clean:
 *  - Agent create AUTO-PICKS a `voice` when none is given (create cannot express
 *    voice:null), scoped to whatever TTS vendor the platform recommends — and the
 *    per-call dial body only overrides `voice` when it sends one, which this
 *    server deliberately doesn't. A non-null row voice therefore rides into every
 *    dial and can cross vendors with the pinned TTS = the silent-audio class.
 *    Repair: PATCH voice:null (the update schema is nullable and applies it
 *    verbatim).
 *  - Agent create auto-provisions a Default knowledge base and attaches a
 *    `search_knowledge_base` builtin tool row (the platform's KB backfill can
 *    re-attach it at any time). The worker loads the agent's tools on every dial
 *    with an agentId, handing the LLM a lookup tool over a forever-empty KB — a
 *    mid-call dead-air/rabbit-hole. Repair: delete the tool row.
 *  - The row is a visible dashboard row anyone in the org can edit between dials
 *    (toggle endCall off, pin a voice, add tools).
 * So only the row's ID is cached; the row itself is re-fetched, verified, and
 * repaired on EVERY dial before the id is handed to the dial body.
 */
import type { AgentCreateParams, AgentRow, AgentUpdateParams } from "@spekoai/sdk";
import { DIAL_INTENT_LANGUAGE } from "../constants.js";
import { SpekoApiError, type SpekoClient } from "./client.js";

export const DIAL_AGENT_NAME = "speko-mcp-dial";

// How long a dial may WAIT on agent resolution. The bound applies to the wait,
// not the work: a slow resolve keeps running in the background for the next
// call while this call dials agentless (without auto-hangup).
const BOOTSTRAP_WAIT_MS = 5_000;

// The builtin tool the platform auto-attaches (pointing at the auto-provisioned,
// empty Default KB) on agent create — and re-attaches via its KB backfill.
const KB_SEARCH_TOOL_NAME = "search_knowledge_base";

// SDK 0.4.x doesn't type `endCall` on agent rows/params yet, and types update
// `voice` as `string?` — but the platform accepts endCall on create/update,
// returns it on every serialized row, and its update schema takes `voice: null`
// (applied verbatim, no re-synthesis). Extend the SDK types to match the API.
type AgentRowWithEndCall = AgentRow & { endCall?: { enabled?: boolean } | null };
type AgentCreateParamsWithEndCall = AgentCreateParams & { endCall: { enabled: boolean } };
type AgentRepairParams = Omit<AgentUpdateParams, "voice"> & {
  endCall?: { enabled: boolean };
  voice?: string | null;
};

export interface DialAgentDeps {
  client: SpekoClient;
  /**
   * The dial-time provider pins (provider:model; llm comma-separated). Mirrored
   * onto the row as stackPreferences at create so the platform skips its stack
   * auto-recommend — belt-and-braces: if the voice-null repair is ever missed,
   * the voice create auto-picks at least belongs to the SAME TTS vendor the
   * dials pin, instead of whatever vendor the recommender ranked first.
   */
  cfg?: { ttsPin?: string; sttPin?: string; llmPin?: string };
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
 * out-of-band between the pre-dial verify and the dial itself). The next
 * ensureDialAgent re-resolves through find-or-create.
 */
export function resetDialAgent(): void {
  cachedAgentId = null;
}

/** The dial-time pins as agent stackPreferences; undefined when none configured. */
function stackPreferencesFromPins(cfg: DialAgentDeps["cfg"]): AgentCreateParams["stackPreferences"] {
  const tts = cfg?.ttsPin?.trim();
  const stt = cfg?.sttPin?.trim();
  const llm = (cfg?.llmPin ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const allowedProviders = {
    ...(tts ? { tts: [tts] } : {}),
    ...(stt ? { stt: [stt] } : {}),
    ...(llm.length > 0 ? { llm } : {}),
  };
  return Object.keys(allowedProviders).length > 0 ? { allowedProviders } : undefined;
}

/**
 * Fresh row for the cached id. Returns null — after dropping the cache — when
 * the platform says the row is gone (deleted out-of-band), so the caller falls
 * back to find-or-create. Any other failure propagates to the fail-open null.
 */
async function fetchCachedRow(client: SpekoClient, id: string): Promise<AgentRowWithEndCall | null> {
  try {
    return (await client.getAgent(id)) as AgentRowWithEndCall;
  } catch (e) {
    if (e instanceof SpekoApiError && e.status === 404) {
      cachedAgentId = null;
      return null;
    }
    throw e;
  }
}

/**
 * Delete every auto-attached `search_knowledge_base` tool row so the worker never
 * hands the LLM a lookup tool over the empty auto-provisioned KB. A 404 on the
 * delete is tolerated (another process stripped it between list and delete); any
 * other failure — including the list itself — throws, because returning this
 * agent's id would promise tool-free behavior that wasn't verified.
 */
async function stripKnowledgeBaseTool(client: SpekoClient, agentId: string): Promise<void> {
  const tools = await client.listAgentTools(agentId);
  for (const tool of tools) {
    if (tool.name !== KB_SEARCH_TOOL_NAME) continue;
    try {
      await client.deleteAgentTool(agentId, tool.id);
    } catch (e) {
      if (e instanceof SpekoApiError && e.status === 404) continue;
      throw e;
    }
  }
}

/**
 * Resolve the dial agent's id, creating the row if needed and verifying/repairing
 * it EVERY time. A non-null return is a PROMISE of the row's behavior right now —
 * end_call registered, no synthesized voice, no KB tool — so anything this pass
 * can't verify or repair throws into the fail-open null below. Recreating an off
 * row is never an option (name collision); repair is update-in-place.
 */
async function resolveDialAgent(deps: DialAgentDeps): Promise<string> {
  const { client } = deps;
  // Fresh row every dial; the cached id only skips the find (list) step.
  let row = cachedAgentId ? await fetchCachedRow(client, cachedAgentId) : null;
  if (!row) {
    const rows = (await client.listAgents()) as AgentRowWithEndCall[];
    row = rows.find((r) => r.name === DIAL_AGENT_NAME) ?? null;
  }
  if (!row) {
    const stackPreferences = stackPreferencesFromPins(deps.cfg);
    const params: AgentCreateParamsWithEndCall = {
      name: DIAL_AGENT_NAME,
      // Required by the create schema but never used: every dial from this server
      // sends its own per-call systemPrompt/firstMessage/intent, which win over
      // these agent defaults in the platform's merge.
      systemPrompt: "You are a polite assistant placing a brief, disclosed phone call on the caller's behalf.",
      intent: { language: DIAL_INTENT_LANGUAGE },
      endCall: { enabled: true },
      ...(stackPreferences ? { stackPreferences } : {}),
    };
    row = (await client.createAgent(params)) as AgentRowWithEndCall;
  }

  // Repair drift in one PATCH. A fresh create lands dirty BY DESIGN — the platform
  // auto-picks a voice when create omits one (only PATCH can express voice:null) —
  // so the create path normally repairs immediately too.
  const repairs: AgentRepairParams = {};
  if (row.endCall?.enabled !== true) repairs.endCall = { enabled: true };
  if (row.voice != null) repairs.voice = null;
  if (Object.keys(repairs).length > 0) {
    // Cast: the SDK types update voice as `string?`; the platform schema is nullable.
    await client.updateAgent(row.id, repairs as AgentUpdateParams);
  }
  await stripKnowledgeBaseTool(client, row.id);
  return row.id;
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
 * Id of the VERIFIED dial agent for this dial, or null when it can't be resolved
 * in time. FAIL-OPEN by design: a call without auto-hangup is better than no
 * call, so any resolve/verify error logs one stderr line and returns null.
 *
 * Only the row's id is cached (it skips the list lookup); the row itself is
 * re-verified on EVERY dial — it's a visible dashboard row that can drift between
 * dials (endCall toggled off, a voice pinned, the KB tool re-attached by the
 * platform's backfill), and a stale green light would poison every call until
 * restart. Verification is unconditional rather than TTL-cached by choice: one
 * extra GET (+ tools list) per dial is noise next to the call itself, and it
 * keeps "non-null id = clean row right now" true with no staleness window.
 * Failures are never cached (the next dial retries), and concurrent dials share
 * one in-flight pass so they can never race two creates.
 */
export function ensureDialAgent(deps: DialAgentDeps): Promise<string | null> {
  if (!inFlight) {
    inFlight = resolveDialAgent(deps)
      .then((id) => {
        cachedAgentId = id;
        return id;
      })
      .catch((e: unknown) => {
        console.error(
          `[dial-agent] resolve failed; dialing without auto-hangup: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return boundedWait(inFlight, deps.bootstrapWaitMs ?? BOOTSTRAP_WAIT_MS);
}
