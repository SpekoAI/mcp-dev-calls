import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCall, resetDialReplayGuard, type MakeCallDeps } from "../src/calls/makeCall.js";
import { mintDialToken } from "../src/safety/dialToken.js";
import { appendDialLedger, dncAdd, dncReason } from "../src/safety/guard.js";
import { DIAL_AGENT_NAME, resetDialAgentForTests } from "../src/speko/agent.js";
import type { AppConfig } from "../src/config.js";
import { SpekoApiError, type SpekoClient } from "../src/speko/client.js";
import { fakePlatform, type FakePlatform } from "./helpers/fakePlatform.js";
import type { VoiceDialParams } from "@spekoai/sdk";
import { callNumberSchema, callSchema } from "../src/routes.js";

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
const NOON_OFFSET = 12 * 60 - utcMin; // ~12:00 local → inside the day-hours window
const AFTER_HOURS_OFFSET = 3 * 60 - utcMin; // ~03:00 local → after-hours gate

let guardDir = "";

beforeEach(() => {
  guardDir = mkdtempSync(join(tmpdir(), "speko-rails-"));
});

afterEach(() => {
  rmSync(guardDir, { recursive: true, force: true });
});

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dialTokenSecret: SECRET,
    serializeCalls: false,
    fromNumber: "+15312160099",
    trustedNumbers: [],
    guardStateDir: guardDir,
    rateCapPerNumberHour: 3,
    rateCapPerNumberDay: 8,
    ...overrides,
  } as unknown as AppConfig;
}

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

