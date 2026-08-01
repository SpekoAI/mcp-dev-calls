import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMe, type MeIo } from "../src/cli/me.js";

function io(answers: string[] = []) {
  const output: string[] = [];
  const asked: string[] = [];
  const adapter: MeIo = {
    ask: async (query) => {
      asked.push(query);
      return answers.shift() ?? "";
    },
    write: (message) => output.push(message),
  };
  return { adapter, output, asked };
}

const originalApiKey = process.env.SPEKO_API_KEY;
const originalDialSecret = process.env.SPEKO_DIAL_TOKEN_SECRET;
const originalServerUrl = process.env.SPEKO_MCP_SERVER_URL;
const TEST_OWNER = "+12025550144";

beforeEach(() => {
  delete process.env.SPEKO_API_KEY;
  delete process.env.SPEKO_DIAL_TOKEN_SECRET;
  delete process.env.SPEKO_MCP_SERVER_URL;
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.SPEKO_API_KEY;
  else process.env.SPEKO_API_KEY = originalApiKey;
  if (originalDialSecret === undefined) delete process.env.SPEKO_DIAL_TOKEN_SECRET;
  else process.env.SPEKO_DIAL_TOKEN_SECRET = originalDialSecret;
  if (originalServerUrl === undefined) delete process.env.SPEKO_MCP_SERVER_URL;
  else process.env.SPEKO_MCP_SERVER_URL = originalServerUrl;
});

function core(overrides: Record<string, unknown> = {}) {
  return {
    readOwnerProfile: () => null,
    normalizeNanpOwnerPhone: (value: string) => (/^\+1\d{10}$/.test(value) ? value : null),
    loadConfig: () => ({ ownerStateDir: "/tmp/unused" }),
    buildContext: (cfg: unknown) => ({ cfg, client: {}, bearerHash: "bearer" }),
    createOwnerVerificationChallenge: () => ({
      code: "123456",
      created_at_ms: 0,
      expires_at_ms: Date.now() + 60_000,
      attempts_remaining: 3,
    }),
    placeOwnerVerificationCall: vi.fn(async () => ({ call_id: "call_1", status: "completed" })),
    checkOwnerVerificationCode: (challenge: { code: string; attempts_remaining: number }, candidate: string) => {
      challenge.attempts_remaining -= 1;
      if (candidate === challenge.code) return "verified";
      return challenge.attempts_remaining > 0 ? "invalid" : "attempts_exhausted";
    },
    writeOwnerProfile: vi.fn(({ ownerPhone, ownerName }: { ownerPhone: string; ownerName: string }) => ({
      owner_phone: ownerPhone,
      owner_name: ownerName,
      verify_method: "voice_otp",
    })),
    ...overrides,
  };
}

