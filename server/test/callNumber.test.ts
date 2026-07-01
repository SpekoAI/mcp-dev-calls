import { describe, expect, it } from "vitest";
import { callNumber } from "../src/calls/callNumber.js";
import type { AppConfig } from "../src/config.js";
import type { SpekoClient } from "../src/speko/client.js";

const noop = async (): Promise<void> => {};
const baseCfg = {
  allowDirectDial: true,
  dialTokenSecret: "test-secret",
  fromNumber: "+15312160099", // set so resolveFromNumber skips the listPhoneNumbers network call
} as unknown as AppConfig;

function deps(client: Partial<SpekoClient>, cfg: AppConfig = baseCfg) {
  return { client: client as unknown as SpekoClient, cfg, bearerHash: "test", sleep: noop };
}

// An offset that puts the destination's local time around noon, so the quiet-hours rail (08:00-21:00)
// never blocks the test regardless of when it runs (deterministic).
const now = new Date();
const NOON_OFFSET = 12 * 60 - (now.getUTCHours() * 60 + now.getUTCMinutes());

function connectedClient(captured: { to?: string }): Partial<SpekoClient> {
  return {
    dial: async (body) => {
      captured.to = body.to;
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
        deps({}, { ...baseCfg, allowDirectDial: false }),
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

  it("dials a clean E.164 number unchanged", async () => {
    const cap: { to?: string } = {};
    await callNumber(
      { phoneNumber: "+14152857117", objective: "ask if open", callerName: "Amir", utcOffsetMinutes: NOON_OFFSET },
      deps(connectedClient(cap)),
    );
    expect(cap.to).toBe("+14152857117");
  });
});
