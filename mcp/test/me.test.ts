import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMe, type MeIo } from "../src/cli/me.js";

function io(answers: string[] = []) {
  const output: string[] = [];
  const asked: string[] = [];
  const warned: string[] = [];
  const adapter: MeIo = {
    ask: async (query) => {
      asked.push(query);
      return answers.shift() ?? "";
    },
    write: (message) => output.push(message),
    warn: (message) => warned.push(message),
  };
  return { adapter, output, asked, warned };
}

const originalApiKey = process.env.SPEKO_API_KEY;
const originalDialSecret = process.env.SPEKO_DIAL_TOKEN_SECRET;
const originalServerUrl = process.env.SPEKO_MCP_SERVER_URL;
const originalOwnerBlob = process.env.SPEKO_OWNER_PROFILE;
const TEST_OWNER = "+12025550144";

beforeEach(() => {
  delete process.env.SPEKO_API_KEY;
  delete process.env.SPEKO_DIAL_TOKEN_SECRET;
  delete process.env.SPEKO_MCP_SERVER_URL;
  delete process.env.SPEKO_OWNER_PROFILE;
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.SPEKO_API_KEY;
  else process.env.SPEKO_API_KEY = originalApiKey;
  if (originalDialSecret === undefined) delete process.env.SPEKO_DIAL_TOKEN_SECRET;
  else process.env.SPEKO_DIAL_TOKEN_SECRET = originalDialSecret;
  if (originalServerUrl === undefined) delete process.env.SPEKO_MCP_SERVER_URL;
  else process.env.SPEKO_MCP_SERVER_URL = originalServerUrl;
  if (originalOwnerBlob === undefined) delete process.env.SPEKO_OWNER_PROFILE;
  else process.env.SPEKO_OWNER_PROFILE = originalOwnerBlob;
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
    encodeOwnerProfileBlob: vi.fn(() => "spkow1.PORTABLEBLOB"),
    decodeOwnerProfileBlob: vi.fn(() => {
      throw new Error("the value does not start with \"spkow1.\"");
    }),
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
    expect(stream.output.join("")).toContain("speko me export");
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

  it("exports the active owner as a stdout blob with the credential warning on stderr", async () => {
    const stream = io();
    const owner = {
      owner_phone: TEST_OWNER,
      owner_name: "Bek",
      verify_method: "voice_otp",
      instance_id: "11111111-2222-4333-8444-555555555555",
    };
    const fake = core({ readOwnerProfile: () => owner });
    expect(await runMe(["export"], stream.adapter, { loadCore: async () => fake as any })).toBe(0);
    expect(fake.encodeOwnerProfileBlob).toHaveBeenCalledWith(owner);
    expect(stream.output.join("")).toBe("spkow1.PORTABLEBLOB\n");
    expect(stream.warned.join("")).toContain("credential-equivalent");
    expect(stream.warned.join("")).toContain("SPEKO_OWNER_PROFILE");
    expect(stream.output.join("")).not.toContain(TEST_OWNER);
  });

  it("refuses to export when no verified owner exists", async () => {
    const stream = io();
    const fake = core();
    expect(await runMe(["export"], stream.adapter, { loadCore: async () => fake as any })).toBe(1);
    expect(fake.encodeOwnerProfileBlob).not.toHaveBeenCalled();
    expect(stream.output.join("")).toContain("speko me verify");
  });

  it("reports the env seed as the owner source when the active owner matches the blob", async () => {
    const stream = io();
    const owner = {
      owner_phone: TEST_OWNER,
      owner_name: "Bek",
      verify_method: "voice_otp",
      instance_id: "11111111-2222-4333-8444-555555555555",
    };
    const env = { ...process.env, SPEKO_OWNER_PROFILE: "spkow1.PORTABLEBLOB" };
    const fake = core({
      readOwnerProfile: () => owner,
      decodeOwnerProfileBlob: vi.fn(() => owner),
    });
    expect(await runMe(["status"], stream.adapter, { loadCore: async () => fake as any, env })).toBe(0);
    const output = stream.output.join("");
    expect(output).toContain("SPEKO_OWNER_PROFILE");
    expect(output).toContain("ending 0144");
    expect(output).not.toContain(TEST_OWNER);
  });

  it("never credits a tampered env blob as the owner source", async () => {
    const stream = io();
    const owner = { owner_phone: TEST_OWNER, owner_name: "Bek", verify_method: "voice_otp" };
    const env = { ...process.env, SPEKO_OWNER_PROFILE: "spkow1.TAMPERED" };
    const fake = core({ readOwnerProfile: () => owner });
    expect(await runMe(["status"], stream.adapter, { loadCore: async () => fake as any, env })).toBe(0);
    expect(stream.output.join("")).not.toContain("Owner source");
  });

  it("explains the pending env seed when status runs before the backend materializes it", async () => {
    const stream = io();
    const env = { ...process.env, SPEKO_OWNER_PROFILE: "spkow1.PORTABLEBLOB" };
    expect(await runMe(["status"], stream.adapter, { loadCore: async () => core() as any, env })).toBe(1);
    expect(stream.output.join("")).toContain("SPEKO_OWNER_PROFILE is set");
  });

  it.each(["status", "verify", "export"])("rejects remote %s before loading core or prompting", async (command) => {
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