describe("speko me", () => {
  it("prints usage for an unknown subcommand without loading the calling core", async () => {
    const stream = io();
    const loadCore = vi.fn();
    expect(await runMe(["unknown"], stream.adapter, { loadCore: loadCore as any })).toBe(2);
    expect(loadCore).not.toHaveBeenCalled();
    expect(stream.output.join("")).toContain("speko me verify");
    expect(stream.output.join("")).not.toContain("--token");
  });

  it("reports missing state with the exact verification command", async () => {
    const stream = io();
    expect(await runMe(["status"], stream.adapter, { loadCore: async () => core() as any })).toBe(1);
    expect(stream.output.join("")).toContain("speko me verify");
  });

  it("reports only last four for a verified owner and reiterates retained rails", async () => {
    const stream = io();
    const owner = { owner_phone: TEST_OWNER, verify_method: "voice_otp" };
    expect(
      await runMe(["status"], stream.adapter, {
        loadCore: async () => core({ readOwnerProfile: () => owner }) as any,
      }),
    ).toBe(0);
    const output = stream.output.join("");
    expect(output).toContain("ending 0144");
    expect(output).not.toContain(TEST_OWNER);
    expect(output).toMatch(/never relaxes DNC, rate caps, or quiet hours/i);
  });

  it("rejects non-NANP input before placing a call", async () => {
    const stream = io();
    const fake = core();
    expect(
      await runMe(
        ["verify", "--name", "Bek", "--phone", "+442079460958", "--yes"],
        stream.adapter,
        { loadCore: async () => fake as any, apiKey: "sk_test" },
      ),
    ).toBe(1);
    expect(fake.placeOwnerVerificationCall).not.toHaveBeenCalled();
    expect(fake.writeOwnerProfile).not.toHaveBeenCalled();
  });

  it("cancels cleanly before calling when approval is not explicit", async () => {
    const stream = io(["no"]);
    const fake = core();
    expect(
      await runMe(
        ["verify", "--name", "Bek", "--phone", TEST_OWNER],
        stream.adapter,
        { loadCore: async () => fake as any, apiKey: "sk_test" },
      ),
    ).toBe(1);
    expect(fake.placeOwnerVerificationCall).not.toHaveBeenCalled();
    expect(stream.output.join("")).toContain("no call was placed");
  });

  it("writes owner state only after the exact called code is entered", async () => {
    const stream = io(["123456"]);
    const fake = core();
    expect(
      await runMe(
        ["verify", "--name", "Bek", "--phone", TEST_OWNER, "--yes"],
        stream.adapter,
        { loadCore: async () => fake as any, apiKey: "sk_secret_key" },
      ),
    ).toBe(0);
    expect(fake.placeOwnerVerificationCall).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPhone: TEST_OWNER,
        ownerName: "Bek",
        verificationCode: "123456",
      }),
      expect.any(Object),
    );
    expect(fake.writeOwnerProfile).toHaveBeenCalledWith({ ownerPhone: TEST_OWNER, ownerName: "Bek" });
    const output = stream.output.join("");
    expect(output).not.toContain("sk_secret_key");
    expect(output).not.toContain("123456");
    expect(output).not.toContain(TEST_OWNER);
    expect(output).toContain("ending 0144");
  });

  it("never writes owner state after three bad code attempts", async () => {
    const stream = io(["000000", "111111", "222222"]);
    const fake = core();
    expect(
      await runMe(
        ["verify", "--name", "Bek", "--phone", TEST_OWNER, "--yes"],
        stream.adapter,
        { loadCore: async () => fake as any, apiKey: "sk_test" },
      ),
    ).toBe(1);
    expect(fake.writeOwnerProfile).not.toHaveBeenCalled();
    expect(stream.output.join("")).toContain("attempts exhausted");
  });

  it("does not ask for a code or write state when the call was not placed", async () => {
    const stream = io();
    const fake = core({
      placeOwnerVerificationCall: vi.fn(async () => ({ call_id: null, status: "not_placed" })),
    });
    expect(
      await runMe(
        ["verify", "--name", "Bek", "--phone", TEST_OWNER, "--yes"],
        stream.adapter,
        { loadCore: async () => fake as any, apiKey: "sk_test" },
      ),
    ).toBe(1);
    expect(stream.asked).toHaveLength(0);
    expect(fake.writeOwnerProfile).not.toHaveBeenCalled();
  });

  it.each(["status", "verify"])("rejects remote %s before loading core or prompting", async (command) => {
    const stream = io(["should not be read"]);
    const loadCore = vi.fn();
    const env = { ...process.env, SPEKO_MCP_SERVER_URL: "https://mcp.example.test" };
    expect(
      await runMe([command, "--phone", TEST_OWNER, "--yes"], stream.adapter, {
        loadCore: loadCore as any,
        apiKey: "sk_test",
        env,
      }),
    ).toBe(1);
    expect(loadCore).not.toHaveBeenCalled();
    expect(stream.asked).toHaveLength(0);
    expect(stream.output.join("")).toContain("backing server");
  });
});
