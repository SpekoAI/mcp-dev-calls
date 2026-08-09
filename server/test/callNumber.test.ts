import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callNumber } from "../src/calls/callNumber.js";
import { describeCall } from "../src/calls/getCall.js";
import { dncReason } from "../src/safety/guard.js";
import type { AppConfig } from "../src/config.js";
import type { SpekoClient } from "../src/speko/client.js";

const noop = async (): Promise<void> => {};
let guardDir = "";

beforeEach(() => {
  guardDir = mkdtempSync(join(tmpdir(), "speko-call-number-"));
});

afterEach(() => {
  rmSync(guardDir, { recursive: true, force: true });
});

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    allowDirectDial: true,
    dialTokenSecret: "test-secret",
    fromNumber: "+15312160099", // set so resolveFromNumber skips the listPhoneNumbers network call
    trustedNumbers: [],
    guardStateDir: guardDir,
    rateCapPerNumberHour: 3,
    rateCapPerNumberDay: 8,
    ...overrides,
  } as unknown as AppConfig;
}

function deps(client: Partial<SpekoClient>, config: AppConfig = cfg()) {
  return { client: client as unknown as SpekoClient, cfg: config, bearerHash: "test", sleep: noop };
}

// An offset that puts the destination's local time around noon, so the after-hours gate
// never blocks the test regardless of when it runs (deterministic).
const now = new Date();
const NOON_OFFSET = 12 * 60 - (now.getUTCHours() * 60 + now.getUTCMinutes());
const AFTER_HOURS_OFFSET = 3 * 60 - (now.getUTCHours() * 60 + now.getUTCMinutes());

