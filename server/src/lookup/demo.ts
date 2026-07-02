/**
 * DEMO-ONLY business lookup. Gated behind SPEKO_DEMO=1 (or SPEKO_DEMO_E164), this
 * resolves a single hard-configured target from env and mints a REAL dial_token
 * with the local SPEKO_DIAL_TOKEN_SECRET — standing in for the Google Places +
 * Twilio carrier check so a real, disclosed call can be recorded end-to-end
 * without those keys. It must NEVER be the default path in production.
 *
 * Reads process.env directly (not the cached config) so it stays trivially
 * testable by mutating the environment.
 */
import type { BusinessCandidate } from "../types.js";
import { dialBlockedReason, lineTypeBlockedReason, mintDialToken } from "../safety/dialToken.js";
import { offsetFromE164 } from "../safety/timezone.js";

const DEFAULT_LINE_TYPE = "voip";
const DEFAULT_ADDRESS = "(demo target)";

/** True when the demo lookup should answer instead of Google Places. */
export function demoEnabled(): boolean {
  return process.env.SPEKO_DEMO === "1" || Boolean(process.env.SPEKO_DEMO_E164);
}

function parseOffset(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the single configured demo candidate. The business name shown on the
 * call defaults to whatever the agent typed (so "call Sakura Sushi" reads true),
 * while the number dialed is the env-configured demo target.
 */
export function demoLookupCandidate(
  input: { name: string; location?: string | null },
  bearerHash: string,
): BusinessCandidate {
  const e164 = (process.env.SPEKO_DEMO_E164 ?? "").trim();
  const businessName = (process.env.SPEKO_DEMO_BUSINESS ?? "").trim() || input.name;
  const lineType = (process.env.SPEKO_DEMO_LINE_TYPE ?? DEFAULT_LINE_TYPE).trim() || DEFAULT_LINE_TYPE;
  const address = (process.env.SPEKO_DEMO_ADDRESS ?? "").trim() || DEFAULT_ADDRESS;
  // Explicit override wins; otherwise auto-derive the callee's offset from the number
  // so the after-hours confirmation gate has the best available local-time info.
  const utcOffsetMinutes = parseOffset(process.env.SPEKO_DEMO_UTC_OFFSET) ?? offsetFromE164(e164);

  const blockedReason = dialBlockedReason(e164) ?? lineTypeBlockedReason(lineType);
  if (blockedReason) {
    return {
      name: businessName,
      address,
      phone: e164 || "(SPEKO_DEMO_E164 unset)",
      line_type: lineType,
      allowed: false,
      blocked_reason: blockedReason,
      dial_token: null,
      utc_offset_minutes: utcOffsetMinutes,
    };
  }

  const dialToken = mintDialToken({ e164, lineType, businessName, utcOffsetMinutes, bearerHash });
  return {
    name: businessName,
    address,
    phone: e164,
    line_type: lineType,
    allowed: true,
    blocked_reason: null,
    dial_token: dialToken,
    utc_offset_minutes: utcOffsetMinutes,
  };
}
