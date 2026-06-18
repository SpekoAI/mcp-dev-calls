import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoEnabled, demoLookupCandidate } from "../src/lookup/demo.js";
import { verifyDialToken } from "../src/safety/dialToken.js";

const SECRET = "test-demo-secret";
const BEARER_HASH = "abc123def456abcd";

const DEMO_ENV_KEYS = [
  "SPEKO_DEMO",
  "SPEKO_DEMO_E164",
  "SPEKO_DEMO_BUSINESS",
  "SPEKO_DEMO_LINE_TYPE",
  "SPEKO_DEMO_UTC_OFFSET",
  "SPEKO_DEMO_ADDRESS",
  "SPEKO_DIAL_TOKEN_SECRET",
] as const;

describe("demo lookup", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of DEMO_ENV_KEYS) saved[k] = process.env[k];
    for (const k of DEMO_ENV_KEYS) delete process.env[k];
    process.env.SPEKO_DIAL_TOKEN_SECRET = SECRET;
  });

  afterEach(() => {
    for (const k of DEMO_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is off by default and on when flagged", () => {
    expect(demoEnabled()).toBe(false);
    process.env.SPEKO_DEMO = "1";
    expect(demoEnabled()).toBe(true);
  });

  it("mints a verifiable dial_token for a valid demo target", () => {
    process.env.SPEKO_DEMO = "1";
    process.env.SPEKO_DEMO_E164 = "+77011234567";
    process.env.SPEKO_DEMO_UTC_OFFSET = "300";

    const c = demoLookupCandidate({ name: "Sakura Sushi" }, BEARER_HASH);

    expect(c.allowed).toBe(true);
    expect(c.name).toBe("Sakura Sushi");
    expect(c.phone).toBe("+77011234567");
    expect(c.dial_token).toBeTypeOf("string");

    const payload = verifyDialToken(c.dial_token as string, {
      expectedBearerHash: BEARER_HASH,
      secret: SECRET,
    });
    expect(payload.e164).toBe("+77011234567");
    expect(payload.line_type).toBe("voip");
    expect(payload.utc_offset_minutes).toBe(300);
  });

  it("refuses an invalid number without a token", () => {
    process.env.SPEKO_DEMO = "1";
    process.env.SPEKO_DEMO_E164 = "not-a-number";

    const c = demoLookupCandidate({ name: "Sakura Sushi" }, BEARER_HASH);

    expect(c.allowed).toBe(false);
    expect(c.dial_token).toBeNull();
    expect(c.blocked_reason).toBeTruthy();
  });
});
