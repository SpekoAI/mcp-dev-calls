import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { resolveGuardStateDir } from "../safety/guard.js";

const OWNER_FILE = "owner.json";
const OTP_LEDGER_FILE = "owner-verification.jsonl";
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 3;
const OTP_MAX_CALLS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
// NANP is NXX-NXX-XXXX: both the area-code and exchange leading digits are 2-9.
const NANP_E164_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OwnerProfile {
  version: 1;
  owner_phone: string;
  owner_name: string;
  phone_verified_at: string;
  verify_method: "voice_otp";
  instance_id: string;
}

export interface OwnerVerificationChallenge {
  code: string;
  created_at_ms: number;
  expires_at_ms: number;
  attempts_remaining: number;
}

export type OwnerVerificationCheck = "verified" | "invalid" | "expired" | "attempts_exhausted";

export function resolveOwnerStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.SPEKO_OWNER_STATE_DIR ?? "").trim();
  return override || resolveGuardStateDir(env);
}

export function normalizeNanpOwnerPhone(raw: string): string | null {
  const normalized = String(raw ?? "").replace(/[^\d+]/g, "");
  return NANP_E164_RE.test(normalized) ? normalized : null;
}

function validOwnerName(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  return value.length > 0 && value.length <= 80 && /\p{L}/u.test(value);
}

function validIsoTimestamp(raw: unknown): raw is string {
  return typeof raw === "string" && Number.isFinite(Date.parse(raw));
}

function parseOwnerProfile(value: unknown): OwnerProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const phone = typeof row.owner_phone === "string" ? normalizeNanpOwnerPhone(row.owner_phone) : null;
  if (
    row.version !== 1 ||
    !phone ||
    !validOwnerName(row.owner_name) ||
    !validIsoTimestamp(row.phone_verified_at) ||
    row.verify_method !== "voice_otp" ||
    typeof row.instance_id !== "string" ||
    !UUID_RE.test(row.instance_id)
  ) {
    return null;
  }
  return {
    version: 1,
    owner_phone: phone,
    owner_name: row.owner_name.trim(),
    phone_verified_at: row.phone_verified_at,
    verify_method: "voice_otp",
    instance_id: row.instance_id,
  };
}

/** Missing or corrupt owner state fails closed: call_me remains unavailable. */
export function readOwnerProfile(dir = resolveOwnerStateDir()): OwnerProfile | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8")) as unknown;
    return parseOwnerProfile(parsed);
  } catch {
    return null;
  }
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows does not implement POSIX modes. The atomic file write still applies.
  }
}

/** Atomic replacement. The OTP itself is never written to disk. */
export function writeOwnerProfile(
  input: { ownerPhone: string; ownerName: string; verifiedAt?: string; instanceId?: string },
  dir = resolveOwnerStateDir(),
): OwnerProfile {
  const phone = normalizeNanpOwnerPhone(input.ownerPhone);
  if (!phone) throw new Error("Owner phone must be a NANP number in +1XXXXXXXXXX format.");
  if (!validOwnerName(input.ownerName)) throw new Error("Owner name must contain letters and be at most 80 characters.");
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  if (!validIsoTimestamp(verifiedAt)) throw new Error("Owner verification timestamp is invalid.");
  if (input.instanceId !== undefined && !UUID_RE.test(input.instanceId)) {
    throw new Error("Owner instance id must be a UUID.");
  }

  const existing = readOwnerProfile(dir);
  const profile: OwnerProfile = {
    version: 1,
    owner_phone: phone,
    owner_name: input.ownerName.trim(),
    phone_verified_at: verifiedAt,
    verify_method: "voice_otp",
    instance_id: input.instanceId ?? existing?.instance_id ?? randomUUID(),
  };

  ensurePrivateDir(dir);
  const target = join(dir, OWNER_FILE);
  const temp = join(dir, `.${OWNER_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, target);
    try {
      chmodSync(target, 0o600);
    } catch {
      // See ensurePrivateDir: best effort on non-POSIX systems.
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return profile;
}

export function createOwnerVerificationChallenge(nowMs = Date.now()): OwnerVerificationChallenge {
  return {
    code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
    created_at_ms: nowMs,
    expires_at_ms: nowMs + OTP_TTL_MS,
    attempts_remaining: OTP_MAX_ATTEMPTS,
  };
}

export function checkOwnerVerificationCode(
  challenge: OwnerVerificationChallenge,
  candidate: string,
  nowMs = Date.now(),
): OwnerVerificationCheck {
  if (nowMs >= challenge.expires_at_ms) return "expired";
  if (challenge.attempts_remaining <= 0) return "attempts_exhausted";
  challenge.attempts_remaining -= 1;
  const supplied = String(candidate ?? "").replace(/\D/g, "");
  const expected = challenge.code;
  const matches =
    supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied, "utf8"), Buffer.from(expected, "utf8"));
  if (matches) return "verified";
  return challenge.attempts_remaining > 0 ? "invalid" : "attempts_exhausted";
}

function recentOtpCalls(dir: string, phone: string, nowMs: number): number {
  let lines: string[];
  try {
    lines = readFileSync(join(dir, OTP_LEDGER_FILE), "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
      if (row.e164 === phone && Number.isFinite(ts) && ts <= nowMs && nowMs - ts < DAY_MS) count += 1;
    } catch {
      // Ignore corrupt historical rows; never infer verification from this ledger.
    }
  }
  return count;
}

/**
 * Reserve one real verification call immediately before dial. This is a product-abuse cap,
 * not an identity trust boundary; normal per-number caps still apply independently.
 */
export function reserveOwnerVerificationCall(
  ownerPhone: string,
  opts: { dir?: string; nowMs?: number } = {},
): void {
  const phone = normalizeNanpOwnerPhone(ownerPhone);
  if (!phone) throw new Error("Owner phone must be a NANP number in +1XXXXXXXXXX format.");
  const dir = opts.dir ?? resolveOwnerStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  const used = recentOtpCalls(dir, phone, nowMs);
  if (used >= OTP_MAX_CALLS_PER_DAY) {
    throw new Error(
      `Owner verification call limit reached for this number (${OTP_MAX_CALLS_PER_DAY} in 24 hours). Try again after the oldest attempt expires.`,
    );
  }
  ensurePrivateDir(dir);
  const path = join(dir, OTP_LEDGER_FILE);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ ts: new Date(nowMs).toISOString(), e164: phone })}\n`, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX systems.
  }
}
