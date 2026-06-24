/**
 * Business lookup orchestrator. Two paths:
 *  - DEMO mode (SPEKO_DEMO): one env-configured target, asserted line type.
 *  - Real mode: Google Places Text Search → Twilio carrier line-type check →
 *    mint a signed dial_token for each dialable business line.
 * Both run entirely server-side; the lookup secrets never reach the MCP tier.
 */
import type { AppConfig } from "../config.js";
import { RejectionError } from "../lib/errors.js";
import { dialBlockedReason, lineTypeBlockedReason, mintDialToken } from "../safety/dialToken.js";
import type { BusinessCandidate, LookupResult } from "../types.js";
import { demoEnabled, demoLookupCandidate } from "./demo.js";
import { searchPlaces } from "./places.js";
import { carrierLineType } from "./twilio.js";

export interface LookupDeps {
  cfg: AppConfig;
  bearerHash: string;
}

export async function lookupBusiness(
  input: { name: string; location?: string | null },
  deps: LookupDeps,
): Promise<LookupResult> {
  if (demoEnabled()) {
    return { candidates: [demoLookupCandidate(input, deps.bearerHash)], source: "demo" };
  }

  const { cfg } = deps;
  if (!cfg.googlePlacesApiKey) {
    throw new RejectionError(
      "Business lookup is not configured: set GOOGLE_PLACES_API_KEY on the demo server to resolve " +
        "real businesses, or set SPEKO_DEMO=1 with a SPEKO_DEMO_E164 to dial a single consented target",
      "Add GOOGLE_PLACES_API_KEY (and optionally TWILIO_LOOKUP_SID/TOKEN) to the repo-root .env, or enable SPEKO_DEMO.",
    );
  }

  const query = [input.name, input.location].filter((s) => s && String(s).trim()).join(" ");
  const places = await searchPlaces(query, cfg.googlePlacesApiKey);

  const candidates: BusinessCandidate[] = await Promise.all(
    places.map(async (p): Promise<BusinessCandidate> => {
      let lineType: string | null = null;
      let blocked = dialBlockedReason(p.e164);
      if (!blocked) {
        lineType = cfg.twilio ? await carrierLineType(p.e164, cfg.twilio) : null;
        blocked = lineTypeBlockedReason(lineType);
      }
      if (blocked) {
        return {
          name: p.name,
          address: p.address,
          phone: p.e164,
          line_type: lineType,
          allowed: false,
          blocked_reason: blocked,
          dial_token: null,
          utc_offset_minutes: p.utcOffsetMinutes,
        };
      }
      const dialToken = mintDialToken({
        e164: p.e164,
        lineType: lineType as string,
        businessName: p.name,
        utcOffsetMinutes: p.utcOffsetMinutes,
        bearerHash: deps.bearerHash,
        secret: cfg.dialTokenSecret,
      });
      return {
        name: p.name,
        address: p.address,
        phone: p.e164,
        line_type: lineType,
        allowed: true,
        blocked_reason: null,
        dial_token: dialToken,
        utc_offset_minutes: p.utcOffsetMinutes,
      };
    }),
  );

  return { candidates, source: "google_places" };
}
