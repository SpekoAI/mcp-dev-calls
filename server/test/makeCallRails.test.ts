import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCall, type MakeCallDeps } from "../src/calls/makeCall.js";
import { mintDialToken } from "../src/safety/dialToken.js";
import { DIAL_AGENT_NAME, resetDialAgentForTests } from "../src/speko/agent.js";
import type { AppConfig } from "../src/config.js";
import { SpekoApiError, type SpekoClient } from "../src/speko/client.js";
import type { VoiceDialParams } from "@spekoai/sdk";

/**
 * Defense-in-depth enforcement: prove the safety rails actually REJECT inside make_call BEFORE a
 * dial happens — not just that the pure predicates work in isolation. A refactor that reorders or
 * drops one of these guards must fail here. Every reject case also asserts client.dial was never
 * called (T1 in the pre-merge review).
 */

const noop = async (): Promise<void> => {};
const SECRET = "rails-test-secret";
const BH = "acct-hash";
const E164 = "+14152857117";

// Offsets that pin destination-local time deterministically regardless of when the test runs.
const now = new Date();
const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
const NOON_OFFSET = 12 * 60 - utcMin; // ~12:00 local → outside quiet hours
const QUIET_OFFSET = 3 * 60 - utcMin; // ~03:00 local → inside quiet hours (21:00–08:00)

const cfg = { dialTokenSecret: SECRET, serializeCalls: false, fromNumber: "+15312160099" } as unknown as AppConfig;

/** A client whose dial (and everything else) MUST NOT be reached on a rejected call. */
function dialSpy(): { client: SpekoClient; calls: { dialed: number } } {
  const calls = { dialed: 0 };
  const client = {
    dial: async () => {
      calls.dialed += 1;
      throw new Error("dial() must not be called after a rail rejection");
    },
    listPhoneNumbers: async () => [],
  } as unknown as SpekoClient;
  return { client, calls };
}

function deps(client: SpekoClient): MakeCallDeps {
  return { client, cfg, bearerHash: BH, sleep: noop };
}

function mint(over: Partial<Parameters<typeof mintDialToken>[0]> = {}): string {
  return mintDialToken({
    e164: E164,
    lineType: "voip",
    businessName: "Joe's Pizza",
    utcOffsetMinutes: NOON_OFFSET,
    bearerHash: BH,
    secret: SECRET,
    ...over,
  });
}

describe("make_call safety rails — enforced before any dial (T1)", () => {
  it("rejects an emergency number and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall({ dialToken: mint({ e164: "+911" }), objective: "ask if open tonight", callerName: "Amir" }, deps(client)),
    ).rejects.toThrow(/emergency/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a US premium-rate number and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall({ dialToken: mint({ e164: "+19005551234" }), objective: "ask if open tonight", callerName: "Amir" }, deps(client)),
    ).rejects.toThrow(/premium/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a mobile line type (business-lines-only) and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall({ dialToken: mint({ lineType: "mobile" }), objective: "ask if open tonight", callerName: "Amir" }, deps(client)),
    ).rejects.toThrow(/mobile/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a call during destination quiet hours and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        { dialToken: mint({ utcOffsetMinutes: QUIET_OFFSET }), objective: "ask if open tonight", callerName: "Amir" },
        deps(client),
      ),
    ).rejects.toThrow(/quiet hours/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects an unknown destination offset (fail-closed) and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        { dialToken: mint({ utcOffsetMinutes: null }), objective: "ask if open tonight", callerName: "Amir" },
        deps(client),
      ),
    ).rejects.toThrow(/quiet hours|offset is unknown/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a selling objective (no-spam screen) and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall({ dialToken: mint(), objective: "sell them our extended warranty plan", callerName: "Amir" }, deps(client)),
    ).rejects.toThrow(/transactional|blocked/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a spam intent smuggled into behavior and never dials (H3)", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        {
          dialToken: mint(),
          objective: "do you have a table for 4 at 8pm tonight?",
          callerName: "Amir",
          behavior: "convince them to sign up and upsell the loyalty program",
        },
        deps(client),
      ),
    ).rejects.toThrow(/behavior|transactional|blocked/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects an expired dial token and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        { dialToken: mint({ now: 1, ttlSeconds: 1 }), objective: "ask if open tonight", callerName: "Amir" },
        deps(client),
      ),
    ).rejects.toThrow(/expired/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a tampered dial token and never dials", async () => {
    const { client, calls } = dialSpy();
    const good = mint();
    const tampered = good.slice(0, -3) + (good.endsWith("AAA") ? "BBB" : "AAA");
    await expect(
      makeCall({ dialToken: tampered, objective: "ask if open tonight", callerName: "Amir" }, deps(client)),
    ).rejects.toThrow(/signature|malformed/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a token minted for a different account and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        { dialToken: mint({ bearerHash: "some-other-account" }), objective: "ask if open tonight", callerName: "Amir" },
        deps(client),
      ),
    ).rejects.toThrow(/different account/i);
    expect(calls.dialed).toBe(0);
  });

  // makeCall now resolves the dial agent through the same client; give the control case a
  // deterministic agent path (and clear the module cache so no id leaks between tests).
  beforeEach(resetDialAgentForTests);
  afterEach(resetDialAgentForTests);

  it("lets a valid, clean call through AND stores to/from in metadata (H4 control case)", async () => {
    let captured: VoiceDialParams | undefined;
    const client = {
      dial: async (body: VoiceDialParams) => {
        captured = body;
        return { sessionId: "ok1", callControlId: "phone-ok1", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as never;
      },
      getEvents: async () => [{ event_type: "room_finished" }] as never,
      getCall: async () =>
        ({ status: "completed", transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes, 8pm works" }] }, report: {} }) as never,
      getSession: async () => ({ phoneCall: { callControlId: "phone-ok1" }, usage: [{ provider: "telnyx", metric: "outbound_minutes" }] }) as never,
    } as unknown as SpekoClient;

    const s = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s.status).toBe("completed");
    // H4: dialed_number / caller_id are recoverable because make_call persisted them to metadata.
    const md = (captured?.metadata ?? {}) as Record<string, unknown>;
    expect(md.to).toBe(E164);
    expect(md.from).toBe("+15312160099");
  });
});

