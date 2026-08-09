import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
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
const OWNER_CALL_LEDGER_FILE = "owner-call-leases.jsonl";
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

export interface OwnerCallLease {
  token: string;
  ownerPhone: string;
  instanceId: string;
  mode: "notify" | "converse";
  message: string;
  context: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  callId: string | null;
  released: boolean;
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

/** The single strict validator for owner-profile shaped data. Anything else is rejected. */
export function parseOwnerProfile(value: unknown): OwnerProfile | null {
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

/** True when an owner.json file is present, even a corrupt one (corrupt state still fails closed). */
export function ownerProfileFileExists(dir = resolveOwnerStateDir()): boolean {
  return existsSync(join(dir, OWNER_FILE));
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

  const profile: OwnerProfile = {
    version: 1,
    owner_phone: phone,
    owner_name: input.ownerName.trim(),
    phone_verified_at: verifiedAt,
    verify_method: "voice_otp",
    // Every successful verification starts a new ownership epoch. Old call bindings must not be
    // promotable as instructions after a number is re-verified or ownership changes.
    instance_id: input.instanceId ?? randomUUID(),
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

function appendLedgerRow(dir: string, file: string, row: Record<string, unknown>): void {
  ensurePrivateDir(dir);
  const path = join(dir, file);
  const payload = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
  const fd = openSync(path, "a", 0o600);
  try {
    // One O_APPEND syscall gives all processes a single byte order. A short write leaves a
    // partial tail, which replay treats as corrupt and therefore fails closed before any dial.
    const written = writeSync(fd, payload, 0, payload.length, null);
    if (written !== payload.length) throw new Error(`Short append to ${file}.`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX systems.
  }
}

function readLedgerRows(dir: string, file: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (raw && !raw.endsWith("\n")) throw new Error(`${file} has a partial record; refusing to dial.`);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${file} contains a corrupt record; refusing to dial.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${file} contains an invalid record; refusing to dial.`);
      }
      return parsed as Record<string, unknown>;
    });
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
  const token = randomUUID();
  appendLedgerRow(dir, OTP_LEDGER_FILE, {
    v: 2,
    type: "reserve",
    id: token,
    ts_ms: nowMs,
    ts: new Date(nowMs).toISOString(),
    e164: phone,
  });

  const accepted = new Map<string, number[]>();
  let candidateAccepted = false;
  for (const row of readLedgerRows(dir, OTP_LEDGER_FILE)) {
    const isV2 = row.v === 2 && row.type === "reserve" && typeof row.id === "string";
    const isLegacy = row.v === undefined && typeof row.ts === "string" && typeof row.e164 === "string";
    if ((!isV2 && !isLegacy) || typeof row.e164 !== "string") {
      throw new Error(`${OTP_LEDGER_FILE} contains an invalid reservation; refusing to dial.`);
    }
    const eventPhone = normalizeNanpOwnerPhone(row.e164);
    const eventMs = isV2 && typeof row.ts_ms === "number" ? row.ts_ms : Date.parse(String(row.ts));
    if (!eventPhone || !Number.isFinite(eventMs)) {
      throw new Error(`${OTP_LEDGER_FILE} contains an invalid reservation; refusing to dial.`);
    }
    const priorAccepted = accepted.get(eventPhone) ?? [];
    // Keep the full accepted history during replay. A future-dated row must not be able to
    // discard earlier attempts and then let a rolled-back clock reopen capacity. Prior rows in
    // the future are therefore counted conservatively, while genuinely older rows expire only
    // for the decision being made at this event.
    const recentCount = priorAccepted.filter(
      (priorMs) => priorMs > eventMs || eventMs - priorMs < DAY_MS,
    ).length;
    const eventAccepted = recentCount < OTP_MAX_CALLS_PER_DAY;
    if (eventAccepted) priorAccepted.push(eventMs);
    accepted.set(eventPhone, priorAccepted);
    if (isV2 && row.id === token) candidateAccepted = eventAccepted;
  }
  if (!candidateAccepted) {
    throw new Error(
      `Owner verification call limit reached for this number (${OTP_MAX_CALLS_PER_DAY} in 24 hours). Try again after the oldest attempt expires.`,
    );
  }
}

function replayOwnerCallLedger(dir: string, nowMs: number): { active: OwnerCallLease | null; leases: OwnerCallLease[] } {
  const byToken = new Map<string, OwnerCallLease>();
  let active: OwnerCallLease | null = null;
  const expireAt = (eventMs: number): void => {
    if (active && active.expiresAtMs <= eventMs) {
      active.released = true;
      active = null;
    }
  };
  for (const row of readLedgerRows(dir, OWNER_CALL_LEDGER_FILE)) {
    const eventMs = typeof row.at_ms === "number" ? row.at_ms : NaN;
    if (row.v !== 2 || typeof row.id !== "string" || !Number.isFinite(eventMs)) {
      throw new Error(`${OWNER_CALL_LEDGER_FILE} contains an invalid event; refusing to dial.`);
    }
    expireAt(eventMs);
    if (row.type === "acquire") {
      if (
        typeof row.owner_phone !== "string" ||
        typeof row.instance_id !== "string" ||
        (row.mode !== "notify" && row.mode !== "converse") ||
        typeof row.message !== "string" ||
        (row.context !== null && typeof row.context !== "string") ||
        typeof row.pending_until_ms !== "number"
      ) {
        throw new Error(`${OWNER_CALL_LEDGER_FILE} contains an invalid acquire event; refusing to dial.`);
      }
      if (active) continue;
      const lease: OwnerCallLease = {
        token: row.id,
        ownerPhone: row.owner_phone,
        instanceId: row.instance_id,
        mode: row.mode,
        message: row.message,
        context: row.context,
        createdAtMs: eventMs,
        expiresAtMs: row.pending_until_ms,
        callId: null,
        released: false,
      };
      byToken.set(row.id, lease);
      active = lease;
      continue;
    }
    if (row.type === "bind") {
      if (typeof row.lease_id !== "string" || typeof row.call_id !== "string" || typeof row.hard_until_ms !== "number") {
        throw new Error(`${OWNER_CALL_LEDGER_FILE} contains an invalid bind event; refusing to dial.`);
      }
      if (active?.token === row.lease_id) {
        active.callId = row.call_id;
        active.expiresAtMs = row.hard_until_ms;
      }
      continue;
    }
    if (row.type === "release") {
      if (typeof row.lease_id !== "string") {
        throw new Error(`${OWNER_CALL_LEDGER_FILE} contains an invalid release event; refusing to dial.`);
      }
      if (active?.token === row.lease_id) {
        active.released = true;
        active = null;
      }
      continue;
    }
    throw new Error(`${OWNER_CALL_LEDGER_FILE} contains an unknown event; refusing to dial.`);
  }
  expireAt(nowMs);
  return { active, leases: [...byToken.values()] };
}

/** Append a contender before any await; file order makes check-and-reserve cross-process atomic. */
export function beginOwnerCallLease(
  input: {
    ownerPhone: string;
    instanceId: string;
    mode: "notify" | "converse";
    message: string;
    context: string | null;
    ttlMs: number;
  },
  opts: { dir?: string; nowMs?: number } = {},
): { token: string; active: OwnerCallLease } {
  const phone = normalizeNanpOwnerPhone(input.ownerPhone);
  if (!phone) throw new Error("Owner phone must be a NANP number in +1XXXXXXXXXX format.");
  const dir = opts.dir ?? resolveOwnerStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  const token = randomUUID();
  appendLedgerRow(dir, OWNER_CALL_LEDGER_FILE, {
    v: 2,
    id: token,
    type: "acquire",
    at_ms: nowMs,
    pending_until_ms: nowMs + input.ttlMs,
    owner_phone: phone,
    instance_id: input.instanceId,
    mode: input.mode,
    message: input.message,
    context: input.context,
  });
  const active = replayOwnerCallLedger(dir, nowMs).active;
  if (!active) throw new Error("Owner-call lease could not be read after reservation.");
  return { token, active };
}

export function currentOwnerCallLease(
  ownerPhone: string,
  opts: { dir?: string; nowMs?: number } = {},
): OwnerCallLease | null {
  const phone = normalizeNanpOwnerPhone(ownerPhone);
  if (!phone) return null;
  return replayOwnerCallLedger(opts.dir ?? resolveOwnerStateDir(), opts.nowMs ?? Date.now()).active;
}

export function bindOwnerCallLease(
  token: string,
  callId: string,
  opts: { dir?: string; nowMs?: number } = {},
): void {
  if (!token || !callId) throw new Error("Owner-call lease token and call id are required.");
  const dir = opts.dir ?? resolveOwnerStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  const lease = replayOwnerCallLedger(dir, nowMs).active;
  if (!lease || lease.token !== token) {
    throw new Error("Owner-call lease is no longer active.");
  }
  appendLedgerRow(dir, OWNER_CALL_LEDGER_FILE, {
    v: 2,
    id: randomUUID(),
    type: "bind",
    lease_id: token,
    call_id: callId,
    at_ms: nowMs,
    hard_until_ms: nowMs + 60 * 60 * 1000,
  });
}

export function releaseOwnerCallLease(token: string, opts: { dir?: string; nowMs?: number } = {}): void {
  if (!token) return;
  const dir = opts.dir ?? resolveOwnerStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  appendLedgerRow(dir, OWNER_CALL_LEDGER_FILE, {
    v: 2,
    id: randomUUID(),
    type: "release",
    lease_id: token,
    at_ms: nowMs,
  });
}

export function releaseOwnerCallLeaseByCallId(
  callId: string,
  opts: { dir?: string; nowMs?: number } = {},
): void {
  const dir = opts.dir ?? resolveOwnerStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  const active = replayOwnerCallLedger(dir, nowMs).active;
  if (active?.callId === callId) releaseOwnerCallLease(active.token, { dir, nowMs });
}

/** Trusted local binding used to decide whether get_call may expose owner-instruction fields. */
export function readOwnerCallBinding(
  callId: string,
  opts: { dir?: string; nowMs?: number } = {},
): OwnerCallLease | null {
  const dir = opts.dir ?? resolveOwnerStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  return replayOwnerCallLedger(dir, nowMs).leases.find((lease) => lease.callId === callId) ?? null;
}
