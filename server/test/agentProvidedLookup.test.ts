import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the carrier line-type check so we can drive it without hitting Twilio.
vi.mock("../src/lookup/twilio.js", () => ({
  carrierLineType: vi.fn(async () => "landline"),
}));

import type { AppConfig } from "../src/config.js";
import { lookupBusiness } from "../src/lookup/index.js";
import { carrierLineType } from "../src/lookup/twilio.js";
import { verifyDialToken } from "../src/safety/dialToken.js";

const SECRET = "test-agent-secret";
const BEARER_HASH = "abc123def456abcd";

/** Minimal config — lookupBusiness only reads twilio, dialTokenSecret, googlePlacesApiKey. */
function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dialTokenSecret: SECRET,
    googlePlacesApiKey: undefined,
    twilio: undefined,
    ...overrides,
  } as unknown as AppConfig;
}

const ENV_KEYS = [
  "SPEKO_DEMO",
  "SPEKO_DEMO_E164",
  "SPEKO_DEMO_BUSINESS",
  "SPEKO_DEMO_UTC_OFFSET",
  "SPEKO_DIAL_TOKEN_SECRET",
] as const;

describe("agent-provided lookup", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SPEKO_DIAL_TOKEN_SECRET = SECRET;
    vi.mocked(carrierLineType).mockResolvedValue("landline");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.clearAllMocks();
  });

  it("mints a verifiable token for a carrier-confirmed business number, normalizing the input", async () => {
    const out = await lookupBusiness(
      { name: "Sakura Sushi", phoneNumber: "+1 (415) 555-0123" },
      { cfg: cfg({ twilio: { sid: "s", token: "t" } }), bearerHash: BEARER_HASH },
    );

    expect(out.source).toBe("agent_provided");
    expect(carrierLineType).toHaveBeenCalledWith("+14155550123", { sid: "s", token: "t" });

    const c = out.candidates[0];
    expect(c.allowed).toBe(true);
    expect(c.phone).toBe("+14155550123");
    expect(c.dial_token).toBeTypeOf("string");

    const payload = verifyDialToken(c.dial_token as string, { expectedBearerHash: BEARER_HASH, secret: SECRET });
    expect(payload.e164).toBe("+14155550123");
    expect(payload.line_type).toBe("landline");
    expect(payload.business_name).toBe("Sakura Sushi");
  });

  it("blocks an agent-provided MOBILE number with no token (the moat holds)", async () => {
    vi.mocked(carrierLineType).mockResolvedValue("mobile");

    const out = await lookupBusiness(
      { name: "Someone", phoneNumber: "+14155550123" },
      { cfg: cfg({ twilio: { sid: "s", token: "t" } }), bearerHash: BEARER_HASH },
    );

    const c = out.candidates[0];
    expect(c.allowed).toBe(false);
    expect(c.dial_token).toBeNull();
    expect(c.blocked_reason).toBeTruthy();
  });

  it("fails closed when Twilio is not configured (line type unconfirmed → blocked)", async () => {
    const out = await lookupBusiness(
      { name: "Sakura Sushi", phoneNumber: "+14155550123" },
      { cfg: cfg(), bearerHash: BEARER_HASH }, // no twilio
    );

    expect(out.source).toBe("agent_provided");
    expect(carrierLineType).not.toHaveBeenCalled();
    const c = out.candidates[0];
    expect(c.allowed).toBe(false);
    expect(c.dial_token).toBeNull();
  });

  it("lets demo mode win over an agent-provided number", async () => {
    process.env.SPEKO_DEMO = "1";
    process.env.SPEKO_DEMO_E164 = "+77011234567";

    const out = await lookupBusiness(
      { name: "Sakura Sushi", phoneNumber: "+14155550123" },
      { cfg: cfg({ twilio: { sid: "s", token: "t" } }), bearerHash: BEARER_HASH },
    );

    expect(out.source).toBe("demo");
    expect(out.candidates[0].phone).toBe("+77011234567");
  });

  it("treats an empty phone_number as not provided (falls through to the directory)", async () => {
    await expect(
      lookupBusiness({ name: "X", phoneNumber: "" }, { cfg: cfg(), bearerHash: BEARER_HASH }),
    ).rejects.toThrow(/directory|configured|phone_number/i);
  });
});
