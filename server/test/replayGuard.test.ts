import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCall, resetDialReplayGuard, type MakeCallDeps } from "../src/calls/makeCall.js";
import { mintDialToken } from "../src/safety/dialToken.js";
import { DIAL_TOKEN_DEFAULT_TTL_SECONDS } from "../src/constants.js";
import type { AppConfig } from "../src/config.js";
import type { SpekoClient } from "../src/speko/client.js";

/**
 * M3 (issue #37): the dial replay guard. A retried identical dial (same number + objective)
 * within the token TTL must NOT place a second real call — it must point the agent at the
 * existing one via get_call. A failed dial must never lock out a genuine retry.
 */

const noop = async (): Promise<void> => {};
const SECRET = "replay-test-secret";
const BH = "acct-hash";
const E164 = "+14152857117";

const now = new Date();
const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
const NOON_OFFSET = 12 * 60 - utcMin; // destination-local ~noon → day-hours window

let guardDir = "";

beforeEach(() => {
  guardDir = mkdtempSync(join(tmpdir(), "speko-replay-"));
  resetDialReplayGuard();
});

afterEach(() => {
  rmSync(guardDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cfg(): AppConfig {
  return {
    dialTokenSecret: SECRET,
    serializeCalls: false,
    fromNumber: "+15312160099",
    trustedNumbers: [],
    guardStateDir: guardDir,
    rateCapPerNumberHour: 10,
    rateCapPerNumberDay: 20,
  } as unknown as AppConfig;
}

function mint(): string {
  return mintDialToken({
    e164: E164,
    lineType: "voip",
    businessName: "Joe's Pizza",
    utcOffsetMinutes: NOON_OFFSET,
    bearerHash: BH,
    secret: SECRET,
  });
}

/** Happy-path client: dial connects, room finishes on the first poll, callee replied. */
function connectedClient(sessionPrefix: string): { client: SpekoClient; dialed: string[] } {
  const dialed: string[] = [];
  const client = {
    dial: async () => {
      const id = `${sessionPrefix}-${dialed.length + 1}`;
      dialed.push(id);
      return { sessionId: id, callControlId: `phone-${id}`, roomName: `r-${id}`, status: "dialing", to: E164, from: "+15312160099" } as never;
    },
    getEvents: async () => [{ event_type: "room_finished" }] as never,
    getCall: async () =>
      ({
        status: "completed",
        transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes, 8pm works" }] },
        report: { outcome: "Table booked" },
      }) as never,
    getSession: async () => ({ phoneCall: { callControlId: "x" }, usage: [{ provider: "telnyx", metric: "outbound_minutes" }] }) as never,
  } as unknown as SpekoClient;
  return { client, dialed };
}

function deps(client: SpekoClient): MakeCallDeps {
  return { client, cfg: cfg(), bearerHash: BH, sleep: noop };
}

const INPUT = { objective: "do you have a table for 4 at 8pm tonight?", callerName: "Amir" };

describe("dial replay guard (M3)", () => {
  it("rejects an identical retry within the TTL, pointing at the first call's id — only ONE real dial", async () => {
    const { client, dialed } = connectedClient("dup");
    const first = await makeCall({ dialToken: mint(), ...INPUT }, deps(client));
    expect(first.call_id).toBe("dup-1");

    await expect(makeCall({ dialToken: mint(), ...INPUT }, deps(client))).rejects.toThrow(
      /already placed.*dup-1.*|get_call\('dup-1'\)/s,
    );
    expect(dialed).toHaveLength(1); // the second attempt never reached the platform
  });

  it("allows the same number with a DIFFERENT objective", async () => {
    const { client, dialed } = connectedClient("obj");
    await makeCall({ dialToken: mint(), ...INPUT }, deps(client));
    await makeCall(
      { dialToken: mint(), objective: "what time do you close on sundays?", callerName: "Amir" },
      deps(client),
    );
    expect(dialed).toHaveLength(2);
  });

  it("allows an identical dial again after the TTL expires", async () => {
    const { client, dialed } = connectedClient("ttl");
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    await makeCall({ dialToken: mint(), ...INPUT }, deps(client));

    nowSpy.mockReturnValue(t0 + (DIAL_TOKEN_DEFAULT_TTL_SECONDS + 60) * 1000);
    await makeCall({ dialToken: mint(), ...INPUT }, deps(client));
    expect(dialed).toHaveLength(2);
  });

  it("a failed dial is evicted — a genuine retry is never locked out", async () => {
    let attempts = 0;
    const { client: happy } = connectedClient("retry");
    const flaky = {
      ...(happy as unknown as Record<string, unknown>),
      dial: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient network blip");
        return { sessionId: "retry-ok", callControlId: "phone-ok", roomName: "r", status: "dialing", to: E164, from: "+15312160099" } as never;
      },
    } as unknown as SpekoClient;

    await expect(makeCall({ dialToken: mint(), ...INPUT }, deps(flaky))).rejects.toThrow();
    const second = await makeCall({ dialToken: mint(), ...INPUT }, deps(flaky));
    expect(second.call_id).toBe("retry-ok");
    expect(attempts).toBe(2);
  });
});
