import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callNumber } from "../src/calls/callNumber.js";
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
