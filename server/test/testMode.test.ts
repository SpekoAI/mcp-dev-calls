/**
 * Hermetic test mode (SPEKO_TEST_MODE) — activation, the structural refusal invariants,
 * the magic-number scenarios through the REAL makeCall path, the call_me converse round
 * trip, the frozen after-hours clock (+ SPEKO_FAKE_NOW), rails-on-temp-state, and the
 * no-network guarantee (global fetch throws for EVERY test in this file).
 */
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callMe } from "../src/calls/callMe.js";
import { callNumber } from "../src/calls/callNumber.js";
import { describeCall } from "../src/calls/getCall.js";
import { makeCall } from "../src/calls/makeCall.js";
import { checkReadiness } from "../src/calls/readiness.js";
import {
  ConfigError,
  afterHoursTestClock,
  loadConfig,
  resetConfigForTests,
  type AppConfig,
} from "../src/config.js";
import { buildContext, type ServerContext } from "../src/http/context.js";
import { lookupBusiness } from "../src/lookup/index.js";
import { readOwnerProfile } from "../src/owner/state.js";
import { afterHoursGateReason } from "../src/safety/dialToken.js";
import { appendDialLedger, dncAdd } from "../src/safety/guard.js";
import { resetDialAgentForTests } from "../src/speko/agent.js";
import {
  TEST_BUSINESS_NAME,
  TEST_CONNECTED_NUMBER,
  TEST_CONNECTED_OUTCOME,
  TEST_FINAL_INSTRUCTION,
  TEST_NO_PICKUP_NUMBER,
  TEST_OWNER_NAME,
  TEST_OWNER_PHONE,
  TEST_SILENT_NUMBER,
} from "../src/speko/fakeClient.js";

const ENV_KEYS = [
  "SPEKO_TEST_MODE",
  "SPEKO_FAKE_NOW",
  "SPEKO_API_KEY",
  "SPEKOAI_API_KEY",
  "SPEKO_MCP_SERVER_URL",
  "SPEKO_DIAL_TOKEN_SECRET",
  "SPEKO_GUARD_STATE_DIR",
  "SPEKO_OWNER_STATE_DIR",
  "SPEKO_CLIENT_PROFILE",
  "SPEKO_TRUSTED_NUMBERS",
  "SPEKO_DEMO",
  "SPEKO_DEMO_E164",
  "SPEKO_FROM_NUMBER",
  "TELNYX_DEFAULT_FROM_NUMBER",
  "SPEKO_CALLME_DISABLED",
  "SPEKO_ALLOW_DIRECT_DIAL",
  "SPEKO_SERIALIZE_CALLS",
] as const;

