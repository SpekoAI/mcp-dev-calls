import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the carrier line-type check so we can drive it without hitting Twilio.
vi.mock("../src/lookup/twilio.js", () => ({
  carrierLineType: vi.fn(async () => "landline"),
}));

import { makeCall } from "../src/calls/makeCall.js";
import type { AppConfig } from "../src/config.js";
import { lookupBusiness } from "../src/lookup/index.js";
import type { SpekoClient } from "../src/speko/client.js";
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
    vi.useRealTimers(); // catch-all: never leak fake timers to other tests
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

  // Cross-tool round-trip: the token minted by the agent-provided path must be accepted by
  // make_call (which independently re-checks line type + quiet hours from the token bytes),
  // dial the EXACT number with the non-removable AI disclosure, and — with a realistic
  // connected session + a caller turn — be reported as a connected, answered call.
  it("agent-provided token round-trips through make_call: accepted, dials, discloses, connects", async () => {
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-27T18:00:00.000Z")); // ~10am-2pm across US zones → business hours

      const config = cfg({
        twilio: { sid: "s", token: "t" },
        ttsPin: "elevenlabs:eleven_flash_v2_5",
        sttPin: "deepgram:nova-3",
        llmPin: "",
        optimizeFor: "latency",
        ttsSpeed: 1.0,
      } as Partial<AppConfig>);

      const look = await lookupBusiness(
        { name: "Sakura Sushi", phoneNumber: "+14155550123" },
        { cfg: config, bearerHash: BEARER_HASH },
      );
      const token = look.candidates[0].dial_token as string;
      expect(token).toBeTypeOf("string");

      let dialed: Record<string, unknown> | null = null;
      const fakeClient = {
        listPhoneNumbers: async () => [],
        dial: async (body: Record<string, unknown>) => {
          dialed = body;
          return { sessionId: "sess1", status: "dialing", callControlId: "cc123", from: "+15551112222" };
        },
        getCall: async () => ({
          status: "ended",
          transcript: [
            { source: "agent", text: "Hi, this is Bruce's AI assistant — table for 4 at 8pm tonight?" },
            { source: "user", text: "Yep, 8pm works — booked under Bruce." },
          ],
          report: { outcome: "Table for 4 at 8pm, booked under Bruce" },
        }),
        // Realistic connected session: a callControlId + carrier usage prove a real outbound leg.
        getSession: async () => ({
          phoneCall: { callControlId: "cc123" },
          usage: [{ provider: "telnyx", metric: "telephony_minutes" }],
          durationSeconds: 42,
        }),
      };

      const summary = await makeCall(
        { dialToken: token, objective: "Do you have a table for 4 at 8pm tonight?", callerName: "Bruce", context: null },
        { client: fakeClient as unknown as SpekoClient, cfg: config, bearerHash: BEARER_HASH, sleep: async () => {} },
      );

      // Token accepted (no rejection) and dialed the EXACT agent-provided number.
      expect(dialed).not.toBeNull();
      const body = dialed as Record<string, unknown>;
      expect(body.to).toBe("+14155550123");
      // Disclosure is always present + names the caller (buildFirstMessage is pure).
      expect(String(body.firstMessage)).toMatch(/AI assistant/i);
      expect(String(body.firstMessage)).toContain("Bruce");
      expect(body.systemPrompt).toBeTypeOf("string");
      // Full happy path: connected (callControlId + carrier usage) → answered (caller turn) → outcome.
      expect(summary.call_id).toBe("sess1");
      expect(summary.connected).toBe(true);
      expect(summary.answered).toBe(true);
      expect(String(summary.outcome)).toContain("booked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks at lookup when the timezone can't be determined (unlisted region, no utc_offset)", async () => {
    const out = await lookupBusiness(
      { name: "Mystery Diner", phoneNumber: "+19995551234" }, // 999 not in the NANP table → null offset
      { cfg: cfg({ twilio: { sid: "s", token: "t" } }), bearerHash: BEARER_HASH },
    );
    const c = out.candidates[0];
    expect(c.allowed).toBe(false);
    expect(c.dial_token).toBeNull();
    expect(c.blocked_reason).toMatch(/timezone|quiet hours|utc_offset/i);
  });

  it("accepts an unlisted-region number when utc_offset_minutes is provided (escape hatch)", async () => {
    const out = await lookupBusiness(
      { name: "Mystery Diner", phoneNumber: "+19995551234", utcOffsetMinutes: -300 },
      { cfg: cfg({ twilio: { sid: "s", token: "t" } }), bearerHash: BEARER_HASH },
    );
    const c = out.candidates[0];
    expect(c.allowed).toBe(true);
    expect(c.dial_token).toBeTypeOf("string");
    const payload = verifyDialToken(c.dial_token as string, { expectedBearerHash: BEARER_HASH, secret: SECRET });
    expect(payload.utc_offset_minutes).toBe(-300);
  });
});
