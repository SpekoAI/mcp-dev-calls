import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAL_AGENT_NAME, ensureDialAgent, resetDialAgentForTests } from "../src/speko/agent.js";
import { SpekoApiError } from "../src/speko/client.js";
import { fakePlatform, type FakeRow } from "./helpers/fakePlatform.js";

/**
 * ensureDialAgent is the bootstrap AND per-dial verifier for agent-initiated hangup:
 * it must find-or-create the endCall-enabled "speko-mcp-dial" agent, never race two
 * creates, and FAIL OPEN (null) so a broken agents API can never block a dial. A
 * non-null return is a promise of the row's behavior RIGHT NOW — the worker registers
 * end_call, no row voice leaks into the pipeline (the cross-vendor silent-audio
 * class), and no auto-attached search_knowledge_base tool rides to the LLM — so
 * every path that can't guarantee all three (create/update/tool-removal failed,
 * timeout) must resolve null, and a row mutated between dials must be re-verified
 * and repaired, not trusted from cache. The dirty-create platform physics live in
 * the shared helpers/fakePlatform.ts.
 */

const PINS = {
  ttsPin: "elevenlabs:eleven_flash_v2_5",
  sttPin: "deepgram:nova-3",
  llmPin: "cerebras:gemma-4-31b,openai:gpt-4.1-mini",
};

beforeEach(resetDialAgentForTests);
afterEach(resetDialAgentForTests);

describe("ensureDialAgent — create path leaves a CLEAN row (voice null, no KB tool)", () => {
  it("creates with endCall + the dial pins as stackPreferences, then PATCHes the auto-picked voice to null", async () => {
    const f = fakePlatform();
    const id = await ensureDialAgent({ client: f.client, cfg: PINS });
    expect(id).toBe("agent-created-1");
    expect(f.created).toHaveLength(1);
    const params = f.created[0];
    expect(params.name).toBe(DIAL_AGENT_NAME);
    expect(params.endCall).toEqual({ enabled: true });
    expect(params.systemPrompt).toBeTruthy();
    expect(params.intent).toEqual({ language: "en" });
    // Belt-and-braces: explicit pins make the platform skip its stack auto-recommend,
    // so even the voice it auto-picks belongs to the vendor the dials pin.
    expect(params.stackPreferences).toEqual({
      allowedProviders: {
        tts: ["elevenlabs:eleven_flash_v2_5"],
        stt: ["deepgram:nova-3"],
        llm: ["cerebras:gemma-4-31b", "openai:gpt-4.1-mini"],
      },
    });
    // Create CANNOT express voice:null (the platform auto-picks), so the synthesized
    // voice must be cleared with a follow-up PATCH — otherwise it rides into every
    // dial and can cross vendors with the pinned TTS (silent audio).
    expect(f.updated).toEqual([{ id: "agent-created-1", params: { voice: null } }]);
    expect(f.rows[0].voice).toBeNull();
  });

  it("removes the auto-attached search_knowledge_base tool the platform provisions on create", async () => {
    const f = fakePlatform();
    const id = await ensureDialAgent({ client: f.client, cfg: PINS });
    expect(id).toBe("agent-created-1");
    expect(f.calls.toolsDelete).toBe(1);
    expect(f.tools).toEqual([]); // the LLM never sees a lookup tool over the empty KB
  });

  it("omits stackPreferences when no pins are configured", async () => {
    const f = fakePlatform();
    await ensureDialAgent({ client: f.client });
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).not.toHaveProperty("stackPreferences");
  });
});

describe("ensureDialAgent — repair path (existing row that drifted)", () => {
  it("repairs a non-null voice and disabled endCall in one update, and strips a re-attached KB tool", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-x", name: DIAL_AGENT_NAME, voice: "someone-pinned-this", endCall: { enabled: false } }],
      tools: [
        { id: "tool-kb-9", name: "search_knowledge_base" },
        { id: "tool-other", name: "transfer_call" },
      ],
    });
    const id = await ensureDialAgent({ client: f.client });
    expect(id).toBe("agent-x");
    expect(f.calls.create).toBe(0);
    expect(f.updated).toEqual([
      { id: "agent-x", params: { endCall: { enabled: true }, voice: null } },
    ]);
    // Only the KB tool goes; other tools are none of our business.
    expect(f.tools).toEqual([{ id: "tool-other", name: "transfer_call" }]);
  });

  it("repairs a row whose endCall was never set (absent, not just disabled)", async () => {
    const f = fakePlatform({ rows: [{ id: "agent-y", name: DIAL_AGENT_NAME, voice: null }] });
    const id = await ensureDialAgent({ client: f.client });
    expect(id).toBe("agent-y");
    expect(f.updated).toEqual([{ id: "agent-y", params: { endCall: { enabled: true } } }]);
  });

  it("reuses a clean existing row without a single write (verify only)", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-clean", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    const id = await ensureDialAgent({ client: f.client });
    expect(id).toBe("agent-clean");
    expect(f.calls.create).toBe(0);
    expect(f.calls.update).toBe(0);
    expect(f.calls.toolsDelete).toBe(0);
  });
});

