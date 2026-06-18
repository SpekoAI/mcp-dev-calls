/**
 * Google Places API (v1) Text Search. This is the "Google business lookup" that
 * Abat wants kept OUT of api.speko.dev — it lives here, in the demo server, behind
 * the server-side GOOGLE_PLACES_API_KEY.
 */
import { E164_RE } from "../constants.js";
import { AppError } from "../lib/errors.js";

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.utcOffsetMinutes",
].join(",");

export interface PlaceCandidate {
  name: string;
  address: string;
  e164: string;
  utcOffsetMinutes: number | null;
}

/** Normalize Google's pretty phone ("+1 201-555-0123") to strict E.164, or null. */
function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  return E164_RE.test(cleaned) ? cleaned : null;
}

interface PlacesPlace {
  displayName?: { text?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  utcOffsetMinutes?: number;
}

export async function searchPlaces(query: string, apiKey: string): Promise<PlaceCandidate[]> {
  let resp: Response;
  try {
    resp = await fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
    });
  } catch (e) {
    throw new AppError(`Could not reach Google Places: ${(e as Error).message}`, {
      statusCode: 502,
      nextStep: "Check the demo server's network access and GOOGLE_PLACES_API_KEY, then retry lookup_business.",
    });
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new AppError(`Google Places returned ${resp.status}: ${text || resp.statusText}`, {
      statusCode: 502,
      nextStep:
        "Verify GOOGLE_PLACES_API_KEY has the Places API (New) enabled, then retry lookup_business.",
    });
  }
  const data = (await resp.json().catch(() => ({}))) as { places?: PlacesPlace[] };
  const places = Array.isArray(data.places) ? data.places : [];
  const out: PlaceCandidate[] = [];
  for (const p of places) {
    const e164 = normalizeE164(p.internationalPhoneNumber);
    if (!e164) continue; // a business we can't dial is not a candidate
    out.push({
      name: p.displayName?.text ?? query,
      address: p.formattedAddress ?? "",
      e164,
      utcOffsetMinutes: typeof p.utcOffsetMinutes === "number" ? p.utcOffsetMinutes : null,
    });
  }
  return out;
}
