import { createHash, createHmac } from "node:crypto";

/**
 * Mint v1 dial tokens exactly like the server does (canonical sorted-key JSON, HMAC-SHA256,
 * base64url.base64url) so make_call rail probes run deterministically on BOTH versions.
 * The format predates 0.4.9 and is unchanged in 0.5.0.
 */
export const PROBE_SECRET = "characterization-fixed-secret-do-not-change";
export const PROBE_API_KEY = "sk-dummy-characterization-key";

export function bearerHashFor(apiKey = PROBE_API_KEY) {
  return createHash("sha256").update(apiKey, "utf-8").digest("hex").slice(0, 16);
}

export function mintToken({
  e164,
  lineType = "voip",
  businessName = "Char Test Biz",
  utcOffsetMinutes = null,
  bearerHash = bearerHashFor(),
  ttlSeconds = 900,
  nowSeconds = Date.now() / 1000,
  secret = PROBE_SECRET,
}) {
  const payload = {
    bh: bearerHash,
    business_name: businessName,
    e164,
    exp: Math.floor(nowSeconds + ttlSeconds),
    line_type: lineType,
    utc_offset_minutes: utcOffsetMinutes,
    v: 1,
  };
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const sig = createHmac("sha256", secret).update(json).digest();
  return `${json.toString("base64url")}.${sig.toString("base64url")}`;
}

/**
 * UTC offset (minutes) that puts the destination's local clock at targetHour right now.
 * Mapped into [-720, 719] so it always looks like a plausible timezone.
 */
export function offsetForLocalHour(targetHour, now = new Date()) {
  const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offset = targetHour * 60 + 30 - nowUtcMinutes; // aim mid-hour for stability
  while (offset >= 720) offset -= 1440;
  while (offset < -720) offset += 1440;
  return offset;
}