describe("ensureDialAgent — per-dial re-verification (a cached id is not a trusted row)", () => {
  it("catches a row mutated BETWEEN dials (dashboard endCall toggle + pinned voice) and repairs it before the next call", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-live", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-live");
    expect(f.calls.update).toBe(0);

    // Someone edits the visible dashboard row between dials.
    f.rows[0].endCall = { enabled: false };
    f.rows[0].voice = "cartesia-voice-x";

    expect(await ensureDialAgent({ client: f.client })).toBe("agent-live");
    // The second dial re-fetched the row via the cached id (no second find)...
    expect(f.calls.list).toBe(1);
    expect(f.calls.get).toBe(1);
    // ...detected the drift, and repaired it — the old trust-the-cache behavior
    // would have returned the id with zero API calls and a poisoned row.
    expect(f.updated).toEqual([
      { id: "agent-live", params: { endCall: { enabled: true }, voice: null } },
    ]);
    expect(f.rows[0]).toEqual({ id: "agent-live", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } });
  });

  it("catches the platform KB backfill re-attaching the tool between dials, even when the row itself is clean", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-live", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-live");
    expect(f.calls.toolsDelete).toBe(0);

    // backfill-agent-default-kb re-runs ensureKnowledgeBaseTool on every agent.
    f.tools.push({ id: "tool-kb-2", name: "search_knowledge_base" });

    expect(await ensureDialAgent({ client: f.client })).toBe("agent-live");
    expect(f.calls.toolsList).toBe(2); // tools are verified per dial, not once
    expect(f.calls.toolsDelete).toBe(1);
    expect(f.tools).toEqual([]);
  });

  it("falls back to find-or-create when the cached row was deleted between dials (GET 404)", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-old", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-old");

    f.rows.length = 0; // deleted out-of-band

    expect(await ensureDialAgent({ client: f.client })).toBe("agent-created-1");
    expect(f.calls.get).toBe(1); // the 404 that evicted the cache
    expect(f.calls.list).toBe(2); // re-found (and missed) before creating
    expect(f.calls.create).toBe(1);
  });
});

describe("ensureDialAgent — fail-open (null) paths; a non-null id is a verified promise", () => {
  it("fails open when listing throws — and the NEXT call retries instead of caching the failure", async () => {
    const f = fakePlatform();
    const realList = f.client.listAgents.bind(f.client);
    let listCalls = 0;
    (f.client as { listAgents: unknown }).listAgents = async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error("agents API down");
      return realList();
    };
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
    // Retry path: the failure was not cached, and the second attempt creates + repairs normally.
    await expect(ensureDialAgent({ client: f.client })).resolves.toBe("agent-created-1");
    expect(listCalls).toBe(2);
  });

  it("fails open when the create throws", async () => {
    const f = fakePlatform();
    (f.client as { createAgent: unknown }).createAgent = async () => {
      throw new Error("create rejected");
    };
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
  });

  it("fails open when the repair update throws — never promises a row it couldn't fix", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-z", name: DIAL_AGENT_NAME, voice: "stale-voice", endCall: null }],
    });
    (f.client as { updateAgent: unknown }).updateAgent = async () => {
      throw new Error("update rejected");
    };
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
  });

  it("fails open when the KB tool removal fails — and the next dial retries and succeeds", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-live", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
      tools: [{ id: "tool-kb-3", name: "search_knowledge_base" }],
    });
    const realDelete = f.client.deleteAgentTool.bind(f.client);
    let failDelete = true;
    (f.client as { deleteAgentTool: unknown }).deleteAgentTool = async (agentId: string, toolId: string) => {
      if (failDelete) throw new SpekoApiError("boom", 500, "UNKNOWN");
      return realDelete(agentId, toolId);
    };
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
    failDelete = false;
    await expect(ensureDialAgent({ client: f.client })).resolves.toBe("agent-live");
    expect(f.tools).toEqual([]);
  });

  it("fails open when the tools LIST fails (cannot verify means cannot promise)", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-live", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    (f.client as { listAgentTools: unknown }).listAgentTools = async () => {
      throw new Error("tools endpoint down");
    };
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
  });

  it("tolerates a 404 on the tool delete (another process stripped it first)", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-live", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    // The list snapshot still shows the tool, but it's gone by delete time.
    (f.client as { listAgentTools: unknown }).listAgentTools = async () => [
      { id: "tool-gone", name: "search_knowledge_base" },
    ];
    await expect(ensureDialAgent({ client: f.client })).resolves.toBe("agent-live");
  });
});

describe("ensureDialAgent — concurrency, caching, and the wait bound", () => {
  it("dedupes concurrent calls onto one in-flight pass (one create, one tools check)", async () => {
    const f = fakePlatform();
    let releaseList: (rows: FakeRow[]) => void = () => {};
    const gate = new Promise<FakeRow[]>((r) => {
      releaseList = r;
    });
    let listCalls = 0;
    (f.client as { listAgents: unknown }).listAgents = async () => {
      listCalls += 1;
      return gate;
    };
    const first = ensureDialAgent({ client: f.client });
    const second = ensureDialAgent({ client: f.client });
    releaseList([]); // no existing agent → the single shared pass creates once
    expect(await first).toBe("agent-created-1");
    expect(await second).toBe("agent-created-1");
    expect(listCalls).toBe(1);
    expect(f.calls.create).toBe(1);
    expect(f.calls.toolsList).toBe(1);
  });

  it("caches only the id: a later dial skips the find but still re-verifies the row", async () => {
    const f = fakePlatform({
      rows: [{ id: "agent-cached", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-cached");
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-cached");
    expect(f.calls.list).toBe(1); // find ran once
    expect(f.calls.get).toBe(1); // the second dial verified fresh state
    expect(f.calls.toolsList).toBe(2);
  });

  it("bounds the dial's wait: a hung resolve returns null within the wait bound", async () => {
    const f = fakePlatform();
    (f.client as { listAgents: unknown }).listAgents = () => new Promise(() => {}); // never settles
    const started = Date.now();
    const id = await ensureDialAgent({ client: f.client, bootstrapWaitMs: 25 });
    expect(id).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000); // returned at the bound, not hung
  });
});
