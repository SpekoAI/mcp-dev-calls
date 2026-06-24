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
  /**
   * Explicit outbound caller-ID (E.164). When set, every dial uses it as `from`.
   * When unset, make_call auto-resolves the account's first outbound-ready number,
   * so the demo works without the prod TELNYX_DEFAULT_FROM_NUMBER default.
   */
  fromNumber: string | undefined;
  /** Optional TTS voice id. Intentionally NOT applied to dials — naturalness comes from
   * the TTS MODEL pin below, not a voice id (pinning a raw voice id caused silent audio). */
  voice: string | undefined;
  /** TTS speed multiplier; defaults to 1.0 at dial time. */
  ttsSpeed: number | undefined;
  /** provider:model pin for TTS. Default = elevenlabs:eleven_flash_v2_5 — our switchboard's
   * live pick (lowest latency, best EN CER). No measured EN-naturalness number yet, so no
   * "verified"/"most natural" claim until the head-to-head harness runs. */
  ttsPin: string;
  /** provider pin for STT. Default = deepgram:nova-3 — clean win across every source.
   * (Streaming first-partial ≈ 1.3s; the ~366ms figure is the serial p50, not first-partial.) */
  sttPin: string;
  /**
   * Comma-separated provider:model LLM FAILOVER CHAIN. Default =
   * groq:llama-3.3-70b-versatile (primary — healthy + fast) → openai:gpt-4.1-mini
   * (tool-heavy fallback). gpt-5 (the old selector default) was 502-ing platform-wide and
   * isn't even in our TTFT race; with a chain, one provider outage no longer breaks every
   * call. Override with SPEKO_LLM_PIN (comma-separated for cross-provider failover).
   */
  llmPin: string;
  /** Routing goal. Default = latency (best for a live call: fast STT + low TTFT LLM). */
  optimizeFor: "balanced" | "accuracy" | "latency" | "cost";
  /**
   * Opt-in (SPEKO_ALLOW_DIRECT_DIAL=1): let `call_number` dial ANY number — including
   * mobiles — for personal calls. OFF by default: the product is business-lines-only
   * unless the operator explicitly opts in and owns consent + TCPA for those contacts.
   * Even when on, the AI disclosure, quiet hours, no-spam screen, and emergency/premium
   * block all still apply.
   */
  allowDirectDial: boolean;
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
    fromNumber:
      (process.env.SPEKO_FROM_NUMBER || process.env.TELNYX_DEFAULT_FROM_NUMBER || "").trim() || undefined,
    voice: (process.env.SPEKO_DEMO_VOICE ?? "").trim() || undefined,
    ttsSpeed: (() => {
      const n = Number(process.env.SPEKO_DEMO_TTS_SPEED);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    ttsPin: (process.env.SPEKO_TTS_PIN ?? "").trim() || "elevenlabs:eleven_flash_v2_5",
    sttPin: (process.env.SPEKO_STT_PIN ?? "").trim() || "deepgram:nova-3",
    llmPin: (process.env.SPEKO_LLM_PIN ?? "").trim() || "groq:llama-3.3-70b-versatile,openai:gpt-4.1-mini",
    optimizeFor: (() => {
      const v = (process.env.SPEKO_OPTIMIZE_FOR ?? "").trim();
      return (["balanced", "accuracy", "latency", "cost"].includes(v) ? v : "latency") as
        | "balanced"
        | "accuracy"
        | "latency"
        | "cost";
    })(),
    allowDirectDial: ["1", "true", "yes"].includes((process.env.SPEKO_ALLOW_DIRECT_DIAL ?? "").trim().toLowerCase()),
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
