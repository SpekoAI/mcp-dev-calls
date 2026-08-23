/**
 * Demo-server configuration. Loads the repo-root `.env` (shared with the rest of
 * the repo) and validates the secrets that MUST live server-side and never ship
 * to the MCP/npx tier: the Speko API key, the dial-token signing secret, and the
 * optional Google Places / Twilio carrier-check keys.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RATE_CAP_PER_NUMBER_DAY, RATE_CAP_PER_NUMBER_HOUR } from "./constants.js";
import { normalizeE164 } from "./safety/guard.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Load the first `.env` found among repo-root candidates. Missing file is fine.
 * Gated exactly like the MCP tier's loader: SPEKO_NO_DOTENV=1 disables discovery
 * here too. This matters because the core loads lazily at the first tool call —
 * in single-process MCP-server mode the MCP tier sets SPEKO_NO_DOTENV before the
 * core can run, so a `.env` planted in an untrusted spawn cwd never reaches it.
 */
function loadDotenv(): void {
  if (["1", "true", "yes", "on"].includes((process.env.SPEKO_NO_DOTENV ?? "").trim().toLowerCase())) return;
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
        return;
      }
      process.stderr.write(
        `speko: loaded .env from ${path} (set SPEKO_NO_DOTENV=1 to disable .env discovery)\n`,
      );
      return;
    }
  }
}

function bearer(raw: string): string {
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}

// ── Hermetic test mode (SPEKO_TEST_MODE) ─────────────────────────────────────
// An in-process simulation mode: a fake platform client, no network, no telephony,
// no secrets. Every safety rail still runs for real against isolated temp state.

/** True when SPEKO_TEST_MODE selects the hermetic in-process simulation mode. */
export function testModeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.SPEKO_TEST_MODE ?? "").trim().toLowerCase());
}

// Self-supplied fixtures so test mode needs zero configuration. The key is shaped like a
// Speko test key (never a live sk_ prefix); the dial-token secret only ever signs tokens
// that are minted AND verified inside this same simulated process.
const TEST_MODE_FIXTURE_API_KEY = "sk_test_speko_hermetic_fixture";
const TEST_MODE_FIXTURE_DIAL_SECRET = "speko-test-mode-fixture-dial-token-secret";

// Frozen wall-clock anchor for test mode's after-hours gate: 14:00 destination-local,
// deterministic at any CI hour/timezone. The date itself is arbitrary but fixed.
const TEST_MODE_FROZEN_ANCHOR_SECONDS = Date.UTC(2026, 0, 15, 14, 0, 0) / 1000;

/**
 * The clock (and offset) the after-hours gate reads. Real mode: identity — real offset, real
 * clock, and SPEKO_FAKE_NOW is structurally invisible (loadConfig never parses it outside test
 * mode, so cfg.fakeNowMs is always undefined there). Test mode: a frozen clock reading 14:00
 * destination-local (an unknown offset is simulated as UTC) so CI is deterministic at any hour;
 * SPEKO_FAKE_NOW overrides the frozen clock with real gate semantics — including the
 * unknown-offset confirmation branch — so the gate itself stays testable.
 */