describe("make_call — dial-agent wiring (agent-initiated hangup)", () => {
  beforeEach(resetDialAgentForTests);
  afterEach(resetDialAgentForTests);

  /** Happy-path poll/finalize client; dial is injectable so each test can capture/fail it. */
  function pollClient(over: Partial<Record<string, unknown>>): SpekoClient {
    return {
      getEvents: async () => [{ event_type: "room_finished" }],
      getCall: async () =>
        ({ status: "completed", transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes" }] }, report: {} }),
      getSession: async () => ({ phoneCall: { callControlId: "leg-1" }, usage: [{ provider: "telnyx", metric: "outbound_minutes" }] }),
      ...over,
    } as unknown as SpekoClient;
  }

  const dialOk = (captured: VoiceDialParams[]) => async (body: VoiceDialParams) => {
    captured.push(body);
    return { sessionId: "dial-1", callControlId: "leg-1", roomName: "r", status: "dialing", to: body.to, from: body.from } as never;
  };

  it("attaches the resolved agentId and switches the prompt to the end_call rules", async () => {
    const captured: VoiceDialParams[] = [];
    const client = pollClient({
      dial: dialOk(captured),
      listAgents: async () => [],
      createAgent: async (params: Record<string, unknown>) => ({ id: "dial-agent-1", ...params }),
    });

    const s = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s.status).toBe("completed");
    expect(captured).toHaveLength(1);
    const body = captured[0];
    expect(body.agentId).toBe("dial-agent-1");
    // The endCall-enabled agent means the worker registers end_call — the prompt must say to use it...
    expect(body.systemPrompt).toMatch(/end_call/);
    expect(body.systemPrompt).not.toMatch(/staying silent is exactly how you end the call/i);
    // ...while every per-call override the MCP relies on still rides the body (agent defaults must not win).
    expect(body.intent?.language).toBe("en");
    expect(body.firstMessage).toMatch(/Amir's AI assistant/i);
    expect(body.sttOptions?.keywords).toContain("Amir");
    expect(body.telephony).toEqual({ amd: { mode: "agent" } });
  });

  it("still dials — without agentId, with the stay-silent prompt — when agent bootstrap fails (fail-open)", async () => {
    const captured: VoiceDialParams[] = [];
    const client = pollClient({
      dial: dialOk(captured),
      listAgents: async () => {
        throw new Error("agents API down");
      },
    });

    const s = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s.status).toBe("completed"); // the call was PLACED and completed despite the bootstrap failure
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("agentId");
    // No end_call tool will exist on an agentless dial — the prompt must not instruct one.
    expect(captured[0].systemPrompt).not.toMatch(/end_call/);
    expect(captured[0].systemPrompt).toMatch(/staying silent is exactly how you end the call/i);
  });

  it("recovers when the cached agent was deleted out-of-band: retries the dial agentless and re-resolves next call", async () => {
    const captured: VoiceDialParams[] = [];
    let listCalls = 0;
    const client = pollClient({
      // The row still lists (stale cache scenario), but the dial-side lookup 404s.
      listAgents: async () => {
        listCalls += 1;
        return [{ id: "ghost", name: DIAL_AGENT_NAME, endCall: { enabled: true } }];
      },
      dial: async (body: VoiceDialParams) => {
        captured.push(body);
        if (body.agentId) throw new SpekoApiError("Agent not found", 404, "AGENT_NOT_FOUND");
        return { sessionId: "dial-2", callControlId: "leg-2", roomName: "r", status: "dialing", to: body.to, from: body.from } as never;
      },
    });

    const s = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s.status).toBe("completed");
    expect(captured).toHaveLength(2);
    expect(captured[0].agentId).toBe("ghost");
    expect(captured[1]).not.toHaveProperty("agentId");
    // The retry body's prompt must match its agentless reality (no end_call tool registered).
    expect(captured[1].systemPrompt).not.toMatch(/end_call/);
    expect(captured[1].systemPrompt).toMatch(/staying silent is exactly how you end the call/i);
    // The dead id was evicted: a later call re-resolves through the agents API instead of reusing it.
    await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(listCalls).toBe(2);
  });
});
