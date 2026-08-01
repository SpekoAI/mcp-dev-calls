import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkOwnerVerificationCode,
  createOwnerVerificationChallenge,
  normalizeNanpOwnerPhone,
  readOwnerProfile,
  reserveOwnerVerificationCall,
  writeOwnerProfile,
} from "../src/owner/state.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speko-owner-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("local owner profile", () => {
  it("normalizes valid NANP formatting and rejects non-NANP or invalid NXX numbers", () => {
    expect(normalizeNanpOwnerPhone("+1 (346) 376-0044")).toBe("+13463760044");
    expect(normalizeNanpOwnerPhone("+44 20 7946 0958")).toBeNull();
    expect(normalizeNanpOwnerPhone("+1 046 376 0044")).toBeNull();
    expect(normalizeNanpOwnerPhone("+1 346 076 0044")).toBeNull();
  });

  it("writes an atomic private profile and reads only validated fields", () => {
    const profile = writeOwnerProfile(
      {
        ownerPhone: "+1 (346) 376-0044",
        ownerName: "Bek",
        verifiedAt: "2026-08-01T12:00:00.000Z",
        instanceId: "11111111-2222-4333-8444-555555555555",
      },
      dir,
    );
    expect(profile.owner_phone).toBe("+13463760044");
    expect(readOwnerProfile(dir)).toEqual(profile);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "owner.json")).mode & 0o777).toBe(0o600);
    }
    const persisted = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("code");
    expect(persisted).not.toHaveProperty("verification_code");
  });

  it("fails closed for a missing, corrupt, or forged profile", () => {
    expect(readOwnerProfile(dir)).toBeNull();
    writeFileSync(join(dir, "owner.json"), "{not-json");
    expect(readOwnerProfile(dir)).toBeNull();
    writeFileSync(
      join(dir, "owner.json"),
      JSON.stringify({
        version: 1,
        owner_phone: "+442079460958",
        owner_name: "Bek",
        phone_verified_at: new Date().toISOString(),
        verify_method: "voice_otp",
        instance_id: "11111111-2222-4333-8444-555555555555",
      }),
    );
    expect(readOwnerProfile(dir)).toBeNull();
  });
});

describe("owner voice OTP", () => {
  it("uses six digits, expires at ten minutes, and permits only three attempts", () => {
    const generated = createOwnerVerificationChallenge(1_000);
    expect(generated.code).toMatch(/^\d{6}$/);
    expect(generated.expires_at_ms).toBe(1_000 + 10 * 60 * 1_000);
    const challenge = { ...generated, code: "123456" };
    expect(checkOwnerVerificationCode(challenge, "000000", 2_000)).toBe("invalid");
    expect(checkOwnerVerificationCode(challenge, "not the code", 2_000)).toBe("invalid");
    expect(checkOwnerVerificationCode(challenge, "still wrong", 2_000)).toBe("attempts_exhausted");

    const expired = createOwnerVerificationChallenge(5_000);
    expect(checkOwnerVerificationCode(expired, expired.code, expired.expires_at_ms)).toBe("expired");
    expect(expired.attempts_remaining).toBe(3);
  });

  it("accepts the exact code without persisting it", () => {
    const challenge = createOwnerVerificationChallenge(10_000);
    expect(checkOwnerVerificationCode(challenge, challenge.code, 10_001)).toBe("verified");
    expect(challenge.attempts_remaining).toBe(2);
    expect(existsSync(join(dir, "owner-verification.jsonl"))).toBe(false);
  });

  it("caps verification calls at three per number in a rolling 24-hour window", () => {
    const phone = "+13463760044";
    const start = Date.parse("2026-08-01T12:00:00.000Z");
    reserveOwnerVerificationCall(phone, { dir, nowMs: start });
    reserveOwnerVerificationCall(phone, { dir, nowMs: start + 1 });
    reserveOwnerVerificationCall(phone, { dir, nowMs: start + 2 });
    expect(() => reserveOwnerVerificationCall(phone, { dir, nowMs: start + 3 })).toThrow(/3 in 24 hours/i);
    expect(() => reserveOwnerVerificationCall(phone, { dir, nowMs: start + 24 * 60 * 60 * 1_000 + 1 })).not.toThrow();
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "owner-verification.jsonl")).mode & 0o777).toBe(0o600);
    }
  });
});
