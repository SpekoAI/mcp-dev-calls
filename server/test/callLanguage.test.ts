/**
 * Call language (SPEKO_CALL_LANGUAGE / the per-call `language` field): a whole call can run in a
 * non-English language. The dial must pin intent.language, open with a localized AI disclosure
 * (never the English one), tell the model to speak only that language, and drop the English STT
 * vocab hints. Internal owner/OTP scripts stay English, and an unknown language is refused before
 * any dial rather than ringing someone with an English disclosure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceDialParams } from "@spekoai/sdk";
import { makeCall, type MakeCallDeps } from "../src/calls/makeCall.js";
import { ConfigError, loadConfig, resetConfigForTests, type AppConfig } from "../src/config.js";
import { DIAL_STT_KEYWORDS } from "../src/constants.js";
import { callNumberSchema, callSchema } from "../src/routes.js";
import { mintDialToken } from "../src/safety/dialToken.js";
import { languageName, normalizeCallLanguage } from "../src/safety/language.js";
import { buildFirstMessage, buildSystemPrompt } from "../src/safety/prompt.js";
import { zoneFromE164 } from "../src/safety/timezone.js";
import type { SpekoClient } from "../src/speko/client.js";

const SECRET = "language-test-secret";
const BH = "acct-hash";
const BOGOTA_BUSINESS = "+576015551234";
const noop = async (): Promise<void> => {};
const now = new Date();
const NOON_OFFSET = 12 * 60 - (now.getUTCHours() * 60 + now.getUTCMinutes());

let guardDir = "";
beforeEach(() => {
  guardDir = mkdtempSync(join(tmpdir(), "speko-lang-"));
});
afterEach(() => {
  rmSync(guardDir, { recursive: true, force: true });
});

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dialTokenSecret: SECRET,
    serializeCalls: false,
    fromNumber: "+15312160099",
    trustedNumbers: [],
    guardStateDir: guardDir,
    rateCapPerNumberHour: 3,
    rateCapPerNumberDay: 8,
    ...overrides,
  } as unknown as AppConfig;
}

function mint(): string {
  return mintDialToken({
    e164: BOGOTA_BUSINESS,
    lineType: "voip",
    businessName: "Panadería La Esquina",
    utcOffsetMinutes: NOON_OFFSET,
    bearerHash: BH,
    secret: SECRET,
  });
}

function connectedClient(): { client: SpekoClient; captured: VoiceDialParams[]; dialed: () => number } {
  const captured: VoiceDialParams[] = [];
  const client = {
    dial: async (body: VoiceDialParams) => {
      captured.push(body);
      return { sessionId: "s1", callControlId: "leg-1", roomName: "r", status: "dialing", to: body.to!, from: body.from! } as never;
    },
    getEvents: async () => [{ event_type: "room_finished" }] as never,
    getCall: async () =>
      ({ status: "completed", transcript: { entries: [{ source: "agent", text: "hola" }, { source: "user", text: "sí" }] }, report: {} }) as never,
    getSession: async () => ({ phoneCall: { callControlId: "leg-1" }, usage: [{ provider: "telnyx", metric: "outbound_minutes" }] }) as never,
  } as unknown as SpekoClient;
  return { client, captured, dialed: () => captured.length };
}

function deps(client: SpekoClient, overrides: Partial<AppConfig> = {}, extra: Partial<MakeCallDeps> = {}): MakeCallDeps {
  return { client, cfg: cfg(overrides), bearerHash: BH, sleep: noop, ...extra };
}

const OBJECTIVE = "Ask if they have fresh pandebono today and until what time they are open.";

describe("normalizeCallLanguage", () => {
  it.each([
    ["es", "es"],
    ["es-CO", "es-CO"],
    ["es-co", "es-CO"],
    ["ES_co", "es-CO"],
    [" pt-BR ", "pt-BR"],
    ["en-US", "en-US"],
    ["fr", "fr"],
  ])("accepts %j as %j", (raw, expected) => {
    expect(normalizeCallLanguage(raw)).toBe(expected);
  });

  it.each(["", "   ", "spanish", "es-419", "es-CO-x", "ja", "zz", 42, null, undefined])(
    "rejects %j (malformed, or no localized disclosure for it)",
    (raw) => {
      expect(normalizeCallLanguage(raw)).toBeNull();
    },
  );

  it("names the language in English for the prompt", () => {
    expect(languageName("es-CO")).toBe("Spanish");
  });
});

describe("localized opener and prompt", () => {
  it("Spanish opener keeps the AI disclosure, names the caller, and speaks no English or objective text", () => {
    const fm = buildFirstMessage("Camilo", OBJECTIVE, "es-CO");
    expect(fm).toBe(
      "Hola, soy el asistente de inteligencia artificial de Camilo y le llamo de su parte con una consulta rápida.",
    );
    expect(fm).not.toMatch(/\bAI assistant\b|\bHi\b|pandebono/i);
  });

  it("Spanish opener without a usable name still discloses", () => {
    expect(buildFirstMessage("!!!", OBJECTIVE, "es")).toMatch(/^Hola, soy un asistente de inteligencia artificial/);
  });

  it("English stays the default and keeps the grafting opener", () => {
    expect(buildFirstMessage("Camilo", "book a table for two")).toBe(buildFirstMessage("Camilo", "book a table for two", "en"));
    expect(buildFirstMessage("Camilo", "book a table for two", "en-US")).toMatch(/Camilo asked me to book a table for two/);
  });

  it("Spanish system prompt pins the spoken language and has the model state the ask itself", () => {
    const prompt = buildSystemPrompt(OBJECTIVE, null, "Panadería La Esquina", "Camilo", null, true, "es-CO");
    expect(prompt).toMatch(/conduct this ENTIRE call in Spanish \(es-CO\)/);
    expect(prompt).toMatch(/Never switch to English/);
    expect(prompt).toMatch(/did NOT say what the question is/);
    expect(prompt).toMatch(/state the ask from the objective in one short Spanish sentence/);
  });

  it("English system prompt is unchanged by the language parameter", () => {
    const strip = (p: string) => p.replace(/[0-9a-f]{16}/g, "NONCE");
    const def = strip(buildSystemPrompt(OBJECTIVE, null, "Joe's", "Camilo", null, true));
    expect(strip(buildSystemPrompt(OBJECTIVE, null, "Joe's", "Camilo", null, true, "en"))).toBe(def);
    expect(def).not.toMatch(/LANGUAGE:/);
  });
});

describe("make_call dial body follows the call language", () => {
  it("per-call language pins intent, opener, prompt, and drops the English STT vocab", async () => {
    const { client, captured } = connectedClient();
    await makeCall({ dialToken: mint(), objective: OBJECTIVE, callerName: "Camilo", language: "es-co" }, deps(client));
    expect(captured).toHaveLength(1);
    const body = captured[0];
    expect(body.intent?.language).toBe("es-CO");
    expect(body.firstMessage).toMatch(/^Hola, soy el asistente de inteligencia artificial de Camilo/);
    expect(body.systemPrompt).toMatch(/ENTIRE call in Spanish \(es-CO\)/);
    expect(body.sttOptions?.keywords).toContain("Camilo");
    expect(body.sttOptions?.keywords).toContain("Panadería La Esquina");
    for (const english of DIAL_STT_KEYWORDS) expect(body.sttOptions?.keywords).not.toContain(english);
  });

  it("uses SPEKO_CALL_LANGUAGE (cfg.callLanguage) when the call names none, and a per-call value overrides it", async () => {
    const first = connectedClient();
    await makeCall({ dialToken: mint(), objective: OBJECTIVE, callerName: "Camilo" }, deps(first.client, { callLanguage: "es" }));
    expect(first.captured[0].intent?.language).toBe("es");
    expect(first.captured[0].firstMessage).toMatch(/^Hola/);

    const second = connectedClient();
    await makeCall(
      { dialToken: mint(), objective: `${OBJECTIVE} (second)`, callerName: "Camilo", language: "en" },
      deps(second.client, { callLanguage: "es" }),
    );
    expect(second.captured[0].intent?.language).toBe("en");
    expect(second.captured[0].firstMessage).toMatch(/^Hi, I'm Camilo's AI assistant/);
    expect(second.captured[0].sttOptions?.keywords).toEqual(expect.arrayContaining([...DIAL_STT_KEYWORDS]));
  });

  it("defaults to English when neither the call nor the config names a language", async () => {
    const { client, captured } = connectedClient();
    await makeCall({ dialToken: mint(), objective: OBJECTIVE, callerName: "Camilo", language: "  " }, deps(client));
    expect(captured[0].intent?.language).toBe("en");
  });

  it("refuses an unsupported language before dialing", async () => {
    const { client, dialed } = connectedClient();
    await expect(
      makeCall({ dialToken: mint(), objective: OBJECTIVE, callerName: "Camilo", language: "ja" }, deps(client)),
    ).rejects.toThrow(/Unsupported call language "ja".*Supported languages: en, es/);
    expect(dialed()).toBe(0);
  });

  it("internal owner/OTP scripts stay English even when the server default is Spanish", async () => {
    const { client, captured } = connectedClient();
    await makeCall(
      { dialToken: mint(), objective: OBJECTIVE, callerName: "Camilo", language: "es" },
      deps(client, { callLanguage: "es" }, { firstMessageOverride: "Hi, this is a scripted owner call.", systemPromptOverride: () => "script" }),
    );
    expect(captured[0].intent?.language).toBe("en");
    expect(captured[0].firstMessage).toBe("Hi, this is a scripted owner call.");
  });
});

describe("wire schemas and config", () => {
  it("make_call and call_number request schemas carry an optional language", () => {
    expect(callSchema.parse({ dial_token: "t", objective: "o", caller_name: "c", language: "es-CO" }).language).toBe("es-CO");
    expect(callSchema.parse({ dial_token: "t", objective: "o", caller_name: "c" }).language).toBeUndefined();
    expect(
      callNumberSchema.parse({ phone_number: "+576015551234", objective: "o", caller_name: "c", language: "es" }).language,
    ).toBe("es");
  });

  describe("SPEKO_CALL_LANGUAGE", () => {
    const KEYS = ["SPEKO_CALL_LANGUAGE", "SPEKO_API_KEY", "SPEKO_DIAL_TOKEN_SECRET", "SPEKO_TEST_MODE"] as const;
    let saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      saved = {};
      for (const k of KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      process.env.SPEKO_API_KEY = "sk_live_language_test";
      process.env.SPEKO_DIAL_TOKEN_SECRET = "language-config-secret";
      resetConfigForTests();
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      resetConfigForTests();
    });

    it("defaults to en", () => {
      expect(loadConfig().callLanguage).toBe("en");
    });

    it("normalizes a configured tag", () => {
      process.env.SPEKO_CALL_LANGUAGE = "es_co";
      expect(loadConfig().callLanguage).toBe("es-CO");
    });

    it("fails startup loudly on an unsupported tag instead of silently calling in English", () => {
      process.env.SPEKO_CALL_LANGUAGE = "klingon";
      expect(() => loadConfig()).toThrow(ConfigError);
      resetConfigForTests();
      expect(() => loadConfig()).toThrow(/SPEKO_CALL_LANGUAGE: Unsupported call language "klingon"/);
    });
  });

  it("maps Colombian numbers to Bogota time for the after-hours gate", () => {
    expect(zoneFromE164(BOGOTA_BUSINESS)).toBe("America/Bogota");
    expect(zoneFromE164("+573001234567")).toBe("America/Bogota");
  });
});
