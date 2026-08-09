/**
 * Hermetic test mode through the MCP tier: backend selection + the remote-URL refusal in
 * getServerClient, the live-key refusal surfacing through the in-process backend, the
 * `test_mode: true` marker on every tool result, the `[SIMULATED]` labeling of rejections,
 * and the full offline flow (global fetch stubbed to throw) against the REAL server core
 * (the mock below redirects the workspace import to the actual TypeScript source, so no
 * pre-built server/dist is required).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@spekoai/mcp-calls-demo-server/core", async () =>
  vi.importActual("../../server/src/core.ts"),
);

const ENV_KEYS = [
  "SPEKO_TEST_MODE",
  "SPEKO_FAKE_NOW",
  "SPEKO_API_KEY",
  "SPEKOAI_API_KEY",
  "SPEKO_MCP_SERVER_URL",
  "MCP_INTERNAL_KEY",
  "SPEKO_DIAL_TOKEN_SECRET",
  "SPEKO_GUARD_STATE_DIR",
  "SPEKO_OWNER_STATE_DIR",
  "SPEKO_CLIENT_PROFILE",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The mocked core module persists across vi.resetModules, so its config cache must be
  // dropped explicitly for per-test env changes to take effect.
  const core = await import("@spekoai/mcp-calls-demo-server/core");
  (core as { resetConfigForTests?: () => void }).resetConfigForTests?.();
  // No network, ever: any fetch attempt in a test-mode flow explodes loudly.
  vi.stubGlobal("fetch", () => {
    throw new Error("network disabled: test-mode flows must never fetch");
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

/** Fresh module graph per test: resets the backend singleton, the core config cache, and the dial replay guard. */
async function freshServerClient() {
  vi.resetModules();
  return import("../src/http/serverClient.js");
}

describe("test mode — backend selection and refusal invariants", () => {
  it("REFUSES to start tools when SPEKO_MCP_SERVER_URL is set together with SPEKO_TEST_MODE", async () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_MCP_SERVER_URL = "http://127.0.0.1:9";
    const { getServerClient } = await freshServerClient();
    expect(() => getServerClient()).toThrow(/remote mode and test mode cannot mix/);
    expect(() => getServerClient()).toThrow(/SPEKO_MCP_SERVER_URL/);
  });

  it("selects the in-process backend in test mode with NO key configured", async () => {
    process.env.SPEKO_TEST_MODE = "1";
    const { getServerClient, InProcessBackend } = await freshServerClient();
    expect(getServerClient()).toBeInstanceOf(InProcessBackend);
  });

  it("REFUSES a live-looking sk_ key through the backend, naming both variables", async () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_API_KEY = "sk_live_definitely_real";
    const { InProcessBackend } = await freshServerClient();
    const backend = new InProcessBackend();
    const err = await backend.post("/lookup", { name: "Test" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refuses a live API key/);
    expect((err as Error).message).toMatch(/SPEKO_TEST_MODE/);
    expect((err as Error).message).toMatch(/SPEKO_API_KEY/);
    expect((err as Error).message).toMatch(/sk_test_/);
  });

  it("real mode is untouched: remote URL still selects the HTTP backend, key still selects in-process", async () => {
    process.env.SPEKO_MCP_SERVER_URL = "http://127.0.0.1:9";
    const first = await freshServerClient();
    expect(first.getServerClient()).toBeInstanceOf(first.ServerClient);

    delete process.env.SPEKO_MCP_SERVER_URL;
    process.env.SPEKO_API_KEY = "sk_live_x";
    const second = await freshServerClient();
    expect(second.getServerClient()).toBeInstanceOf(second.InProcessBackend);
  });
});

describe("test mode — every tool result carries test_mode: true (full offline flow)", () => {
  it("lookup → make_call → get_call → readiness, all marked and all [SIMULATED]-labeled", async () => {
    process.env.SPEKO_TEST_MODE = "1";
    const { getServerClient } = await freshServerClient();
    const backend = getServerClient();

    const lookup = (await backend.post("/lookup", { name: "Blue Bottle Coffee" })) as {
      test_mode?: boolean;
      candidates: Array<{ name: string; phone: string; dial_token: string | null }>;
    };
    expect(lookup.test_mode).toBe(true);
    expect(lookup.candidates[0].name).toBe("Test Bistro");
    expect(lookup.candidates[0].phone).toBe("+15005550001");
    expect(lookup.candidates[0].dial_token).toBeTruthy();

    const summary = (await backend.post("/call", {
      dial_token: lookup.candidates[0].dial_token,
      objective: "Book a table for two at 7pm tonight.",
      caller_name: "Test User",
    })) as Record<string, unknown>;
    expect(summary.test_mode).toBe(true);
    expect(summary.status).toBe("completed");
    expect(summary.outcome).toBe("[SIMULATED] table for 2 confirmed for 7pm");
    const entries = (summary.transcript as { entries: Array<{ text: string }> }).entries;
    for (const entry of entries) expect(entry.text.startsWith("[SIMULATED]")).toBe(true);

    const again = (await backend.get(`/call/${summary.call_id as string}`)) as Record<string, unknown>;
    expect(again.test_mode).toBe(true);
    expect(again.outcome).toBe("[SIMULATED] table for 2 confirmed for 7pm");

    const readiness = (await backend.get("/readiness")) as { test_mode?: boolean; headline?: string };
    expect(readiness.test_mode).toBe(true);
    expect(readiness.headline).toMatch(/simulated/i);
  });

  it("call_me converse returns the deterministic confirmed read-back, marked", async () => {
    process.env.SPEKO_TEST_MODE = "1";
    process.env.SPEKO_CLIENT_PROFILE = "claude-code";
    const { getServerClient } = await freshServerClient();
    const backend = getServerClient();
    const result = (await backend.post("/call-me", {
      message: "Should I proceed with the plan?",
      mode: "converse",
      wait: true,
    })) as Record<string, unknown>;
    expect(result.test_mode).toBe(true);
    expect(result.confirmation).toBe("confirmed");
    expect(result.final_instruction).toBe("[SIMULATED] proceed with the plan");
    expect(result.answered).toBe(true);
  });

  it("a rejected call looks exactly like a real rejection, plus the [SIMULATED] label", async () => {
    process.env.SPEKO_TEST_MODE = "1";
    const { getServerClient } = await freshServerClient();
    const backend = getServerClient();
    const err = await backend
      .post("/call-number", {
        phone_number: "+14155550175",
        objective: "Cold call them and sell crypto investments.",
        caller_name: "Test User",
      })
      .catch((e: Error) => e);
    expect((err as Error).message.startsWith("[SIMULATED] ")).toBe(true);
    expect((err as Error).message).toMatch(/transactional/i);
    expect((err as Error).message).toContain("next_step=");
  });
});