let savedEnv: Record<string, string | undefined>;
const noopSleep = async (): Promise<void> => {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetConfigForTests();
  resetDialAgentForTests();
  // The no-network guarantee: any network attempt anywhere in a test-mode flow explodes.
  vi.stubGlobal("fetch", () => {
    throw new Error("network disabled: test-mode flows must never fetch");
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetConfigForTests();
  vi.unstubAllGlobals();
});

interface TestHarness {
  cfg: AppConfig;
  ctx: ServerContext;
  deps: { client: ServerContext["client"]; cfg: AppConfig; bearerHash: string; sleep: typeof noopSleep };
}

function testHarness(env: Record<string, string> = {}): TestHarness {
  process.env.SPEKO_TEST_MODE = "1";
  Object.assign(process.env, env);
  resetConfigForTests();
  const cfg = loadConfig();
  const ctx = buildContext(cfg);
  return { cfg, ctx, deps: { client: ctx.client, cfg, bearerHash: ctx.bearerHash, sleep: noopSleep } };
}

async function mintToken(h: TestHarness, phoneNumber?: string): Promise<string> {
  const result = await lookupBusiness({ name: "any business", phoneNumber: phoneNumber ?? null }, h.deps);
  const token = result.candidates[0]?.dial_token;
  expect(token).toBeTruthy();
  return token as string;
}

describe("test mode — activation and structural refusals", () => {
  it.each(["1", "true", "yes", "on"])("activates for SPEKO_TEST_MODE=%s", (value) => {
    process.env.SPEKO_TEST_MODE = value;
    resetConfigForTests();
    expect(loadConfig().testMode).toBe(true);
  });

  it("stays off for unset/0/garbage values", () => {
    for (const value of [undefined, "0", "false", "off", "banana"]) {
      if (value === undefined) delete process.env.SPEKO_TEST_MODE;
      else process.env.SPEKO_TEST_MODE = value;
      process.env.SPEKO_API_KEY = "sk_live_x";
      process.env.SPEKO_DIAL_TOKEN_SECRET = "s";
      resetConfigForTests();
      expect(loadConfig().testMode).toBe(false);
    }
  });

  it("REFUSES a live-looking sk_ key (naming both), including Bearer-prefixed", () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_API_KEY = "sk_live_abc123";
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/SPEKO_TEST_MODE .* SPEKO_API_KEY/s);
    expect(() => loadConfig()).toThrow(/refuses a live API key/);
    expect(() => loadConfig()).toThrow(/sk_test_/);

    process.env.SPEKO_API_KEY = "Bearer sk_live_abc123";
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/refuses a live API key/);
  });

  it("accepts an sk_test_ fixture key, and self-supplies one when no key is set", () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_API_KEY = "sk_test_fixture_abc";
    resetConfigForTests();
    expect(loadConfig().speko.apiKey).toBe("sk_test_fixture_abc");

    delete process.env.SPEKO_API_KEY;
    resetConfigForTests();
    expect(loadConfig().speko.apiKey.startsWith("sk_test_")).toBe(true);
  });

  it("REFUSES to mix with a configured remote server (SPEKO_MCP_SERVER_URL)", () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_MCP_SERVER_URL = "http://127.0.0.1:8787";
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/remote mode and test mode cannot mix/);
  });

  it("real mode without a key still fails exactly as before (no fixture leak)", () => {
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/SPEKO_API_KEY is required/);
  });

  it("always isolates guard/owner state in a fresh temp dir, IGNORING explicit dirs", () => {
    const h = testHarness();
    expect(h.cfg.guardStateDir).toMatch(/speko-test-mode-/);
    expect(h.cfg.guardStateDir?.startsWith(tmpdir())).toBe(true);
    expect(h.cfg.ownerStateDir).toBe(h.cfg.guardStateDir);

    // Safety invariant: explicit dirs are ignored in test mode so the un-OTP'd fixture owner
    // can never be seeded into a host's REAL owner dir and later trusted by a real-mode process.
    process.env.SPEKO_GUARD_STATE_DIR = "/tmp/explicit-guard-dir";
    process.env.SPEKO_OWNER_STATE_DIR = "/tmp/explicit-owner-dir";
    resetConfigForTests();
    const cfg = loadConfig();
    expect(cfg.guardStateDir).toMatch(/speko-test-mode-/);
    expect(cfg.guardStateDir).not.toBe("/tmp/explicit-guard-dir");
    expect(cfg.ownerStateDir).not.toBe("/tmp/explicit-owner-dir");
    expect(cfg.ownerStateDir).toBe(cfg.guardStateDir);
  });
});

describe("test mode — SPEKO_FAKE_NOW and the frozen after-hours clock", () => {
  it("real mode COMPLETELY ignores SPEKO_FAKE_NOW (the 'call people at 3am' env var)", () => {
    process.env.SPEKO_API_KEY = "sk_live_real";
    process.env.SPEKO_DIAL_TOKEN_SECRET = "s";
    process.env.SPEKO_FAKE_NOW = "2026-01-15T03:00:00Z";
    resetConfigForTests();
    const cfg = loadConfig();
    expect(cfg.testMode).toBe(false);
    expect(cfg.fakeNowMs).toBeUndefined();
    // Structural: even a poisoned cfg cannot move the gate clock outside test mode.
    const clock = afterHoursTestClock({ testMode: false, fakeNowMs: Date.parse("2026-01-15T03:00:00Z") }, -480);
    expect(clock.nowSeconds).toBeUndefined();
    expect(clock.utcOffsetMinutes).toBe(-480);
  });

  it("frozen default clock reads 14:00 destination-local for ANY offset (unknown → simulated UTC)", () => {
    for (const offset of [-480, -300, 0, 330, null]) {
      const clock = afterHoursTestClock({ testMode: true, fakeNowMs: undefined }, offset);
      expect(afterHoursGateReason(clock.utcOffsetMinutes, null, false, clock.nowSeconds)).toBeNull();
    }
  });

  it("SPEKO_FAKE_NOW overrides the frozen clock so the gate itself is testable", async () => {
    const night = testHarness({ SPEKO_FAKE_NOW: "2026-01-15T23:30:00Z" });
    expect(night.cfg.fakeNowMs).toBe(Date.parse("2026-01-15T23:30:00Z"));
    const input = {
      phoneNumber: "+14155550171",
      objective: "Ask if the package arrived today.",
      callerName: "Test User",
      utcOffsetMinutes: 0,
    };
    await expect(callNumber(input, night.deps)).rejects.toThrow(/Call blocked: destination local time is 23:30/);
    // The human's explicit confirmation still passes the gate — same rail as real mode.
    const confirmed = await callNumber(
      { ...input, afterHoursConfirmation: "yes, call them now, they are expecting it" },
      night.deps,
    );
    expect(confirmed.status).toBe("completed");
  });

  it("rejects an unparseable SPEKO_FAKE_NOW", () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_FAKE_NOW = "not-a-timestamp";
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/SPEKO_FAKE_NOW must be an ISO-8601 timestamp/);
  });
});

