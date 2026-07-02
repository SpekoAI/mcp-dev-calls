/**
 * Normalize volatile output so snapshots are time-, path-, and machine-invariant.
 * Order matters: specific patterns before generic ones.
 */
export function normalize(text) {
  if (typeof text !== "string") return text;
  return (
    text
      // ANSI colors/styles
      .replace(/\x1b\[[0-9;]*m/g, "")
      // ISO timestamps
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<TS>")
      // UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
      // dial-token blobs (base64url.base64url, long)
      .replace(/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/g, "<TOKEN>")
      // epoch seconds in expiry messages
      .replace(/epoch \d{9,}/g, "epoch <EPOCH>")
      // clock times (destination local time is 23:07, quiet-hours messages)
      .replace(/\b\d{1,2}:\d{2}\b/g, "<TIME>")
      // "Retry in N minute(s)"
      .replace(/Retry in \d+ minutes?/g, "Retry in <N> minutes")
      // temp paths (macOS + generic)
      .replace(/\/private\/var\/folders\/[^\s"')]+/g, "<TMP>")
      .replace(/\/var\/folders\/[^\s"')]+/g, "<TMP>")
      .replace(/\/tmp\/[^\s"')]+/g, "<TMP>")
      // the bundle's own file path + line number (differs by version dir + build) — the
      // dedicated cli.version / mcp.initialize probes assert the version; incidental
      // occurrences in framework startup logs are location noise.
      .replace(/file:\/\/\S*?dist\/index\.js(?::\d+)?/g, "<BUNDLE>")
      // "speko-calls@0.4.8" in mcp-framework startup logs — version asserted elsewhere.
      .replace(/speko-calls@\d+\.\d+\.\d+/g, "speko-calls@<VER>")
      // connection failures: undici/node variants collapse to one marker
      .replace(/AggregateError(?:\s*\[[A-Z_]+\])?/g, "<NETERR>")
      .replace(/(?:connect )?ECONNREFUSED(?:\s+[\d.:[\]]+)?/g, "<NETERR>")
      .replace(/fetch failed[^\n"]*/g, "<NETERR>")
      .replace(/(?:Client network socket|socket hang up|other side closed)[^\n"]*/g, "<NETERR>")
      // node deprecation/experimental warnings vary by node version
      .replace(/^\(node:\d+\) .*$\n?/gm, "")
  );
}

/** Deep-normalize any JSON-serializable value. */
export function normalizeValue(v) {
  if (typeof v === "string") return normalize(v);
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalizeValue(v[k]);
    return out;
  }
  return v;
}
