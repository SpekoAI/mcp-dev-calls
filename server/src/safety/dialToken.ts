import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ALLOWED_LINE_TYPES,
  AFTER_HOURS_END_HOUR,
  AFTER_HOURS_START_HOUR,
  DIAL_TOKEN_DEFAULT_TTL_SECONDS,
  DIAL_TOKEN_SECRET_ENV,
  E164_RE,
  EMERGENCY_NUMBERS,
  MIN_AFTER_HOURS_CONFIRMATION_CHARS,
  US_PREMIUM_RE,
} from "../constants.js";

/**
 * Signed, short-lived dial tokens (HMAC-SHA256) + pure call-safety predicates.
 * A dial token is the ONLY way a number reaches make_call: the lookup route mints
 * one after a carrier check; the call route verifies it before dialing. Mint and
 * verify both run SERVER-SIDE with SPEKO_DIAL_TOKEN_SECRET — the secret never
 * reaches the MCP/npx tier.
 */

export class DialTokenError extends Error {
  override name = "DialTokenError";
}

export interface DialTokenPayload {
  v: number;
  e164: string;
  line_type: string;
  business_name: string;
  utc_offset_minutes: number | null;
  bh: string | null;
  exp: number;
}

const MALFORMED =
  "Malformed dial token: expected two dot-separated base64url parts produced by " +
  "lookup_business; run lookup_business again to mint a fresh dial token.";
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function resolveSecret(secret?: string): string {
  const resolved = secret ?? process.env[DIAL_TOKEN_SECRET_ENV] ?? "";
  if (!resolved) {
    throw new DialTokenError(
      `Dial token secret is not configured; set the ${DIAL_TOKEN_SECRET_ENV} environment ` +
        "variable to a non-empty value before minting or verifying dial tokens.",
    );
  }
  return resolved;
}

function b64urlDecode(value: string): Buffer {
  if (!B64URL_RE.test(value)) throw new DialTokenError(MALFORMED);
  return Buffer.from(value, "base64url");
}

// Compact, sorted-key JSON to match Python json.dumps(sort_keys=True, separators=(",",":")).
function canonicalJson(p: DialTokenPayload): Buffer {
  const ordered = {
    bh: p.bh,
    business_name: p.business_name,
    e164: p.e164,
    exp: p.exp,
    line_type: p.line_type,
    utc_offset_minutes: p.utc_offset_minutes,
    v: p.v,
  };
  return Buffer.from(JSON.stringify(ordered), "utf-8");
}

const sign = (secret: string, payload: Buffer): Buffer =>
  createHmac("sha256", secret).update(payload).digest();

export interface MintArgs {
  e164: string;
  lineType: string;
  businessName: string;
  utcOffsetMinutes: number | null;
  bearerHash?: string | null;
  ttlSeconds?: number;
  secret?: string;
  /** Override "now" in seconds (tests). */
  now?: number;
}

export function mintDialToken(args: MintArgs): string {
  const secret = resolveSecret(args.secret);
  const issuedAt = args.now ?? Date.now() / 1000;
  const payload: DialTokenPayload = {
    v: 1,
    e164: args.e164,
    line_type: args.lineType,
    business_name: args.businessName,
    utc_offset_minutes: args.utcOffsetMinutes,
    bh: args.bearerHash ?? null,
    exp: Math.floor(issuedAt + (args.ttlSeconds ?? DIAL_TOKEN_DEFAULT_TTL_SECONDS)),
  };
  const json = canonicalJson(payload);
  return `${json.toString("base64url")}.${sign(secret, json).toString("base64url")}`;
}