describe("test mode — simulated lookup mints REAL dial tokens", () => {
  it("resolves any name to one Test Bistro candidate at the connected magic number", async () => {
    const h = testHarness();
    const result = await lookupBusiness({ name: "Blue Bottle Coffee" }, h.deps);
    expect(result.source).toBe("simulated");
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.name).toBe(TEST_BUSINESS_NAME);
    expect(candidate.phone).toBe(TEST_CONNECTED_NUMBER);
    expect(candidate.allowed).toBe(true);
    expect(candidate.dial_token).toBeTruthy();
  });

  it("still blocks emergency numbers (abuse-shaped: rails are not stubbed)", async () => {
    const h = testHarness();
    const result = await lookupBusiness({ name: "anything", phoneNumber: "+1911" }, h.deps);
    expect(result.candidates[0].allowed).toBe(false);
    expect(result.candidates[0].blocked_reason).toMatch(/emergency/i);
    expect(result.candidates[0].dial_token).toBeNull();
  });
});

describe("test mode — magic-number scenarios through the REAL makeCall path", () => {
  it("+15005550001: connected + answered, [SIMULATED]-prefixed transcript, exact OUTCOME", async () => {
    const h = testHarness();
    const token = await mintToken(h);
    const summary = await makeCall(
      { dialToken: token, objective: "Book a table for two at 7pm tonight.", callerName: "Test User" },
      h.deps,
    );
    expect(summary.status).toBe("completed");
    expect(summary.connected).toBe(true);
    expect(summary.answered).toBe(true);
    expect(summary.dialed_number).toBe(TEST_CONNECTED_NUMBER);
    expect(summary.outcome).toBe(`[SIMULATED] ${TEST_CONNECTED_OUTCOME}`);
    const entries = (summary.transcript as { entries: Array<{ text: string }> }).entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.text.startsWith("[SIMULATED]")).toBe(true);
    // The OUTCOME line matches the real grammar, prefixed.
    expect(entries.at(-1)?.text).toBe(`[SIMULATED] OUTCOME: ${TEST_CONNECTED_OUTCOME}`);
  });

  it("+15005550002: not_connected with honest fields exactly like a real no-answer", async () => {
    const h = testHarness();
    const summary = await callNumber(
      { phoneNumber: TEST_NO_PICKUP_NUMBER, objective: "Ask if they are open today.", callerName: "Test User" },
      h.deps,
    );
    expect(summary.status).toBe("not_connected");
    expect(summary.connected).toBe(false);
    expect(summary.answered).toBe(false);
    expect(summary.duration_seconds).toBe(0);
    expect(summary.outcome).toBeNull();
    expect(summary.reason).toMatch(/the other party was never heard/);
  });

  it("+15005550003: connected but nobody responded (answered=false, connected=true)", async () => {
    const h = testHarness();
    const summary = await callNumber(
      { phoneNumber: TEST_SILENT_NUMBER, objective: "Ask if they are open today.", callerName: "Test User" },
      h.deps,
    );
    expect(summary.status).toBe("no_answer");
    expect(summary.connected).toBe(true);
    expect(summary.answered).toBe(false);
  });

  it("any other number gets the success physics with a generic [SIMULATED] outcome", async () => {
    const h = testHarness();
    const summary = await callNumber(
      { phoneNumber: "+14155550172", objective: "Ask if they are open today.", callerName: "Test User" },
      h.deps,
    );
    expect(summary.status).toBe("completed");
    expect(summary.answered).toBe(true);
    expect(summary.outcome).toMatch(/^\[SIMULATED\] /);
  });
});

