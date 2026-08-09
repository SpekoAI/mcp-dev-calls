/**
 * Portable owner state for headless installs (ephemeral sandboxes with no TTY).
 * `speko me export` prints the local verified owner profile as one compact
 * version-tagged blob; SPEKO_OWNER_PROFILE feeds the same blob back into a fresh
 * state dir at backend init so call_me works without an interactive re-verify.
 *
 * The blob is deliberately NOT a new trust boundary: it round-trips the exact
 * client-trusted owner.json that `speko me verify` writes today. A client-side
 * signature would be checked by the same code an attacker controls, so none is
 * added — treat the blob as credential-equivalent for ringing that one number
 * and store it as a secret. Every call_me rail (DNC, rate caps, quiet hours,
 * owner lease) still applies unchanged.
 */
import { AppError } from "../lib/errors.js";
import {
  ownerProfileFileExists,
  parseOwnerProfile,
  resolveOwnerStateDir,
  writeOwnerProfile,
  type OwnerProfile,
} from "./state.js";

export const OWNER_PROFILE_BLOB_PREFIX = "spkow1.";
/** A legitimate export is ~300-450 chars; anything past this bound is garbage, not a profile. */
const MAX_BLOB_CHARS = 1024;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Encode a validated owner profile as a single-line `spkow1.<base64url JSON>` blob. */
export function encodeOwnerProfileBlob(profile: OwnerProfile): string {
  const validated = parseOwnerProfile(profile);
  if (!validated) throw new Error("The owner profile is not valid; refusing to export.");
  const blob = `${OWNER_PROFILE_BLOB_PREFIX}${Buffer.from(JSON.stringify(validated), "utf8").toString("base64url")}`;
  if (blob.length > MAX_BLOB_CHARS) throw new Error("The owner profile export exceeded the blob size bound.");
  return blob;
}

/** Strict inverse of encodeOwnerProfileBlob. Throws a plain Error with the exact reason. */
export function decodeOwnerProfileBlob(raw: string): OwnerProfile {
  const blob = String(raw ?? "").trim();
  if (blob.length > MAX_BLOB_CHARS) throw new Error("the value is larger than any valid owner export");
  if (!blob.startsWith(OWNER_PROFILE_BLOB_PREFIX)) {
    throw new Error(`the value does not start with "${OWNER_PROFILE_BLOB_PREFIX}"`);
  }
  const body = blob.slice(OWNER_PROFILE_BLOB_PREFIX.length);
  // Buffer's base64url decoder is lenient; reject foreign characters up front.
  if (!BASE64URL_RE.test(body)) throw new Error("the value is not base64url");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("the value does not decode to JSON");
  }
  const profile = parseOwnerProfile(parsed);
  if (!profile) throw new Error("the decoded profile failed owner-profile validation");
  return profile;
}

export type OwnerSeedResult = "unset" | "kept_existing" | "seeded";

/**
 * Materialize owner.json from SPEKO_OWNER_PROFILE into an EMPTY owner state dir.
 * An existing owner.json always wins (even a corrupt one — corrupt state fails
 * closed rather than being silently replaced). An invalid blob fails closed with
 * an AppError and writes nothing.
 */
export function seedOwnerProfileFromEnv(
  opts: { env?: NodeJS.ProcessEnv; dir?: string; log?: (line: string) => void } = {},
): OwnerSeedResult {
  const env = opts.env ?? process.env;
  const blob = (env.SPEKO_OWNER_PROFILE ?? "").trim();
  if (!blob) return "unset";
  const dir = opts.dir ?? resolveOwnerStateDir(env);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (ownerProfileFileExists(dir)) {
    log("SPEKO_OWNER_PROFILE ignored: owner state already exists and always wins; the env value only seeds an empty owner state dir.");
    return "kept_existing";
  }
  let profile: OwnerProfile;
  try {
    profile = decodeOwnerProfileBlob(blob);
  } catch (error) {
    throw new AppError(
      `SPEKO_OWNER_PROFILE is set but invalid (${(error as Error).message}); call_me stays unavailable and no owner state was written.`,
      { nextStep: "Re-run `speko me export` on a host with a verified owner and set SPEKO_OWNER_PROFILE to that exact single-line value." },
    );
  }
  // Re-check immediately before the write: decode did I/O-free work, but on a fresh SHARED state
  // dir two processes could both pass the first existence check. Re-checking here narrows that
  // window so a concurrent OTP verify or a prior seed still wins. This is best-effort, not a lock;
  // the durable fix is server-side owner binding (an existing owner.json can never be clobbered by
  // an env blob), tracked as a platform ask. Kept proportionate: full FS locking in a public
  // client package is the wrong trade for a race a server-side check will obviate.
  if (ownerProfileFileExists(dir)) {
    log("SPEKO_OWNER_PROFILE ignored: owner state was written concurrently and always wins.");
    return "kept_existing";
  }
  writeOwnerProfile(
    {
      ownerPhone: profile.owner_phone,
      ownerName: profile.owner_name,
      verifiedAt: profile.phone_verified_at,
      instanceId: profile.instance_id,
    },
    dir,
  );
  log(`Seeded call_me owner state from SPEKO_OWNER_PROFILE (phone ending ${profile.owner_phone.slice(-4)}).`);
  return "seeded";
}