export function verifyDialToken(
  token: string,
  opts: { expectedBearerHash?: string | null; secret?: string; now?: number } = {},
): DialTokenPayload {
  const secret = resolveSecret(opts.secret);
  if (typeof token !== "string") throw new DialTokenError(MALFORMED);
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new DialTokenError(MALFORMED);
  const payloadBytes = b64urlDecode(parts[0]);
  const providedSig = b64urlDecode(parts[1]);
  let payload: DialTokenPayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf-8")) as DialTokenPayload;
  } catch {
    throw new DialTokenError(MALFORMED);
  }
  if (!payload || typeof payload !== "object") throw new DialTokenError(MALFORMED);
  // Sign the raw decoded bytes (Python-compatible), not a re-serialization.
  const expectedSig = sign(secret, payloadBytes);
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    throw new DialTokenError(
      "Dial token signature check failed: the token was altered or signed with a different " +
        "secret; run lookup_business again to mint a fresh dial token.",
    );
  }
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new DialTokenError(MALFORMED);
  const current = opts.now ?? Date.now() / 1000;
  if (current >= exp) {
    throw new DialTokenError(
      `Dial token expired at epoch ${Math.floor(exp)}; run lookup_business again to mint a fresh dial token.`,
    );
  }
  if (payload.bh != null && payload.bh !== opts.expectedBearerHash) {
    throw new DialTokenError(
      "Dial token was minted for a different account; run lookup_business again to mint a dial " +
        "token for the current credentials.",
    );
  }
  return payload;
}

// ── Pure predicates ──────────────────────────────────────────────────────────

export function dialBlockedReason(e164: unknown): string | null {
  if (typeof e164 !== "string") {
    return "Phone number must be a string in E.164 format such as '+12015551234'.";
  }
  if (EMERGENCY_NUMBERS.has(e164)) {
    return `Dialing ${e164} is blocked: emergency and crisis numbers may not be called by automated agents.`;
  }
  if (!E164_RE.test(e164)) {
    return `'${e164}' is not a valid E.164 phone number such as '+12015551234'; run lookup_business to resolve a dialable business number.`;
  }
  if (US_PREMIUM_RE.test(e164)) {
    return `Dialing ${e164} is blocked: US premium-rate numbers (+1-900 and +1-976) may not be called.`;
  }
  return null;
}

export function lineTypeBlockedReason(lineType: string | null): string | null {
  const allowed = [...ALLOWED_LINE_TYPES].sort().join(", ");
  if (lineType === "mobile") {
    return `Line type 'mobile' is blocked: the business-lines-only policy forbids calling personal mobile numbers; only business line types (${allowed}) may be dialed.`;
  }
  if (lineType == null) {
    return `Line type is unknown; calls are blocked until lookup_business confirms a business line type (${allowed}).`;
  }
  if (!ALLOWED_LINE_TYPES.has(lineType)) {
    return `Line type '${lineType}' is not an allowed business line type; allowed line types: ${allowed}.`;
  }
  return null;
}

const AFTER_HOURS_RETRY_INSTRUCTION =
  "confirm with your human that they want to place this call now, then retry with after_hours_confirmation set to their words. By retrying you confirm the callee has consented to be called.";

function destinationLocalTime(utcOffsetMinutes: number, now?: number): { hour: number; hhmm: string } {
  const currentMs = now != null ? now * 1000 : Date.now();
  const local = new Date(currentMs + utcOffsetMinutes * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  return { hour: local.getUTCHours(), hhmm: `${hh}:${mm}` };
}

export function afterHoursGateReason(
  utcOffsetMinutes: number | null,
  afterHoursConfirmation: string | null | undefined,
  collectionMatched: boolean,
  now?: number,
): string | null {
  const local = utcOffsetMinutes == null ? null : destinationLocalTime(utcOffsetMinutes, now);
  if (local && local.hour >= AFTER_HOURS_END_HOUR && local.hour < AFTER_HOURS_START_HOUR) {
    return null;
  }

  const timeDescription = local ? `destination local time is ${local.hhmm}` : "timezone unverified";
  if (collectionMatched) {
    return (
      `Call blocked: ${timeDescription}; collection-flavored calls are day-hours-only with no override under ` +
      "the FDCPA 8am-9pm window (15 U.S.C. 1692c(a)(1))."
    );
  }

  const confirmation = typeof afterHoursConfirmation === "string" ? afterHoursConfirmation.trim() : "";
  if (confirmation.length >= MIN_AFTER_HOURS_CONFIRMATION_CHARS) {
    return null;
  }

  return `Call blocked: ${timeDescription}; ${AFTER_HOURS_RETRY_INSTRUCTION}`;
}
