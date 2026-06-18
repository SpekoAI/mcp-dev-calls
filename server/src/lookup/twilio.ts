/**
 * Carrier line-type check via Twilio Lookup v2. Returns the line type string
 * (e.g. "landline", "mobile", "voip") or null when it can't be determined.
 * A null result is treated as "unknown" by the line-type predicate, which fails
 * closed — so a number is never dialed without a confirmed business line type.
 */
export async function carrierLineType(
  e164: string,
  twilio: { sid: string; token: string },
): Promise<string | null> {
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`;
  const auth = Buffer.from(`${twilio.sid}:${twilio.token}`).toString("base64");
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return null;
  }
  const lti = (data as { line_type_intelligence?: { type?: unknown } } | null)?.line_type_intelligence;
  return typeof lti?.type === "string" ? lti.type : null;
}
