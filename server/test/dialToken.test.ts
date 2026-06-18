import { describe, expect, it } from "vitest";
import {
  DialTokenError,
  dialBlockedReason,
  lineTypeBlockedReason,
  mintDialToken,
  quietHoursReason,
  verifyDialToken,
} from "../src/safety/dialToken.js";

const SECRET = "test-secret";
const base = {
  e164: "+14155550132",
  lineType: "landline",
  businessName: "Joe's Pizza",
  utcOffsetMinutes: -240,
  secret: SECRET,
};

describe("dial token mint/verify", () => {
  it("round-trips and returns the payload", () => {
    const token = mintDialToken({ ...base, bearerHash: "h1", now: 1000 });
    const payload = verifyDialToken(token, { expectedBearerHash: "h1", secret: SECRET, now: 1100 });
    expect(payload.e164).toBe(base.e164);
    expect(payload.line_type).toBe("landline");
    expect(payload.bh).toBe("h1");
  });

  it("rejects an expired token", () => {
    const token = mintDialToken({ ...base, bearerHash: "h1", ttlSeconds: 900, now: 1000 });
    expect(() => verifyDialToken(token, { expectedBearerHash: "h1", secret: SECRET, now: 2000 })).toThrow(
      DialTokenError,
    );
  });

  it("rejects a tampered token", () => {
    const token = mintDialToken({ ...base, bearerHash: "h1", now: 1000 });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => verifyDialToken(tampered, { expectedBearerHash: "h1", secret: SECRET, now: 1100 })).toThrow(
      DialTokenError,
    );
  });

  it("rejects a token minted for a different account", () => {
    const token = mintDialToken({ ...base, bearerHash: "h1", now: 1000 });
    expect(() => verifyDialToken(token, { expectedBearerHash: "h2", secret: SECRET, now: 1100 })).toThrow(
      /different account/,
    );
  });

  it("requires the secret", () => {
    expect(() => mintDialToken({ ...base, secret: "", now: 1000 })).toThrow(DialTokenError);
  });
});

describe("dial predicates", () => {
  it("allows a normal E.164 number", () => {
    expect(dialBlockedReason("+14155550132")).toBeNull();
  });
  it("blocks emergency + premium-rate numbers and bad formats", () => {
    expect(dialBlockedReason("+911")).toMatch(/emergency/);
    expect(dialBlockedReason("+19005551234")).toMatch(/premium-rate/);
    expect(dialBlockedReason("4155550132")).toMatch(/E\.164/);
  });
  it("blocks mobile + unknown line types, allows landline", () => {
    expect(lineTypeBlockedReason("mobile")).toMatch(/business-lines-only/);
    expect(lineTypeBlockedReason(null)).toMatch(/unknown/);
    expect(lineTypeBlockedReason("landline")).toBeNull();
  });
});

describe("quiet hours", () => {
  it("fails closed when the offset is unknown", () => {
    expect(quietHoursReason(null)).toMatch(/unknown/);
  });
  it("allows midday local and blocks late-night local", () => {
    const noon = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;
    const lateNight = Date.UTC(2026, 0, 1, 23, 0, 0) / 1000;
    expect(quietHoursReason(0, noon)).toBeNull();
    expect(quietHoursReason(0, lateNight)).toMatch(/quiet hours/);
  });
});
