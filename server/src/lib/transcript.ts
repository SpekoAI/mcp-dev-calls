import { OUTCOME_MARKER } from "../constants.js";

// Speko transcripts come either bare (`[...]`) or wrapped; the turn list can sit
// under any of these keys. `entries` is the shape returned by CallDetail.transcript.
const TURN_LIST_KEYS = ["transcript", "turns", "entries", "messages"] as const;
const TURN_TEXT_KEYS = ["text", "content", "message"] as const;
// `source` FIRST: real Speko transcripts key the speaker as `source` (user|agent),
// not `role`. Without it, reply extraction matched nothing.
const TURN_ROLE_KEYS = ["source", "role", "speaker", "participant"] as const;
const AGENT_ROLES = new Set(["agent", "assistant", "ai", "bot", "system"]);

/** Yield every string found anywhere inside a transcript payload. */
export function* iterTranscriptStrings(node: unknown): Generator<string> {
  if (typeof node === "string") {
    yield node;
  } else if (Array.isArray(node)) {
    for (const item of node) yield* iterTranscriptStrings(item);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) yield* iterTranscriptStrings(value);
  }
}

/** Text after the LAST `OUTCOME:` marker in a transcript, or null. */
export function extractOutcome(transcript: unknown): string | null {
  let outcome: string | null = null;
  for (const text of iterTranscriptStrings(transcript)) {
    for (const line of text.split(/\r?\n/)) {
      const marker = line.lastIndexOf(OUTCOME_MARKER);
      if (marker === -1) continue;
      const candidate = line.slice(marker + OUTCOME_MARKER.length).trim();
      if (candidate) outcome = candidate;
    }
  }
  return outcome;
}

function findTurnList(transcript: unknown): unknown[] | null {
  if (Array.isArray(transcript)) return transcript;
  if (transcript && typeof transcript === "object") {
    const obj = transcript as Record<string, unknown>;
    for (const key of TURN_LIST_KEYS) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

// The B2 symptom: a receptionist speaks its end-call STRUCTURED output aloud — the tool verb
// (end_call / transfer_call), field labels, and verbalized punctuation ("farewell colon",
// "reason colon", "type colon"). Matches both the literal tokens and their spoken forms.
const CONTROL_TOKEN_RE =
  /\bend_call\b|\btransfer_call\b|\breturn_to_assistant\b|\bend underscore call\b|\b(?:farewell|reason|type)[\s,]+colon\b|\b(?:farewell|reason|type)\s*:/i;

/**
 * Detect a control/structured-token leak in the OTHER party's (non-agent) speech — the B2 symptom
 * where a receptionist speaks its end-call tool args / field labels / verbalized punctuation aloud.
 * Detection only: our package can flag it, but the fix is platform-side (the receptionist runtime).
 */
export function detectControlTokenLeak(transcript: unknown): boolean {
  const turns = findTurnList(transcript);
  if (!turns) return false;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const t = turn as Record<string, unknown>;
    let role = "";
    for (const key of TURN_ROLE_KEYS) {
      const value = t[key];
      if (typeof value === "string" && value) {
        role = value.toLowerCase();
        break;
      }
    }
    if (!role || AGENT_ROLES.has(role)) continue; // only the callee's (non-agent) turns
    for (const key of TURN_TEXT_KEYS) {
      const text = t[key];
      if (typeof text === "string" && CONTROL_TOKEN_RE.test(text)) return true;
    }
  }
  return false;
}

/** Concatenate non-agent (caller) turns from a transcript, best effort. */
export function extractReply(transcript: unknown): string | null {
  const turns = findTurnList(transcript);
  if (!turns) return null;
  const parts: string[] = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const t = turn as Record<string, unknown>;
    let role = "";
    for (const key of TURN_ROLE_KEYS) {
      const value = t[key];
      if (typeof value === "string" && value) {
        role = value.toLowerCase();
        break;
      }
    }
    if (!role || AGENT_ROLES.has(role)) continue;
    for (const key of TURN_TEXT_KEYS) {
      const text = t[key];
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
        break;
      }
    }
  }
  return parts.length ? parts.join(" ") : null;
}