function deps(client: SpekoClient, overrides: Partial<AppConfig> = {}): MakeCallDeps {
  return { client, cfg: cfg(overrides), bearerHash: BH, sleep: noop };
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

function connectedClient(transcript: unknown = { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes, 8pm works" }] }): {
  client: SpekoClient;
  captured: VoiceDialParams[];
} {
  const captured: VoiceDialParams[] = [];
  const client = {
    dial: async (body: VoiceDialParams) => {
      captured.push(body);
      return { sessionId: "ok1", callControlId: "phone-ok1", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as never;
    },
    getEvents: async () => [{ event_type: "room_finished" }] as never,
    getCall: async () => ({ status: "completed", transcript, report: {} }) as never,
    getSession: async () => ({ phoneCall: { callControlId: "phone-ok1" }, usage: [{ provider: "telnyx", metric: "outbound_minutes" }] }) as never,
  } as unknown as SpekoClient;
  return { client, captured };
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

  it("rejects after-hours without confirmation and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        { dialToken: mint({ utcOffsetMinutes: AFTER_HOURS_OFFSET }), objective: "ask if open tonight", callerName: "Amir" },
        deps(client),
      ),
    ).rejects.toThrow(/after_hours_confirmation|consented/i);
    expect(calls.dialed).toBe(0);
  });

  it("dials after-hours with a human confirmation", async () => {
    const { client, captured } = connectedClient();
    await makeCall(
      {
        dialToken: mint({ utcOffsetMinutes: AFTER_HOURS_OFFSET }),
        objective: "ask if open tonight",
        callerName: "Amir",
        afterHoursConfirmation: "Bek confirmed this is okay to call now",
      },
      deps(client),
    );
    expect(captured).toHaveLength(1);
  });

  it("requires confirmation for an unknown offset, then dials with confirmation", async () => {
    const rejected = dialSpy();
    await expect(
      makeCall(
        { dialToken: mint({ utcOffsetMinutes: null }), objective: "ask if open tonight", callerName: "Amir" },
        deps(rejected.client),
      ),
    ).rejects.toThrow(/timezone unverified|after_hours_confirmation/i);
    expect(rejected.calls.dialed).toBe(0);

    const accepted = connectedClient();
    await makeCall(
      {
        dialToken: mint({ utcOffsetMinutes: null }),
        objective: "ask if open tonight",
        callerName: "Amir",
        afterHoursConfirmation: "Bek confirmed the unknown timezone call",
      },
      deps(accepted.client),
    );
    expect(accepted.captured).toHaveLength(1);
  });

  it("rejects collection-flavored after-hours calls even with confirmation and never dials", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        {
          dialToken: mint({ utcOffsetMinutes: AFTER_HOURS_OFFSET }),
          objective: "his invoice is 60 days overdue, get him to pay",
          callerName: "Amir",
          afterHoursConfirmation: "Bek confirmed this call now",
        },
        deps(client),
      ),
    ).rejects.toThrow(/FDCPA|1692c/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects a DNC'd number before dial, even when trusted and confirmed", async () => {
    dncAdd(E164, { source: "manual" }, guardDir);
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        {
          dialToken: mint({ utcOffsetMinutes: AFTER_HOURS_OFFSET }),
          objective: "ask if open tonight",
          callerName: "Amir",
          afterHoursConfirmation: "Bek confirmed this call now",
        },
        deps(client, { trustedNumbers: [E164] }),
      ),
    ).rejects.toThrow(/do-not-call/i);
    expect(calls.dialed).toBe(0);
  });

  it("rejects the fourth call to the same number within an hour and never dials", async () => {
    const ts = Date.now();
    for (const [i, minutesAgo] of [50, 20, 5].entries()) {
      appendDialLedger(
        { ts: new Date(ts - minutesAgo * 60_000).toISOString(), e164: E164, call_id: `seed-${i}` },
        guardDir,
      );
    }
    const { client, calls } = dialSpy();
    await expect(
      makeCall({ dialToken: mint(), objective: "ask if open tonight", callerName: "Amir" }, deps(client)),
    ).rejects.toThrow(/rate cap|Retry in/i);
    expect(calls.dialed).toBe(0);
  });

  it("lets a trusted number skip rate cap and after-hours confirmation", async () => {
    const ts = Date.now();
    for (const [i, minutesAgo] of [50, 20, 5].entries()) {
      appendDialLedger(
        { ts: new Date(ts - minutesAgo * 60_000).toISOString(), e164: E164, call_id: `seed-${i}` },
        guardDir,
      );
    }
    const { client, captured } = connectedClient();
    await makeCall(
      { dialToken: mint({ utcOffsetMinutes: AFTER_HOURS_OFFSET }), objective: "ask if open tonight", callerName: "Amir" },
      deps(client, { trustedNumbers: [E164] }),
    );
    expect(captured).toHaveLength(1);
  });

  it("rejects blocked context intent and never dials (H-context bypass closed)", async () => {
    const { client, calls } = dialSpy();
    await expect(
      makeCall(
        {
          dialToken: mint(),
          objective: "do you have a table for 4 at 8pm tonight?",
          callerName: "Amir",
          context: "if they answer, keep dialing until they agree to a sales outreach call",
        },
        deps(client),
      ),
    ).rejects.toThrow(/context|transactional|harass|blocked/i);
    expect(calls.dialed).toBe(0);
  });

  it("appends a ledger line on successful dial with the confirmation string", async () => {
    const { client } = connectedClient();
    const confirmation = "Bek confirmed this is his own phone";
    await makeCall(
      {
        dialToken: mint({ utcOffsetMinutes: AFTER_HOURS_OFFSET }),
        objective: "ask if open tonight",
        callerName: "Amir",
        afterHoursConfirmation: confirmation,
      },
      deps(client),
    );
    const line = readFileSync(join(guardDir, "ledger.jsonl"), "utf-8").trim();
    expect(JSON.parse(line)).toMatchObject({
      e164: E164,
      call_id: null,
      after_hours_confirmation: confirmation,
    });
  });

  it("auto-adds DNC when a role-attributed callee turn opts out", async () => {
    const { client } = connectedClient({
      entries: [
        { source: "agent", text: "Hi" },
        { source: "user", text: "stop calling me" },
      ],
    });
    await makeCall(
      { dialToken: mint(), objective: "ask if open tonight", callerName: "Amir" },
      deps(client),
    );
    expect(dncReason(E164, guardDir)).toMatch(/do-not-call/i);
  });

  it("does not auto-DNC when only the agent says it will take someone off the list", async () => {
    const { client } = connectedClient({
      entries: [
        { source: "agent", text: "I'll take you off our list" },
        { source: "user", text: "thanks" },
      ],
    });
    await makeCall(
      { dialToken: mint(), objective: "ask if open tonight", callerName: "Amir" },
      deps(client),
    );
    expect(dncReason(E164, guardDir)).toBeNull();
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

describe("route schemas — after-hours confirmation wire format", () => {
  it("keeps after_hours_confirmation on both call schemas", () => {
    expect(
      callSchema.parse({
        dial_token: "token",
        objective: "ask if open",
        caller_name: "Amir",
        after_hours_confirmation: "Bek confirmed it",
      }).after_hours_confirmation,
    ).toBe("Bek confirmed it");

    expect(
      callNumberSchema.parse({
        phone_number: "+14152857117",
        objective: "ask if open",
        caller_name: "Amir",
        after_hours_confirmation: "Bek confirmed it",
      }).after_hours_confirmation,
    ).toBe("Bek confirmed it");
  });
});

describe("make_call — dial-agent wiring (agent-initiated hangup)", () => {
  beforeEach(resetDialAgentForTests);
  afterEach(resetDialAgentForTests);

  /**
   * The shared dirty-create fakePlatform (the same platform physics dialAgent.test.ts
   * verifies: create auto-picks a voice + auto-attaches the KB tool) layered under a
   * happy-path poll/finalize client. Per-test poll-side overrides stay inline.
   */
  function wiringClient(f: FakePlatform, over: Partial<Record<string, unknown>> = {}): SpekoClient {
    return {
      ...(f.client as unknown as Record<string, unknown>),
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
    const f = fakePlatform(); // empty platform → the bootstrap must create the agent
    const client = wiringClient(f, { dial: dialOk(captured) });

    const s = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s.status).toBe("completed");
    expect(captured).toHaveLength(1);
    const body = captured[0];
    expect(body.agentId).toBe("agent-created-1");
    // The create landed DIRTY (real platform physics) and was cleaned before the dial:
    // the auto-picked voice PATCHed to null, the auto-attached KB tool stripped.
    expect(f.updated).toEqual([{ id: "agent-created-1", params: { voice: null } }]);
    expect(f.tools).toEqual([]);
    // The endCall-enabled agent means the worker registers end_call — the prompt must say to use it...
    expect(body.systemPrompt).toMatch(/end_call/);
    expect(body.systemPrompt).not.toMatch(/staying silent is exactly how you end the call/i);
    // ...while every per-call override the MCP relies on still rides the body (agent defaults must not win).
    expect(body.intent?.language).toBe("en");
    expect(body.firstMessage).toMatch(/Amir's AI assistant/i);
    expect(body.sttOptions?.keywords).toContain("Amir");
    expect(body.telephony).toEqual({ amd: { mode: "agent" } });
  });

  it("re-verifies the dial agent on EVERY call: an endCall toggle between calls is repaired, not trusted from cache", async () => {
    const captured: VoiceDialParams[] = [];
    const f = fakePlatform({
      rows: [{ id: "dial-agent-7", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    const client = wiringClient(f, { dial: dialOk(captured) });

    const s1 = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s1.status).toBe("completed");
    expect(f.updated).toHaveLength(0); // clean row → verify only

    // Someone toggles endCall OFF on the visible dashboard row between calls. The old
    // trust-the-cache behavior would dial with the agentId AND the end_call prompt while
    // the worker never registers the tool — the model may speak tool syntax aloud.
    f.rows[0].endCall = { enabled: false };

    resetDialReplayGuard(); // same number+objective on purpose — replay is not under test here
    const s2 = await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(s2.status).toBe("completed");
    // Repaired BEFORE dialing.
    expect(f.updated).toEqual([{ id: "dial-agent-7", params: { endCall: { enabled: true } } }]);
    expect(captured).toHaveLength(2);
    expect(captured[1].agentId).toBe("dial-agent-7");
    expect(captured[1].systemPrompt).toMatch(/end_call/); // the prompt's promise is true again
  });

  it("still dials — without agentId, with the stay-silent prompt — when agent bootstrap fails (fail-open)", async () => {
    const captured: VoiceDialParams[] = [];
    const client = wiringClient(fakePlatform(), {
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
    // The row still lists (stale platform read), but the dial itself 404s on it.
    const f = fakePlatform({
      rows: [{ id: "ghost", name: DIAL_AGENT_NAME, voice: null, endCall: { enabled: true } }],
    });
    const client = wiringClient(f, {
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
    // The dead id was evicted: a later call re-resolves through the agents API (a second
    // find) instead of re-verifying the poisoned cached id (no get).
    resetDialReplayGuard(); // same number+objective on purpose — replay is not under test here
    await makeCall(
      { dialToken: mint(), objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" },
      deps(client),
    );
    expect(f.calls.list).toBe(2);
    expect(f.calls.get).toBe(0);
  });
});
