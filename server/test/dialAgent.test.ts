import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAL_AGENT_NAME, ensureDialAgent, resetDialAgentForTests } from "../src/speko/agent.js";
import type { SpekoClient } from "../src/speko/client.js";

/**
 * ensureDialAgent is the bootstrap for agent-initiated hangup: it must find-or-create
 * the endCall-enabled "speko-mcp-dial" agent, never race two creates, and FAIL OPEN
 * (null) so a broken agents API can never block a dial. A non-null return is a promise
 * that the worker will register the end_call tool, so every path that can't guarantee
 * that (create failed, update failed, timeout) must resolve null.
 */

interface FakeAgents {
  client: SpekoClient;
  calls: { list: number; create: number; update: number };
  created: Array<Record<string, unknown>>;
  updated: Array<{ id: string; params: Record<string, unknown> }>;
}

function fakeAgents(overrides: Partial<Record<"listAgents" | "createAgent" | "updateAgent", unknown>> & {
  rows?: Array<Record<string, unknown>>;
} = {}): FakeAgents {
  const calls = { list: 0, create: 0, update: 0 };
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; params: Record<string, unknown> }> = [];
  const client = {
    listAgents: overrides.listAgents ?? (async () => {
      calls.list += 1;
      return overrides.rows ?? [];
    }),
    createAgent: overrides.createAgent ?? (async (params: Record<string, unknown>) => {
      calls.create += 1;
      created.push(params);
      return { id: "agent-created-1", ...params };
    }),
    updateAgent: overrides.updateAgent ?? (async (id: string, params: Record<string, unknown>) => {
      calls.update += 1;
      updated.push({ id, params });
      return { id, ...params };
    }),
  } as unknown as SpekoClient;
  return { client, calls, created, updated };
}

beforeEach(resetDialAgentForTests);
afterEach(resetDialAgentForTests);

describe("ensureDialAgent — find-or-create the endCall-enabled dial agent", () => {
  it("creates the agent (endCall enabled, minimal defaults) when none exists", async () => {
    const f = fakeAgents();
    const id = await ensureDialAgent({ client: f.client });
    expect(id).toBe("agent-created-1");
    expect(f.created).toHaveLength(1);
    const params = f.created[0];
    expect(params.name).toBe(DIAL_AGENT_NAME);
    expect(params.endCall).toEqual({ enabled: true });
    // Required-by-schema fields only; everything else stays per-call overrides.
    expect(params.systemPrompt).toBeTruthy();
    expect(params.intent).toEqual({ language: "en" });
  });

  it("reuses an existing row that already has endCall enabled (no create, no update)", async () => {
    const f = fakeAgents({ rows: [{ id: "agent-x", name: DIAL_AGENT_NAME, endCall: { enabled: true } }] });
    const id = await ensureDialAgent({ client: f.client });
    expect(id).toBe("agent-x");
    expect(f.calls.create).toBe(0);
    expect(f.calls.update).toBe(0);
  });

  it("updates an existing row whose endCall is disabled or absent", async () => {
    for (const row of [
      { id: "agent-y", name: DIAL_AGENT_NAME, endCall: { enabled: false } },
      { id: "agent-y", name: DIAL_AGENT_NAME }, // endCall never set on the row
    ]) {
      resetDialAgentForTests();
      const f = fakeAgents({ rows: [row] });
      const id = await ensureDialAgent({ client: f.client });
      expect(id).toBe("agent-y");
      expect(f.calls.create).toBe(0);
      expect(f.updated).toEqual([{ id: "agent-y", params: { endCall: { enabled: true } } }]);
    }
  });

  it("fails open (null) when listing throws — and the NEXT call retries instead of caching the failure", async () => {
    let listCalls = 0;
    const f = fakeAgents({
      listAgents: async () => {
        listCalls += 1;
        if (listCalls === 1) throw new Error("agents API down");
        return [];
      },
    });
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
    // Retry path: the failure was not cached, and the second attempt creates normally.
    await expect(ensureDialAgent({ client: f.client })).resolves.toBe("agent-created-1");
    expect(listCalls).toBe(2);
  });

  it("fails open (null) when the create throws", async () => {
    const f = fakeAgents({
      createAgent: async () => {
        throw new Error("create rejected");
      },
    });
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
  });

  it("fails open (null) when the endCall repair update throws — never promises a tool it couldn't enable", async () => {
    const f = fakeAgents({
      rows: [{ id: "agent-z", name: DIAL_AGENT_NAME, endCall: null }],
      updateAgent: async () => {
        throw new Error("update rejected");
      },
    });
    await expect(ensureDialAgent({ client: f.client })).resolves.toBeNull();
  });

  it("dedupes concurrent calls onto one in-flight resolution (exactly one create)", async () => {
    let releaseList: (rows: unknown[]) => void = () => {};
    const gate = new Promise<unknown[]>((r) => {
      releaseList = r;
    });
    let listCalls = 0;
    const f = fakeAgents({
      listAgents: async () => {
        listCalls += 1;
        return gate;
      },
    });
    const first = ensureDialAgent({ client: f.client });
    const second = ensureDialAgent({ client: f.client });
    releaseList([]); // no existing agent → the single resolution creates once
    expect(await first).toBe("agent-created-1");
    expect(await second).toBe("agent-created-1");
    expect(listCalls).toBe(1);
    expect(f.calls.create).toBe(1);
  });

  it("caches the resolved id for the process — a later call makes no further API calls", async () => {
    let listCalls = 0;
    const f = fakeAgents({
      listAgents: async () => {
        listCalls += 1;
        return [{ id: "agent-cached", name: DIAL_AGENT_NAME, endCall: { enabled: true } }];
      },
    });
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-cached");
    expect(await ensureDialAgent({ client: f.client })).toBe("agent-cached");
    expect(listCalls).toBe(1);
  });

  it("bounds the dial's wait: a hung bootstrap resolves null within the wait bound", async () => {
    const f = fakeAgents({
      listAgents: () => new Promise(() => {}), // never settles
    });
    const started = Date.now();
    const id = await ensureDialAgent({ client: f.client, bootstrapWaitMs: 25 });
    expect(id).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000); // returned at the bound, not hung
  });
});