export function afterHoursTestClock(
  cfg: Pick<AppConfig, "testMode" | "fakeNowMs">,
  utcOffsetMinutes: number | null,
): { utcOffsetMinutes: number | null; nowSeconds: number | undefined } {
  if (cfg.testMode !== true) return { utcOffsetMinutes, nowSeconds: undefined };
  if (typeof cfg.fakeNowMs === "number") return { utcOffsetMinutes, nowSeconds: cfg.fakeNowMs / 1000 };
  const offset = utcOffsetMinutes ?? 0;
  return { utcOffsetMinutes: offset, nowSeconds: TEST_MODE_FROZEN_ANCHOR_SECONDS - offset * 60 };
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

export const CLIENT_PROFILES = [
  "claude-code",
  "codex",
  "cline",
  "gemini",
  "cursor",
  "windsurf",
  "safe-default",
] as const;

export type ClientProfile = (typeof CLIENT_PROFILES)[number];

export function parseClientProfile(raw: unknown): { profile: ClientProfile; configured: boolean } {
  const value = typeof raw === "string" ? raw.trim() : "";
  const configured = (CLIENT_PROFILES as readonly string[]).includes(value);
  return { profile: configured ? (value as ClientProfile) : "safe-default", configured };
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
  /** provider pin for STT. Default = soniox:stt-rt-v5, the newest Soniox realtime model in
   * the platform catalog (Bek, 2026-08-22 — replaced deepgram:nova-3 after repeated STT
   * misses on live calls). Override with SPEKO_STT_PIN. */
  sttPin: string;
  /**
   * Comma-separated provider:model LLM FAILOVER CHAIN. Default =
   * cerebras:gemma-4-31b (primary — non-reasoning, tool-capable, fastest open-cloud host)
   * → openai:gpt-4.1-mini (tool-heavy fallback). Groq was dropped 2026-07-06: no capacity
   * on their side, all Speko usage paused (Cerebras is the open-cloud lane); the platform
   * also filters disabled providers, so a stale groq entry silently fell through anyway.
   * gpt-5 (the old selector default) was 502-ing platform-wide and isn't even in our TTFT
   * race; with a chain, one provider outage no longer breaks every call. Override with
   * SPEKO_LLM_PIN (comma-separated for cross-provider failover).
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
  /** Local owner profile directory. Defaults to the guard-state directory. */
  ownerStateDir: string | undefined;
  rateCapPerNumberHour: number;
  rateCapPerNumberDay: number;
  /** Per-client timeout behavior written by the init wizard; unknown values fail poll-safe. */
  clientProfile: ClientProfile;
  clientProfileConfigured: boolean;
  /** Emergency local kill switch. It prevents call_me before any dial attempt. */
  callMeDisabled: boolean;
  /** Base URL of the Speko dashboard; call summaries expose `${base}/sessions/{call_id}`. */
  dashboardBaseUrl: string;
  /**
   * Serialize outbound calls within this process — reject a 2nd concurrent call while one is
   * in flight. OFF by default: platform per-call room isolation (SpekoAI/platform#903) shipped
   * and was verified under concurrency (issue #37 M4, 2026-07-03 — two simultaneous dials got
   * DISTINCT rooms + clean two-way audio, no cross-talk). Set SPEKO_SERIALIZE_CALLS=1 to
   * re-enable it as a kill switch for one release before the guard is removed entirely.
   */
  serializeCalls: boolean;
  /**
   * Ask the platform worker to play the greeting immediately on answer while AMD classifies in
   * the background. ON by default; SPEKO_DIAL_GREET_FIRST=0/false/no/off omits the field for rollback
   * (same falsy convention as SPEKO_SERIALIZE_CALLS).
   */
  dialGreetFirst: boolean;
  dialTokenSecret: string;
  googlePlacesApiKey: string | undefined;
  twilio: { sid: string; token: string } | undefined;
  demo: DemoConfig;
  /**
   * Hermetic test mode (SPEKO_TEST_MODE=1/true/yes/on): the in-process backend runs a fake
   * platform client — no network, no telephony, fixture credentials, fresh temp state dirs —
   * while every safety rail still runs for real. Structurally exclusive with real dialing:
   * loadConfig refuses a live-looking sk_ key and refuses SPEKO_MCP_SERVER_URL under it.
   */
  testMode: boolean;
  /**
   * SPEKO_FAKE_NOW as epoch ms — parsed ONLY when testMode is on. In real mode this is ALWAYS
   * undefined (the env var is never even read), so a stray SPEKO_FAKE_NOW can never move the
   * after-hours gate on a real deployment.
   */
  fakeNowMs: number | undefined;
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadDotenv();

  const testMode = testModeRequested(process.env);
  let apiKeyRaw = (process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "").trim();
  if (testMode) {
    // STRUCTURAL SAFETY INVARIANT: one process can simulate calls or place real ones — never
    // both. Test mode therefore refuses to start alongside anything that could reach a real
    // backend, instead of silently ignoring it.
    const remoteUrl = (process.env.SPEKO_MCP_SERVER_URL ?? "").trim();
    if (remoteUrl) {
      throw new ConfigError(
        "SPEKO_TEST_MODE is enabled but SPEKO_MCP_SERVER_URL is set — remote mode and test mode " +
          "cannot mix in one process. Unset SPEKO_MCP_SERVER_URL to run the hermetic simulation " +
          "in-process, or unset SPEKO_TEST_MODE to use the remote server.",
      );
    }
    const strippedKey = bearer(apiKeyRaw);
    if (strippedKey.startsWith("sk_") && !strippedKey.startsWith("sk_test_")) {
      throw new ConfigError(
        "SPEKO_TEST_MODE is enabled but a live-looking SPEKO_API_KEY (sk_*) is configured — test " +
          "mode refuses a live API key; unset SPEKO_API_KEY or use an sk_test_ fixture key. " +
          "(No key is needed at all in test mode.)",
      );
    }
    if (!apiKeyRaw) apiKeyRaw = TEST_MODE_FIXTURE_API_KEY;
  }
  if (!apiKeyRaw) {
    throw new ConfigError(
      "SPEKO_API_KEY is required. Run `npx @spekoai/mcp-calls init` to set up, or set SPEKO_API_KEY " +
        "in your MCP client config (get a key at https://platform.speko.dev).",
    );
  }
  let dialTokenSecret = (process.env.SPEKO_DIAL_TOKEN_SECRET ?? "").trim();
  // In test mode tokens are minted and verified inside this same simulated process, so a fixture
  // secret keeps the REAL token/HMAC rails exercised with zero configuration.
  if (!dialTokenSecret && testMode) dialTokenSecret = TEST_MODE_FIXTURE_DIAL_SECRET;
  if (!dialTokenSecret) {
    throw new ConfigError(
      "SPEKO_DIAL_TOKEN_SECRET is required (any long random string). Set it in the repo-root .env.",
    );
  }

  // Test mode ALWAYS isolates guard/owner state in a fresh per-process temp dir, ignoring any
  // explicit SPEKO_GUARD_STATE_DIR / SPEKO_OWNER_STATE_DIR. This is a safety invariant, not a
  // convenience: test mode seeds an un-OTP'd fixture owner (+15005550100) at init, and if that
  // landed in the host's real owner dir, a later REAL-mode process reading the same dir would
  // trust the fixture owner and place un-consented owner calls. A simulation has no reason to
  // touch the host's real ledgers, so the temp dir is unconditional in test mode.
  let guardStateDirEnv = (process.env.SPEKO_GUARD_STATE_DIR ?? "").trim();
  let ownerStateDirEnv = (process.env.SPEKO_OWNER_STATE_DIR ?? "").trim();
  const testStateDir = testMode ? mkdtempSync(join(tmpdir(), "speko-test-mode-")) : undefined;
  if (testMode && (guardStateDirEnv || ownerStateDirEnv)) {
    process.stderr.write(
      "speko: test mode ignores SPEKO_GUARD_STATE_DIR / SPEKO_OWNER_STATE_DIR and uses an isolated " +
        "temp dir, so the simulated fixture owner never reaches your real owner state.\n",
    );
    guardStateDirEnv = "";
    ownerStateDirEnv = "";
  }

  const fakeNowMs = ((): number | undefined => {
    if (!testMode) return undefined; // real mode NEVER reads SPEKO_FAKE_NOW
    const raw = (process.env.SPEKO_FAKE_NOW ?? "").trim();
    if (!raw) return undefined;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      throw new ConfigError(
        "SPEKO_FAKE_NOW must be an ISO-8601 timestamp (test-mode only), e.g. 2026-01-15T21:30:00Z.",
      );
    }
    return parsed;
  })();

  const twilioSid = (process.env.TWILIO_LOOKUP_SID ?? "").trim();
  const twilioToken = (process.env.TWILIO_LOOKUP_TOKEN ?? "").trim();

  const rawClientProfile = (process.env.SPEKO_CLIENT_PROFILE ?? "").trim();
  const parsedClientProfile = parseClientProfile(rawClientProfile);

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
    sttPin: (process.env.SPEKO_STT_PIN ?? "").trim() || "soniox:stt-rt-v5",
    llmPin: (process.env.SPEKO_LLM_PIN ?? "").trim() || "cerebras:gemma-4-31b,openai:gpt-4.1-mini",
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
    guardStateDir: guardStateDirEnv || testStateDir || undefined,
    ownerStateDir: ownerStateDirEnv || guardStateDirEnv || testStateDir || undefined,
    rateCapPerNumberHour: positiveIntEnv("SPEKO_MAX_CALLS_PER_NUMBER_HOUR", RATE_CAP_PER_NUMBER_HOUR),
    rateCapPerNumberDay: positiveIntEnv("SPEKO_MAX_CALLS_PER_NUMBER_DAY", RATE_CAP_PER_NUMBER_DAY),
    clientProfile: parsedClientProfile.profile,
    clientProfileConfigured: parsedClientProfile.configured,
    callMeDisabled: ["1", "true", "yes", "on"].includes(
      (process.env.SPEKO_CALLME_DISABLED ?? "").trim().toLowerCase(),
    ),
    dashboardBaseUrl:
      ((process.env.SPEKO_DASHBOARD_URL ?? process.env.SPEKO_PLATFORM_URL ?? "").trim() || "https://platform.speko.dev").replace(/\/+$/, ""),
    // OFF unless explicitly opted in (kill switch); #903 per-call rooms made the guard redundant (#37 M4).
    serializeCalls: ["1", "true", "yes", "on"].includes((process.env.SPEKO_SERIALIZE_CALLS ?? "").trim().toLowerCase()),
    dialGreetFirst: !["0", "false", "no", "off"].includes((process.env.SPEKO_DIAL_GREET_FIRST ?? "").trim().toLowerCase()),
    dialTokenSecret,
    googlePlacesApiKey: (process.env.GOOGLE_PLACES_API_KEY ?? "").trim() || undefined,
    twilio: twilioSid && twilioToken ? { sid: twilioSid, token: twilioToken } : undefined,
    testMode,
    fakeNowMs,
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

/** Test-only: drop the cached config so environment changes take effect on the next loadConfig. */
export function resetConfigForTests(): void {
  cached = undefined;
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
