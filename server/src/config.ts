/**
 * Demo-server configuration. Loads the repo-root `.env` (shared with the rest of
 * the repo) and validates the secrets that MUST live server-side and never ship
 * to the MCP/npx tier: the Speko API key, the dial-token signing secret, and the
 * optional Google Places / Twilio carrier-check keys.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Load the first `.env` found among repo-root candidates. Missing file is fine. */
function loadDotenv(): void {
  const load = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (!load) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    resolve(here, "..", ".env"), // server/.env (src or dist)
    resolve(here, "..", "..", ".env"), // repo root from server/dist
    resolve(here, "..", "..", "..", ".env"), // repo root from server/dist/<sub>
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        load(path);
      } catch {
        // Ignore a malformed/locked .env — fall back to the process environment.
      }
      return;
    }
  }
}

function bearer(raw: string): string {
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}

export interface DemoConfig {
  enabled: boolean;
  e164: string;
  business: string;
  lineType: string;
  utcOffsetRaw: string | undefined;
  address: string;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Optional shared secret the MCP tier must present (header `x-internal-key`). */
  internalKey: string | undefined;
  speko: { apiKey: string; baseUrl: string | undefined };
  dialTokenSecret: string;
  googlePlacesApiKey: string | undefined;
  twilio: { sid: string; token: string } | undefined;
  demo: DemoConfig;
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadDotenv();

  const apiKeyRaw = (process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "").trim();
  if (!apiKeyRaw) {
    throw new ConfigError(
      "SPEKO_API_KEY is required. Get one from https://platform.speko.dev and set it in the repo-root .env.",
    );
  }
  const dialTokenSecret = (process.env.SPEKO_DIAL_TOKEN_SECRET ?? "").trim();
  if (!dialTokenSecret) {
    throw new ConfigError(
      "SPEKO_DIAL_TOKEN_SECRET is required (any long random string). Set it in the repo-root .env.",
    );
  }

  const twilioSid = (process.env.TWILIO_LOOKUP_SID ?? "").trim();
  const twilioToken = (process.env.TWILIO_LOOKUP_TOKEN ?? "").trim();

  cached = {
    port: Number(process.env.PORT ?? process.env.SPEKO_MCP_SERVER_PORT ?? 8787),
    host: (process.env.HOST ?? "127.0.0.1").trim(),
    internalKey: (process.env.MCP_INTERNAL_KEY ?? "").trim() || undefined,
    speko: {
      apiKey: bearer(apiKeyRaw),
      baseUrl:
        (process.env.SPEKOAI_API_URL || process.env.SPEKO_API_BASE || process.env.SPEKOAI_BASE_URL || "").trim() ||
        undefined,
    },
    dialTokenSecret,
    googlePlacesApiKey: (process.env.GOOGLE_PLACES_API_KEY ?? "").trim() || undefined,
    twilio: twilioSid && twilioToken ? { sid: twilioSid, token: twilioToken } : undefined,
    demo: {
      enabled: process.env.SPEKO_DEMO === "1" || Boolean((process.env.SPEKO_DEMO_E164 ?? "").trim()),
      e164: (process.env.SPEKO_DEMO_E164 ?? "").trim(),
      business: (process.env.SPEKO_DEMO_BUSINESS ?? "").trim(),
      lineType: (process.env.SPEKO_DEMO_LINE_TYPE ?? "voip").trim() || "voip",
      utcOffsetRaw: process.env.SPEKO_DEMO_UTC_OFFSET,
      address: (process.env.SPEKO_DEMO_ADDRESS ?? "").trim(),
    },
  };
  return cached;
}

/**
 * Account binding for dial tokens. Tokens are minted and verified by THIS server
 * with the configured Speko key, so a token can never be replayed against a
 * server wired to a different account.
 */
export function serverBearerHash(cfg: AppConfig): string {
  return createHash("sha256").update(cfg.speko.apiKey, "utf-8").digest("hex").slice(0, 16);
}