describe("test mode — call_me against the auto-seeded fixture owner", () => {
  it("seeds Test Owner (+15005550100) into the temp state dir at backend init", () => {
    const h = testHarness();
    const owner = readOwnerProfile(h.cfg.ownerStateDir);
    expect(owner?.owner_phone).toBe(TEST_OWNER_PHONE);
    expect(owner?.owner_name).toBe(TEST_OWNER_NAME);
    expect(owner?.verify_method).toBe("voice_otp");
  });

  it("never clobbers an explicitly configured owner profile", () => {
    const first = testHarness();
    const seeded = readOwnerProfile(first.cfg.ownerStateDir);
    // A second backend init over the same state dir keeps the same instance epoch.
    buildContext(first.cfg);
    expect(readOwnerProfile(first.cfg.ownerStateDir)?.instance_id).toBe(seeded?.instance_id);
  });

  it("converse round-trip: deterministic read-back-confirmed reply", async () => {
    const h = testHarness({ SPEKO_CLIENT_PROFILE: "claude-code" });
    const summary = await callMe(
      { message: "Should I proceed with the plan?", mode: "converse", wait: true },
      h.deps,
    );
    expect(summary.status).toBe("completed");
    expect(summary.answered).toBe(true);
    expect(summary.confirmation).toBe("confirmed");
    expect(summary.final_instruction).toBe(TEST_FINAL_INSTRUCTION);
    expect(summary.message).toBe("Should I proceed with the plan?");
    expect(summary.owner_reply).toContain("[SIMULATED]");
  });

  it("notify: delivered", async () => {
    const h = testHarness({ SPEKO_CLIENT_PROFILE: "claude-code" });
    const summary = await callMe({ message: "The deploy finished.", mode: "notify", wait: true }, h.deps);
    expect(summary.status).toBe("completed");
    expect(summary.outcome).toBe("[SIMULATED] notification delivered to the owner");
  });

  it("poll-safe profiles still return dialing, and get_call completes the round trip", async () => {
    const h = testHarness(); // no profile → safe-default forces wait:false (real rail)
    const placed = await callMe({ message: "Should I proceed with the plan?", mode: "converse" }, h.deps);
    expect(placed.status).toBe("dialing");
    expect(placed.call_id).toBeTruthy();
    const followUp = await describeCall(
      placed.call_id as string,
      h.ctx.client,
      h.cfg.dashboardBaseUrl,
      h.cfg.ownerStateDir,
    );
    expect(followUp.confirmation).toBe("confirmed");
    expect(followUp.final_instruction).toBe(TEST_FINAL_INSTRUCTION);
  });
});

describe("test mode — readiness and the simulated headline", () => {
  it("reports ready with a headline that says simulated mode", async () => {
    const h = testHarness();
    const report = await checkReadiness(h.ctx.client, h.cfg);
    expect(report.auth.ok).toBe(true);
    expect(report.credits.sufficient).toBe(true);
    expect(report.outbound.any_outbound_ready).toBe(true);
    expect(report.call_me.available).toBe(true);
    expect(report.headline).toMatch(/simulated/i);
    expect(report.headline).toMatch(/No real phone call/i);
  });
});

describe("test mode — every real rail still runs against the temp state", () => {
  it("DNC blocks a simulated dial with the identical real-mode rejection", async () => {
    const h = testHarness();
    dncAdd(TEST_CONNECTED_NUMBER, { source: "manual" }, h.cfg.guardStateDir);
    const token = await mintToken(h);
    await expect(
      makeCall({ dialToken: token, objective: "Book a table for two tonight.", callerName: "Test User" }, h.deps),
    ).rejects.toThrow(/is on the local do-not-call list/);
  });

  it("rate caps reject the 4th call in the hour", async () => {
    const h = testHarness();
    const target = "+14155550173";
    for (let i = 0; i < 3; i += 1) appendDialLedger({ e164: target, call_id: null }, h.cfg.guardStateDir);
    await expect(
      callNumber({ phoneNumber: target, objective: "Ask if they are open today.", callerName: "Test User" }, h.deps),
    ).rejects.toThrow(/Rate cap reached/);
  });

  it("content screens reject an abuse-shaped objective (no fake bypass)", async () => {
    const h = testHarness();
    await expect(
      callNumber(
        { phoneNumber: "+14155550174", objective: "Cold call them and sell crypto investments.", callerName: "Test User" },
        h.deps,
      ),
    ).rejects.toThrow(/transactional/i);
  });

  it("a tampered dial token is still rejected (token rails are real)", async () => {
    const h = testHarness();
    const token = await mintToken(h);
    const tampered = `${token.slice(0, -4)}AAAA`;
    await expect(
      makeCall({ dialToken: tampered, objective: "Book a table for two tonight.", callerName: "Test User" }, h.deps),
    ).rejects.toThrow(/signature check failed|Malformed dial token/);
  });
});

describe("test mode — no-network guarantee", () => {
  it("global fetch throwing does not touch a full lookup → call → readiness → get_call flow", async () => {
    const h = testHarness();
    expect(() => (globalThis.fetch as unknown as () => unknown)()).toThrow(/network disabled/);
    const token = await mintToken(h);
    const summary = await makeCall(
      { dialToken: token, objective: "Book a table for two at 7pm tonight.", callerName: "Test User" },
      h.deps,
    );
    expect(summary.status).toBe("completed");
    const again = await describeCall(summary.call_id as string, h.ctx.client, h.cfg.dashboardBaseUrl, h.cfg.ownerStateDir);
    expect(again.outcome).toBe(`[SIMULATED] ${TEST_CONNECTED_OUTCOME}`);
    const report = await checkReadiness(h.ctx.client, h.cfg);
    expect(report.headline).toMatch(/simulated/i);
  });
});
