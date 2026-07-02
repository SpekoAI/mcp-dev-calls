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
import { RATE_CAP_PER_NUMBER_DAY, RATE_CAP_PER_NUMBER_HOUR } from "./constants.js";
import { normalizeE164 } from "./safety/guard.js";

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

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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
  /** provider:model pin for TTS. Default = elevenlabs:eleven_flash_v2_5 — PROVEN to produce
   * audible audio on a live connected call (2026-06-30). eleven_turbo_v2_5 is more natural and
   * passes the /synthesize preflight, but SILENTLY produced no agent audio in the live worker
   * on the same date (the live TTS path differs from /synthesize) — do NOT default to it until
   * re-verified on a real call. Override with SPEKO_TTS_PIN. */
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
   * Lets `call_number` dial ANY number — including mobiles — for personal calls.
   * ON by default (it's a first-class feature). Set SPEKO_ALLOW_DIRECT_DIAL=0 (or
   * false/no/off) to restrict a deployment to business lines only. Either way the AI
   * disclosure, abuse guardrails (DNC, rate caps, after-hours confirmation), no-spam
   * objective screen, and emergency/premium block all still apply — only the
   * business-line-type check is relaxed.
   */
  allowDirectDial: boolean;
  trustedNumbers: string[];
  guardStateDir: string | undefined;
  rateCapPerNumberHour: number;
  rateCapPerNumberDay: number;
  /** Base URL of the Speko dashboard; call summaries expose `${base}/sessions/{call_id}`. */
  dashboardBaseUrl: string;
  /**
   * Serialize outbound calls within this process — reject a 2nd concurrent call while one is
   * in flight. ON by default: the platform currently routes concurrent legs into a shared
   * LiveKit room (>2 participants garble each other). Set SPEKO_SERIALIZE_CALLS=0 to disable
   * once the platform ships per-call room isolation (SpekoAI/platform#903).
   */
  serializeCalls: boolean;
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
    port: (() => {
      const n = Number(process.env.PORT ?? process.env.SPEKO_MCP_SERVER_PORT ?? 8787);
      return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8787;
    })(),
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
    allowDirectDial: !["0", "false", "no", "off"].includes((process.env.SPEKO_ALLOW_DIRECT_DIAL ?? "").trim().toLowerCase()),
    trustedNumbers: (process.env.SPEKO_TRUSTED_NUMBERS ?? "")
      .split(",")
      .map((number) => normalizeE164(number.trim()))
      .filter(Boolean),
    guardStateDir: (process.env.SPEKO_GUARD_STATE_DIR ?? "").trim() || undefined,
    rateCapPerNumberHour: positiveIntEnv("SPEKO_MAX_CALLS_PER_NUMBER_HOUR", RATE_CAP_PER_NUMBER_HOUR),
    rateCapPerNumberDay: positiveIntEnv("SPEKO_MAX_CALLS_PER_NUMBER_DAY", RATE_CAP_PER_NUMBER_DAY),
    dashboardBaseUrl:
      ((process.env.SPEKO_DASHBOARD_URL ?? process.env.SPEKO_PLATFORM_URL ?? "").trim() || "https://platform.speko.dev").replace(/\/+$/, ""),
    serializeCalls: !["0", "false", "no", "off"].includes((process.env.SPEKO_SERIALIZE_CALLS ?? "").trim().toLowerCase()),
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
 * The dial-time provider pins above as an `allowedProviders` map — the shape shared
 * by dial-body constraints and agent-create stackPreferences. A modality is included
 * only when its pin is set: loadConfig always pins all three, but the dial-agent
 * bootstrap may run with no pins at all. The llm pin is a comma-separated failover
 * chain; empty entries are dropped.
 */
export function allowedProvidersFromPins(pins: {
  ttsPin?: string;
  sttPin?: string;
  llmPin?: string;
}): { tts?: string[]; stt?: string[]; llm?: string[] } {
  const tts = pins.ttsPin?.trim();
  const stt = pins.sttPin?.trim();
  const llm = (pins.llmPin ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return {
    ...(tts ? { tts: [tts] } : {}),
    ...(stt ? { stt: [stt] } : {}),
    ...(llm.length > 0 ? { llm } : {}),
  };
}

/**
 * Account binding for dial tokens. Tokens are minted and verified by THIS server
 * with the configured Speko key, so a token can never be replayed against a
 * server wired to a different account.
 */
export function serverBearerHash(cfg: AppConfig): string {
  return createHash("sha256").update(cfg.speko.apiKey, "utf-8").digest("hex").slice(0, 16);
}
