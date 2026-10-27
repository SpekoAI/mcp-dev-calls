/**
 * Call language: which language a whole outbound call is conducted in.
 *
 * The tag rides the dial as `intent.language`. On the Speko platform a dial that names its
 * language PINS the call to it (services/language-policy.ts): STT language, routing and the
 * "respond only in X" directive follow it, and the worker never switches language mid-call. What the platform cannot localize is the text THIS server writes:
 * the spoken opener (with the non-removable AI disclosure) and the hard-rule system prompt. So a
 * language is accepted only when an opener template exists for it below; anything else is
 * rejected before a dial instead of ringing someone with an English disclosure.
 */

export const DEFAULT_CALL_LANGUAGE = "en";

/**
 * Same shape the platform's `/v1/sessions` intent schema enforces (`^[a-z]{2,3}(-[A-Z]{2})?$`):
 * a bare language (`es`) or a language + ISO region (`es-CO`). The phone route is looser, but
 * matching the strict one keeps a tag valid on every Speko surface.
 */
const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

interface OpenerTemplate {
  /** Opener when the caller's name is known. Disclosure + "calling on their behalf", no ask. */
  named: (name: string) => string;
  /** Opener when the name sanitized to nothing. */
  anonymous: string;
}

/**
 * Localized disclosure openers for non-English calls, keyed by primary subtag. English keeps
 * the richer grafting opener in prompt.ts (it can splice the ask into the sentence); these
 * templates deliberately do NOT carry the ask, because the objective is usually written in
 * English by the calling agent and splicing it in would speak two languages in one breath. The
 * model states the ask in the call language on its next turn (see buildSystemPrompt).
 */
const OPENERS: Readonly<Record<string, OpenerTemplate>> = {
  es: {
    named: (name) =>
      `Hola, soy el asistente de inteligencia artificial de ${name} y le llamo de su parte con una consulta rápida.`,
    anonymous: "Hola, soy un asistente de inteligencia artificial y le llamo con una consulta rápida.",
  },
  pt: {
    named: (name) =>
      `Olá, sou o assistente de inteligência artificial de ${name} e estou ligando com uma pergunta rápida.`,
    anonymous: "Olá, sou um assistente de inteligência artificial e estou ligando com uma pergunta rápida.",
  },
  fr: {
    named: (name) =>
      `Bonjour, je suis l'assistant d'intelligence artificielle de ${name} et j'appelle de sa part pour une petite question.`,
    anonymous: "Bonjour, je suis un assistant d'intelligence artificielle et j'appelle pour une petite question.",
  },
  de: {
    named: (name) =>
      `Hallo, ich bin der KI-Assistent von ${name} und rufe mit einer kurzen Frage an.`,
    anonymous: "Hallo, ich bin ein KI-Assistent und rufe mit einer kurzen Frage an.",
  },
  it: {
    named: (name) =>
      `Buongiorno, sono l'assistente di intelligenza artificiale di ${name} e chiamo per conto suo con una breve domanda.`,
    anonymous: "Buongiorno, sono un assistente di intelligenza artificiale e chiamo con una breve domanda.",
  },
};

/** Every language a call can be conducted in (primary subtags). Region variants of these are accepted. */
export const SUPPORTED_CALL_LANGUAGES: readonly string[] = [DEFAULT_CALL_LANGUAGE, ...Object.keys(OPENERS)];

export function primaryLanguage(tag: string): string {
  return tag.split("-")[0] ?? tag;
}

export function isEnglish(tag: string): boolean {
  return primaryLanguage(tag) === DEFAULT_CALL_LANGUAGE;
}

/**
 * Canonical tag for a raw value, or null when it is malformed or has no opener template.
 * Case and separator are forgiven (`ES_co` → `es-CO`); blank means "not specified" and returns
 * null too, so callers decide the fallback.
 */
export function normalizeCallLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const [lang, region, ...rest] = raw.trim().replace(/_/g, "-").split("-");
  if (!lang || rest.length > 0) return null;
  const tag = region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
  if (!LANGUAGE_TAG_RE.test(tag)) return null;
  return SUPPORTED_CALL_LANGUAGES.includes(primaryLanguage(tag)) ? tag : null;
}

export function unsupportedLanguageMessage(raw: unknown): string {
  return (
    `Unsupported call language ${JSON.stringify(raw)}: pass a language tag such as "es" or "es-CO". ` +
    `Supported languages: ${SUPPORTED_CALL_LANGUAGES.join(", ")} (a region suffix like -CO or -MX is allowed).`
  );
}

let displayNames: Intl.DisplayNames | null = null;

/** English name of the tag's language ("es-CO" → "Spanish"), for prompt text. */
export function languageName(tag: string): string {
  const primary = primaryLanguage(tag);
  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    const name = displayNames.of(primary);
    if (name && name.toLowerCase() !== primary) return name;
  } catch {
    // Fall through to the tag itself.
  }
  return tag;
}

/** The localized disclosure opener for a non-English call. Throws for English or an unknown tag. */
export function localizedOpener(tag: string, name: string): string {
  const template = OPENERS[primaryLanguage(tag)];
  if (!template) throw new Error(`No opener template for call language ${tag}`);
  return name ? template.named(name) : template.anonymous;
}
