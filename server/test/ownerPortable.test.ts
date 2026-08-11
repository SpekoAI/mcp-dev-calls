import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildContext } from "../src/http/context.js";
import { AppError } from "../src/lib/errors.js";
import { decodeOwnerProfileBlob, encodeOwnerProfileBlob, seedOwnerProfileFromEnv } from "../src/owner/portable.js";
import { readOwnerProfile, writeOwnerProfile, type OwnerProfile } from "../src/owner/state.js";

let sourceDir = "";
let targetDir = "";

const FIXTURE = {
  ownerPhone: "+12025550144",
  ownerName: "Bek",
  verifiedAt: "2026-08-01T12:00:00.000Z",
  instanceId: "11111111-2222-4333-8444-555555555555",
};

function verifiedProfile(dir = sourceDir): OwnerProfile {
  return writeOwnerProfile(FIXTURE, dir);
}

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), "speko-owner-export-"));
  targetDir = mkdtempSync(join(tmpdir(), "speko-owner-import-"));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("owner profile export blob", () => {
  it("round-trips a verified profile through one compact single-line blob", () => {
    const profile = verifiedProfile();
    const blob = encodeOwnerProfileBlob(profile);
    expect(blob).toMatch(/^spkow1\.[A-Za-z0-9_-]+$/);
    expect(blob.length).toBeLessThan(1024);
    expect(decodeOwnerProfileBlob(blob)).toEqual(profile);
  });

  it("stays well under the size bound at the maximum owner-name length", () => {
    const profile = writeOwnerProfile({ ...FIXTURE, ownerName: "B".repeat(80) }, sourceDir);
    expect(encodeOwnerProfileBlob(profile).length).toBeLessThan(1024);
  });

  it("refuses to encode anything that is not a valid owner profile", () => {
    expect(() => encodeOwnerProfileBlob({ owner_phone: "+442079460958" } as unknown as OwnerProfile)).toThrow(
      /refusing to export/i,
    );
  });

  it.each([
    ["garbage", "not-a-blob"],
    ["wrong version prefix", `spkow2.${Buffer.from("{}").toString("base64url")}`],
    ["foreign characters", "spkow1.!!!not-base64url!!!"],
    ["non-JSON payload", `spkow1.${Buffer.from("not json", "utf8").toString("base64url")}`],
    ["oversized payload", `spkow1.${"A".repeat(5000)}`],
  ])("rejects a %s blob", (_label, blob) => {
    expect(() => decodeOwnerProfileBlob(blob)).toThrow();
  });

  it("rejects a schema-invalid profile even when the blob framing is intact", () => {
    const forged = {
      version: 1,
      owner_phone: "+442079460958",
      owner_name: "Bek",
      phone_verified_at: "2026-08-01T12:00:00.000Z",
      verify_method: "voice_otp",
      instance_id: "11111111-2222-4333-8444-555555555555",
    };
    const blob = `spkow1.${Buffer.from(JSON.stringify(forged), "utf8").toString("base64url")}`;
    expect(() => decodeOwnerProfileBlob(blob)).toThrow(/owner-profile validation/i);
  });

  it("rejects a truncated (tampered) export", () => {
    const blob = encodeOwnerProfileBlob(verifiedProfile());
    expect(() => decodeOwnerProfileBlob(blob.slice(0, blob.length - 10))).toThrow();
  });
});

describe("SPEKO_OWNER_PROFILE seeding", () => {
  it("materializes identical owner state into a fresh dir and logs one line", () => {
    const profile = verifiedProfile();
    const log = vi.fn();
    const env = { SPEKO_OWNER_PROFILE: encodeOwnerProfileBlob(profile) } as NodeJS.ProcessEnv;
    expect(seedOwnerProfileFromEnv({ env, dir: targetDir, log })).toBe("seeded");
    expect(readOwnerProfile(targetDir)).toEqual(profile);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("SPEKO_OWNER_PROFILE");
    expect(log.mock.calls[0][0]).toContain("0144");
    expect(log.mock.calls[0][0]).not.toContain(profile.owner_phone);
  });

  it("does nothing when the env var is unset or blank", () => {
    const log = vi.fn();
    expect(seedOwnerProfileFromEnv({ env: {} as NodeJS.ProcessEnv, dir: targetDir, log })).toBe("unset");
    expect(seedOwnerProfileFromEnv({ env: { SPEKO_OWNER_PROFILE: "  " } as NodeJS.ProcessEnv, dir: targetDir, log })).toBe(
      "unset",
    );
    expect(existsSync(join(targetDir, "owner.json"))).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("never overwrites an existing owner.json, which always wins over the env", () => {
    const existing = writeOwnerProfile(
      { ...FIXTURE, ownerPhone: "+12025550100", instanceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      targetDir,
    );
    const envProfile = verifiedProfile();
    const log = vi.fn();
    const env = { SPEKO_OWNER_PROFILE: encodeOwnerProfileBlob(envProfile) } as NodeJS.ProcessEnv;
    expect(seedOwnerProfileFromEnv({ env, dir: targetDir, log })).toBe("kept_existing");
    expect(readOwnerProfile(targetDir)).toEqual(existing);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/ignored/i);
  });

  it("leaves even a corrupt existing owner.json in place rather than replacing it", () => {
    writeFileSync(join(targetDir, "owner.json"), "{broken");
    const env = { SPEKO_OWNER_PROFILE: encodeOwnerProfileBlob(verifiedProfile()) } as NodeJS.ProcessEnv;
    expect(seedOwnerProfileFromEnv({ env, dir: targetDir, log: vi.fn() })).toBe("kept_existing");
    expect(readOwnerProfile(targetDir)).toBeNull();
  });

  it("fails closed on an invalid blob: AppError names the env var and nothing is written", () => {
    const env = { SPEKO_OWNER_PROFILE: "spkow1.tampered" } as NodeJS.ProcessEnv;
    let thrown: unknown;
    try {
      seedOwnerProfileFromEnv({ env, dir: targetDir, log: vi.fn() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).message).toContain("SPEKO_OWNER_PROFILE");
    expect((thrown as AppError).nextStep).toContain("speko me export");
    expect(existsSync(join(targetDir, "owner.json"))).toBe(false);
  });
});

describe("buildContext owner seeding", () => {
  const originalBlob = process.env.SPEKO_OWNER_PROFILE;

  afterEach(() => {
    if (originalBlob === undefined) delete process.env.SPEKO_OWNER_PROFILE;
    else process.env.SPEKO_OWNER_PROFILE = originalBlob;
  });

  function cfg(): AppConfig {
    return { speko: { apiKey: "sk_test", baseUrl: undefined }, ownerStateDir: targetDir } as unknown as AppConfig;
  }

  it("seeds owner state from the env exactly once at backend init", () => {
    const profile = verifiedProfile();
    process.env.SPEKO_OWNER_PROFILE = encodeOwnerProfileBlob(profile);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    buildContext(cfg());
    expect(readOwnerProfile(targetDir)).toEqual(profile);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("SPEKO_OWNER_PROFILE");
  });

  it("keeps the rest of the server usable when the blob is invalid (call_me stays unavailable)", () => {
    process.env.SPEKO_OWNER_PROFILE = "spkow1.invalid";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => buildContext(cfg())).not.toThrow();
    expect(existsSync(join(targetDir, "owner.json"))).toBe(false);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("SPEKO_OWNER_PROFILE");
  });
});
