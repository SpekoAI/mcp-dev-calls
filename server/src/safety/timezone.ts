/**
 * Best-effort timezone derivation for the after-hours confirmation gate, so a
 * target's local time is computed automatically from its number instead of a
 * hand-set SPEKO_DEMO_UTC_OFFSET. Real Google Places lookups already return an
 * offset; this fills the gap for demo mode and as a fallback.
 *
 * Maps E.164 -> IANA zone (NANP by area code, else by country code), then asks
 * Intl for that zone's CURRENT offset, so DST is always correct without a tz db.
 * Unknown offsets require after-hours confirmation instead of blocking the call.
 *
 * Caveat: for a *virtual* number whose owner is in another country (e.g. a US DID
 * used by someone abroad), the nominal region is wrong — set an explicit
 * SPEKO_DEMO_UTC_OFFSET for those.
 */

// Representative US/Canada area code -> IANA zone. Unlisted NANP returns null (offset unknown —
// see zoneFromE164), so an unknown region is never silently assumed to be Eastern;
// the after-hours gate then asks for confirmation instead of guessing.
const NANP_AREA_TZ: Readonly<Record<string, string>> = {
  // Pacific
  "206": "America/Los_Angeles", "213": "America/Los_Angeles", "310": "America/Los_Angeles",
  "408": "America/Los_Angeles", "415": "America/Los_Angeles", "424": "America/Los_Angeles",
  "503": "America/Los_Angeles", "510": "America/Los_Angeles", "530": "America/Los_Angeles",
  "559": "America/Los_Angeles", "619": "America/Los_Angeles", "626": "America/Los_Angeles",
  "650": "America/Los_Angeles", "661": "America/Los_Angeles", "707": "America/Los_Angeles",
  "714": "America/Los_Angeles", "760": "America/Los_Angeles", "805": "America/Los_Angeles",
  "818": "America/Los_Angeles", "831": "America/Los_Angeles", "858": "America/Los_Angeles",
  "909": "America/Los_Angeles", "916": "America/Los_Angeles", "925": "America/Los_Angeles",
  "949": "America/Los_Angeles", "971": "America/Los_Angeles",
  // Bay Area / NorCal overlays (628=SF, 669=San Jose, 341=Oakland) + Central Valley (209/279)
  "628": "America/Los_Angeles", "669": "America/Los_Angeles", "341": "America/Los_Angeles",
  "209": "America/Los_Angeles", "279": "America/Los_Angeles",
  // Mountain (Phoenix = no DST)
  "303": "America/Denver", "385": "America/Denver", "435": "America/Denver", "505": "America/Denver",
  "720": "America/Denver", "801": "America/Denver",
  "480": "America/Phoenix", "602": "America/Phoenix", "623": "America/Phoenix", "928": "America/Phoenix",
  // Central
  "214": "America/Chicago", "312": "America/Chicago", "469": "America/Chicago", "512": "America/Chicago",
  "612": "America/Chicago", "618": "America/Chicago", "630": "America/Chicago", "682": "America/Chicago",
  "708": "America/Chicago", "713": "America/Chicago", "773": "America/Chicago", "815": "America/Chicago",
  "817": "America/Chicago", "832": "America/Chicago", "847": "America/Chicago", "913": "America/Chicago",
  "972": "America/Chicago",
  // Eastern
  "202": "America/New_York", "212": "America/New_York", "305": "America/New_York", "404": "America/New_York",
  "412": "America/New_York", "516": "America/New_York", "617": "America/New_York", "646": "America/New_York",
  "678": "America/New_York", "703": "America/New_York", "716": "America/New_York", "718": "America/New_York",
  "770": "America/New_York", "786": "America/New_York", "813": "America/New_York", "917": "America/New_York",
  "954": "America/New_York",
};

// Country calling code -> representative IANA zone. NANP (+1) is handled separately
// (by area code) and intentionally NOT given a "1" fallback here — an unknown +1 area
// code must return null (offset unknown) rather than guess a zone and misjudge local time.
const COUNTRY_TZ: Readonly<Record<string, string>> = {
  "7": "Asia/Almaty", "20": "Africa/Cairo", "27": "Africa/Johannesburg",
  "30": "Europe/Athens", "31": "Europe/Amsterdam", "32": "Europe/Brussels", "33": "Europe/Paris",
  "34": "Europe/Madrid", "39": "Europe/Rome", "44": "Europe/London", "49": "Europe/Berlin",
  "52": "America/Mexico_City", "55": "America/Sao_Paulo", "61": "Australia/Sydney", "62": "Asia/Jakarta",
  "63": "Asia/Manila", "65": "Asia/Singapore", "81": "Asia/Tokyo", "82": "Asia/Seoul",
  "84": "Asia/Ho_Chi_Minh", "86": "Asia/Shanghai", "90": "Europe/Istanbul", "91": "Asia/Kolkata",
  "92": "Asia/Karachi", "971": "Asia/Dubai", "972": "Asia/Jerusalem",
};

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Current UTC offset (minutes) for an IANA zone, DST-correct, via Intl. Null if unknown. */
export function zoneOffsetMinutes(timeZone: string, now: Date = new Date()): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
    const hour = p.hour === "24" ? 0 : Number(p.hour);
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return Math.round((asUtc - now.getTime()) / 60000);
  } catch {
    return null; // unknown / unsupported zone
  }
}

/**
 * Map an E.164 number to an IANA zone (best effort). Null if unrecognized.
 *
 * For NANP (+1) we trust ONLY explicitly-known area codes; an unlisted or malformed
 * +1 number returns null so the after-hours gate asks for confirmation rather than guessing a
 * zone that could be hours off in the callee's local time.
 */
export function zoneFromE164(e164: string): string | null {
  if (!E164_RE.test(e164)) return null;
  const digits = e164.slice(1);
  if (digits.startsWith("1")) {
    return digits.length === 11 ? (NANP_AREA_TZ[digits.slice(1, 4)] ?? null) : null;
  }
  for (const len of [3, 2, 1]) {
    const cc = digits.slice(0, len);
    if (COUNTRY_TZ[cc]) return COUNTRY_TZ[cc];
  }
  return null;
}

/** Best-effort current UTC offset (minutes) for an E.164 number; null if unknown. */
export function offsetFromE164(e164: string, now: Date = new Date()): number | null {
  const zone = zoneFromE164(e164);
  return zone ? zoneOffsetMinutes(zone, now) : null;
}
