/**
 * Shared stateful fake of the platform's agents API for every suite that touches
 * the dial-agent path, so all of them model the SAME platform physics (the ones
 * src/speko/agent.ts's header documents): create lands DIRTY — the platform
 * AUTO-PICKS a `voice` when none is supplied (create cannot express voice:null)
 * and auto-attaches the search_knowledge_base builtin tool; update applies
 * voice/endCall verbatim. Tests mutate `rows`/`tools` directly to simulate
 * dashboard edits and the platform KB backfill between dials, and reassign
 * client methods to inject failures.
 */
import { SpekoApiError, type SpekoClient } from "../../src/speko/client.js";

export interface FakeRow {
  id: string;
  name: string;
  voice?: string | null;
  endCall?: { enabled?: boolean } | null;
}

export interface FakeTool {
  id: string;
  name: string;
}

export interface FakePlatform {
  client: SpekoClient;
  calls: { list: number; get: number; create: number; update: number; toolsList: number; toolsDelete: number };
  created: Array<Record<string, unknown>>;
  updated: Array<{ id: string; params: Record<string, unknown> }>;
  rows: FakeRow[];
  tools: FakeTool[];
}

export function fakePlatform(seed: { rows?: FakeRow[]; tools?: FakeTool[] } = {}): FakePlatform {
  const calls = { list: 0, get: 0, create: 0, update: 0, toolsList: 0, toolsDelete: 0 };
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; params: Record<string, unknown> }> = [];
  const rows: FakeRow[] = seed.rows ?? [];
  const tools: FakeTool[] = seed.tools ?? [];
  const client = {
    listAgents: async () => {
      calls.list += 1;
      return rows.map((r) => ({ ...r }));
    },
    getAgent: async (id: string) => {
      calls.get += 1;
      const row = rows.find((r) => r.id === id);
      if (!row) throw new SpekoApiError("Agent not found", 404, "AGENT_NOT_FOUND");
      return { ...row };
    },
    createAgent: async (params: Record<string, unknown>) => {
      calls.create += 1;
      created.push(params);
      const row: FakeRow = {
        id: "agent-created-1",
        name: params.name as string,
        voice: "auto-picked-native-voice",
        endCall: (params.endCall as FakeRow["endCall"]) ?? null,
      };
      rows.push(row);
      tools.push({ id: "tool-kb-1", name: "search_knowledge_base" });
      return { ...row };
    },
    updateAgent: async (id: string, params: Record<string, unknown>) => {
      calls.update += 1;
      updated.push({ id, params });
      const row = rows.find((r) => r.id === id);
      if (!row) throw new SpekoApiError("Agent not found", 404, "AGENT_NOT_FOUND");
      if ("voice" in params) row.voice = params.voice as string | null;
      if ("endCall" in params) row.endCall = params.endCall as FakeRow["endCall"];
      return { ...row };
    },
    listAgentTools: async () => {
      calls.toolsList += 1;
      return tools.map((t) => ({ ...t }));
    },
    deleteAgentTool: async (_agentId: string, toolId: string) => {
      calls.toolsDelete += 1;
      const i = tools.findIndex((t) => t.id === toolId);
      if (i < 0) throw new SpekoApiError("not found", 404, "UNKNOWN");
      tools.splice(i, 1);
      return { deleted: true };
    },
  };
  return { client: client as unknown as SpekoClient, calls, created, updated, rows, tools };
}
