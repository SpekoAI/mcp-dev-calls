/**
 * Business lookup orchestrator. Three paths, all server-side:
 *  - DEMO mode (SPEKO_DEMO): one env-configured target, asserted line type.
 *  - AGENT-PROVIDED number: the caller (e.g. the coding agent's own web search) supplies
 *    the business's phone number directly — skips Google Places discovery, but still
 *    carrier-verifies the line type before minting a token.
 *  - Real mode: Google Places Text Search → Twilio carrier line-type check → mint.
 *
 * Whatever the path, the SAME safety checks gate every dial_token: valid E.164, a confirmed
 * business line type, then a signed account-bound token. The line-type check is NEVER
 * skipped — a web-found number is dialed only once confirmed to be a business line — so
 * moving discovery to the agent doesn't widen the compliance surface. Lookup secrets never
 * reach the MCP tier.
 */
import type { AppConfig } from "../config.js";
import { RejectionError } from "../lib/errors.js";
import { dialBlockedReason, lineTypeBlockedReason, mintDialToken } from "../safety/dialToken.js";
import { offsetFromE164 } from "../safety/timezone.js";
import type { BusinessCandidate, LookupResult } from "../types.js";
import { demoEnabled, demoLookupCandidate } from "./demo.js";
import { searchPlaces } from "./places.js";
import { carrierLineType } from "./twilio.js";

export interface LookupDeps {
  cfg: AppConfig;
  bearerHash: string;
}

/**
 * Validate one candidate number, carrier-check its line type, and mint a dial_token if it's
 * a dialable business line — else return it blocked with a reason. Shared by the Places and
 * agent-provided paths so the safety checks are identical no matter how the number was found.
 */
async function verifyAndMint(
  c: { name: string; address: string; e164: string; utcOffsetMinutes: number | null },
  cfg: AppConfig,
  bearerHash: string,
): Promise<BusinessCandidate> {
  let lineType: string | null = null;
  let blocked = dialBlockedReason(c.e164);
  if (!blocked) {
    lineType = cfg.twilio ? await carrierLineType(c.e164, cfg.twilio) : null;
    blocked = lineTypeBlockedReason(lineType);
  }
  if (blocked) {
    return {
      name: c.name,
      address: c.address,
      phone: c.e164,
      line_type: lineType,
      allowed: false,
      blocked_reason: blocked,
      dial_token: null,
      utc_offset_minutes: c.utcOffsetMinutes,
    };
  }
  const dialToken = mintDialToken({
    e164: c.e164,
    lineType: lineType as string,
    businessName: c.name,
    utcOffsetMinutes: c.utcOffsetMinutes,
    bearerHash,
    secret: cfg.dialTokenSecret,
  });
  return {
    name: c.name,
    address: c.address,
    phone: c.e164,
    line_type: lineType,
    allowed: true,
    blocked_reason: null,
    dial_token: dialToken,
    utc_offset_minutes: c.utcOffsetMinutes,
  };
}

export async function lookupBusiness(
  input: { name: string; location?: string | null; phoneNumber?: string | null },
  deps: LookupDeps,
): Promise<LookupResult> {
  if (demoEnabled()) {
    return { candidates: [demoLookupCandidate(input, deps.bearerHash)], source: "demo" };
  }

  const { cfg } = deps;

  // Agent-provided number: the coding agent found the business's official number itself
  // (e.g. via web search) and passed it in. Skip Google Places discovery and verify the
  // number directly — the carrier line-type check still gates it, so a wrong or mobile
  // number is never dialed as a "business". Quiet-hours offset is derived from the number's
  // country/area code (fail-closed to blocked downstream if it can't be determined) — an
  // approximation vs the Places path's address-based offset, but never a safety bypass.
  const provided = typeof input.phoneNumber === "string" ? input.phoneNumber.replace(/[^\d+]/g, "") : "";
  if (provided) {
    const candidate = await verifyAndMint(
      {
        name: input.name,
        address: (input.location ?? "").trim(),
        e164: provided,
        utcOffsetMinutes: offsetFromE164(provided),
      },
      cfg,
      deps.bearerHash,
    );
    return { candidates: [candidate], source: "agent_provided" };
  }

  if (!cfg.googlePlacesApiKey) {
    throw new RejectionError(
      "Business lookup has no directory configured. Either pass phone_number (the business's official " +
        "number — e.g. found via web search) to lookup_business, or set GOOGLE_PLACES_API_KEY on the demo " +
        "server, or set SPEKO_DEMO=1 with a SPEKO_DEMO_E164.",
      "Pass phone_number=<E.164> to lookup_business, or add GOOGLE_PLACES_API_KEY to the repo-root .env, or enable SPEKO_DEMO.",
    );
  }

  const query = [input.name, input.location].filter((s) => s && String(s).trim()).join(" ");
  const places = await searchPlaces(query, cfg.googlePlacesApiKey);
  const candidates = await Promise.all(places.map((p) => verifyAndMint(p, cfg, deps.bearerHash)));
  return { candidates, source: "google_places" };
}