function connectedClient(captured: { to?: string; turnHandling?: unknown }): Partial<SpekoClient> {
  return {
    dial: async (body) => {
      captured.to = body.to;
      captured.turnHandling = (body as { turnHandling?: unknown }).turnHandling;
      return { sessionId: "t1", callControlId: "phone-t1", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as any;
    },
    getEvents: async () => [{ event_type: "room_finished" }] as any,
    getCall: async () =>
      ({ status: "completed", transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes we're open" }] }, report: {} }) as any,
    getSession: async () => ({ phoneCall: { callControlId: "phone-t1" }, usage: [{ provider: "telnyx", metric: "outbound_minutes", quantity: 1 }] }) as any,
  };
}

describe("callNumber (the npx hero path)", () => {
  it("throws when direct dialing is disabled (SPEKO_ALLOW_DIRECT_DIAL=0)", async () => {
    await expect(
      callNumber(
        { phoneNumber: "+14152857117", objective: "ask if open", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET },
        deps({}, cfg({ allowDirectDial: false })),
      ),
    ).rejects.toThrow(/direct dialing/i);
  });

  it("rejects a number with no country code, even after stripping formatting", async () => {
    await expect(
      callNumber(
        { phoneNumber: "(415) 285-7117", objective: "ask if open", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET },
        deps({}),
      ),
    ).rejects.toThrow(/E\.164/i);
  });

  it("normalizes a formatted +1 number from web search and dials the clean E.164", async () => {
    const cap: { to?: string } = {};
    const s = await callNumber(
      { phoneNumber: "+1 (415) 285-7117", objective: "ask if they have carnitas", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET },
      deps(connectedClient(cap)),
    );
    expect(cap.to).toBe("+14152857117"); // normalized, not the formatted input
    expect(s.connected).toBe(true);
    expect(s.answered).toBe(true);
    expect(s.status).toBe("completed");
  });

  it("passes afterHoursConfirmation through to makeCall", async () => {
    const cap: { to?: string } = {};
    const confirmation = "Bek confirmed this personal call";
    await callNumber(
      {
        phoneNumber: "+14152857117",
        objective: "ask if open",
        callerName: "Amir",
        utcOffsetMinutes: AFTER_HOURS_OFFSET,
        afterHoursConfirmation: confirmation,
      },
      deps(connectedClient(cap)),
    );
    expect(cap.to).toBe("+14152857117");
    const line = readFileSync(join(guardDir, "ledger.jsonl"), "utf-8").trim();
    expect(JSON.parse(line).after_hours_confirmation).toBe(confirmation);
  });

  it("dials a clean E.164 number unchanged", async () => {
    const cap: { to?: string } = {};
    await callNumber(
      { phoneNumber: "+14152857117", objective: "ask if open", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET },
      deps(connectedClient(cap)),
    );
    expect(cap.to).toBe("+14152857117");
  });

  it("wait:false returns right after the dial with a pollable call_id, appends the ledger row, and never polls", async () => {
    let dials = 0;
    const client: Partial<SpekoClient> = {
      dial: async (body) => {
        dials += 1;
        return { sessionId: "bg1", callControlId: "phone-bg1", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as any;
      },
      // Any poll after the dial would defeat the bounded return — fail loudly.
      getEvents: async () => {
        throw new Error("wait:false must not poll events");
      },
      getCall: async () => {
        throw new Error("wait:false must not poll the call");
      },
      getSession: async () => {
        throw new Error("wait:false must not poll the session");
      },
    };
    const s = await callNumber(
      { phoneNumber: "+14152857117", objective: "ask if they are open on sunday", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
      deps(client),
    );
    expect(dials).toBe(1);
    expect(s.status).toBe("dialing");
    expect(s.call_id).toBe("bg1");
    expect(s.connected).toBe(false); // nothing is claimed connected/answered yet
    expect(s.answered).toBe(false);
    expect(s.reason).toContain("continuing in the background");
    expect(s.next_step).toContain("get_call('bg1')");
    expect(s.next_step).toContain("Do not place another call");
    // The rate-cap ledger row is appended pre-dial, exactly as for a blocking dial.
    const line = readFileSync(join(guardDir, "ledger.jsonl"), "utf-8").trim();
    expect(JSON.parse(line).e164).toBe("+14152857117");
  });

  it("wait:false still runs every pre-dial rail — a screened objective is rejected 422 and never dials", async () => {
    let dials = 0;
    const client: Partial<SpekoClient> = {
      dial: async () => {
        dials += 1;
        throw new Error("a rejected call must never reach the dial layer");
      },
    };
    await expect(
      callNumber(
        { phoneNumber: "+14152857117", objective: "Sell them our new subscription plan", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
        deps(client),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(dials).toBe(0);
    // No dial → no ledger row and no replay fingerprint (a corrected retry stays allowed).
    expect(existsSync(join(guardDir, "ledger.jsonl"))).toBe(false);
  });

  it("wait:false registers the dial before returning — an identical follow-up call is rejected with the first call_id", async () => {
    const cap: { to?: string } = {};
    const client = connectedClient(cap);
    const first = await callNumber(
      { phoneNumber: "+14152857117", objective: "ask if they are open on sunday", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
      deps(client),
    );
    expect(first.status).toBe("dialing");
    expect(first.call_id).toBe("t1");
    await expect(
      callNumber(
        { phoneNumber: "+14152857117", objective: "ask if they are open on sunday", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
        deps(client),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("call_id 't1'"),
      nextStep: expect.stringContaining("get_call('t1')"),
    });
  });

  it("get_call works on the call_id a wait:false dial returned (live call → in_progress, never a re-dial)", async () => {
    let dials = 0;
    const client: Partial<SpekoClient> = {
      dial: async (body) => {
        dials += 1;
        return { sessionId: "bg2", callControlId: "phone-bg2", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as any;
      },
      getEvents: async () => [{ event_type: "sip.dial_started" }] as any,
      getCall: async () =>
        ({
          status: "active",
          transcript: null,
          metadata: { to: "+14152857117", from: "+15312160099" },
          created_at: new Date().toISOString(),
        }) as any,
      getSession: async () => ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-bg2" }, usage: [] }) as any,
    };
    const placed = await callNumber(
      { phoneNumber: "+14152857117", objective: "ask if they are open on sunday", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
      deps(client),
    );
    const checked = await describeCall(placed.call_id!, client as unknown as SpekoClient);
    expect(checked.call_id).toBe("bg2");
    expect(checked.status).toBe("in_progress"); // honest live status, not force-completed
    expect(checked.dialed_number).toBe("+14152857117");
    expect(dials).toBe(1); // get_call never dials
  });

  it("refuses wait:false under SPEKO_SERIALIZE_CALLS (would defeat one-call-at-a-time)", async () => {
    let dials = 0;
    const client: Partial<SpekoClient> = {
      dial: async (body) => {
        dials += 1;
        return { sessionId: "s", callControlId: "p", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as any;
      },
    };
    await expect(
      callNumber(
        { phoneNumber: "+14152857117", objective: "ask if they are open on sunday", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
        deps(client, cfg({ serializeCalls: true })),
      ),
    ).rejects.toThrow(/SPEKO_SERIALIZE_CALLS/);
    expect(dials).toBe(0); // refused before dialing
  });

  it("get_call runs the opt-out DNC scan a wait:false dial skipped (finalize never ran)", async () => {
    const target = "+14152857117";
    const client: Partial<SpekoClient> = {
      dial: async (body) =>
        ({ sessionId: "bgdnc", callControlId: "phone-bgdnc", roomName: "r", status: "dialing", to: body.to!, from: body.from! }) as any,
      // Terminal call whose transcript carries a callee opt-out phrase.
      getEvents: async () => [{ event_type: "room_finished" }] as any,
      getCall: async () =>
        ({
          status: "completed",
          transcript: [
            { role: "agent", text: "Hi, I'm calling on behalf of Amir." },
            { role: "user", source: "callee", text: "Please stop calling me, take me off your list." },
          ],
          metadata: { to: target, from: "+15312160099" },
          created_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        }) as any,
      getSession: async () => ({ endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-bgdnc" }, usage: [] }) as any,
    };
    const placed = await callNumber(
      { phoneNumber: target, objective: "ask if they are open on sunday", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET, wait: false },
      deps(client),
    );
    expect(placed.status).toBe("dialing");
    // Before the poll, the DNC ledger is empty (wait:false returned before finalize).
    expect(dncReason(target, guardDir)).toBeNull();
    // The poll is the only place a wait:false call inspects callee speech; it must persist the opt-out.
    await describeCall(placed.call_id!, client as unknown as SpekoClient, undefined, undefined, guardDir);
    expect(dncReason(target, guardDir)).not.toBeNull();
    // Idempotent: a second poll must not append a duplicate row (guarded by the existing-DNC check).
    const before = readFileSync(join(guardDir, "dnc.jsonl"), "utf8").trim().split("\n").length;
    await describeCall(placed.call_id!, client as unknown as SpekoClient, undefined, undefined, guardDir);
    const after = readFileSync(join(guardDir, "dnc.jsonl"), "utf8").trim().split("\n").length;
    expect(after).toBe(before);
  });

  it("threads greetFirst into the dial body and preserves the env default when omitted", async () => {
    const cases: Array<{
      label: string;
      greetFirst?: boolean;
      cfg?: Partial<AppConfig>;
      expected: unknown;
    }> = [
      { label: "false", greetFirst: false, expected: { greetFirst: false } },
      { label: "true", greetFirst: true, expected: { greetFirst: true } },
      { label: "omitted env on", expected: { greetFirst: true } },
      { label: "omitted env off", cfg: { dialGreetFirst: false } as Partial<AppConfig>, expected: undefined },
    ];

    for (const tc of cases) {
      const cap: { turnHandling?: unknown } = {};
      await callNumber(
        {
          phoneNumber: "+14152857117",
          objective: `ask if open ${tc.label}`,
          callerName: "Amir",
          utcOffsetMinutes: NOON_OFFSET,
          ...(tc.greetFirst === undefined ? {} : { greetFirst: tc.greetFirst }),
        },
        deps(connectedClient(cap), cfg({ rateCapPerNumberHour: 10, ...(tc.cfg ?? {}) })),
      );
      expect(cap.turnHandling).toEqual(tc.expected);
    }
  });
});
