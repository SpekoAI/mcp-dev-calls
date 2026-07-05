import { BARE_OUTCOME_RE, OUTCOME_MARKER } from "../constants.js";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toolCallsForEntry(entry: Record<string, unknown>): unknown[] {
  if (Array.isArray(entry.toolCalls)) return entry.toolCalls;
  const metadata = asRecord(entry.metadata);
  return Array.isArray(metadata?.toolCalls) ? metadata.toolCalls : [];
}

function parseToolArgs(args: unknown): Record<string, unknown> | null {
  if (typeof args === "string") {
    try {
      return asRecord(JSON.parse(args));
    } catch {
      return null;
    }
  }
  return asRecord(args);
}

/** Reason carried by the worker's end_call tool args, or null when absent/unreadable. */
export function extractEndCallReason(transcript: unknown): string | null {
  const turns = findTurnList(transcript);
  if (!turns) return null;
  for (const turn of turns) {
    const entry = asRecord(turn);
    if (!entry) continue;
    for (const toolCall of toolCallsForEntry(entry)) {
      const call = asRecord(toolCall);
      if (call?.name !== "end_call") continue;
      const args = parseToolArgs(call.args);
      const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * Best available outcome for a call: a SUBSTANTIVE report outcome wins, else the transcript's
 * OUTCOME: marker, else null. Bare platform status words ("failed"/"completed"/...) in the
 * report are ignored unless the report says analysis completed; heuristic bare rows on a
 * connected call read as a misleading headline.
 *
 * The end_call reason (extractEndCallReason) is deliberately NOT folded in here: makeCall's
 * finalize keys its report-grace loop on this returning null ("no substantive outcome yet —
 * keep waiting"), and the reason is present from the first read, so folding it in would
 * short-circuit the grace and lock in a worse outcome than the report about to land. Call
 * sites compose it as their own LAST fallback once they are done waiting.
 */
export function bestOutcome(
  report: { outcome?: unknown; analysis_status?: unknown } | null | undefined,
  transcript: unknown,
): string | null {
  const reportOutcome = typeof report?.outcome === "string" ? report.outcome.trim() : "";
  const analysisCompleted = report?.analysis_status === "completed";
  const substantive = reportOutcome && (!BARE_OUTCOME_RE.test(reportOutcome) || analysisCompleted) ? reportOutcome : "";
  return substantive || extractOutcome(transcript);
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

function turnRole(turn: Record<string, unknown>): string {
  for (const key of TURN_ROLE_KEYS) {
    const value = turn[key];
    if (typeof value === "string" && value) return value.toLowerCase();
  }
  return "";
}

function turnText(turn: Record<string, unknown>): string | null {
  for (const key of TURN_TEXT_KEYS) {
    const text = turn[key];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

/**
 * Number of turns (any speaker) in a transcript's recognizable turn list, or null when no
 * list exists. Used by the poll loop's egress fast-path to tell "the call is over" (turn
 * count frozen) from "only the recording died" (turns still arriving).
 */
export function countTranscriptTurns(transcript: unknown): number | null {
  const turns = findTurnList(transcript);
  return turns ? turns.length : null;
}

/**
 * Role-attributed callee turns only. Returns null when the transcript has no recognizable
 * turn list, so callers can skip any safety scan rather than scanning unattributed text.
 */
export function calleeTurns(transcript: unknown): Array<{ text: string }> | null {
  const turns = findTurnList(transcript);
  if (!turns) return null;
  const out: Array<{ text: string }> = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const t = turn as Record<string, unknown>;
    const role = turnRole(t);
    if (!role || AGENT_ROLES.has(role)) continue;
    const text = turnText(t);
    if (text) out.push({ text });
  }
  return out;
}

/** Last agent-role turn text from a recognizable transcript list, or null. */
export function lastAgentTurnText(transcript: unknown): string | null {
  const turns = findTurnList(transcript);
  if (!turns) return null;
  let last: string | null = null;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const t = turn as Record<string, unknown>;
    const role = turnRole(t);
    if (!AGENT_ROLES.has(role)) continue;
    const text = turnText(t);
    if (text) last = text;
  }
  return last;
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
    const role = turnRole(t);
    if (!role || AGENT_ROLES.has(role)) continue; // only the callee's (non-agent) turns
    // Scan EVERY text-like field (not just the first non-empty one): a leak can sit in a
    // secondary field (e.g. `message`) while `text` holds clean speech.
    for (const key of TURN_TEXT_KEYS) {
      const text = t[key];
      if (typeof text === "string" && CONTROL_TOKEN_RE.test(text)) return true;
    }
  }
  return false;
}

/** Concatenate non-agent (caller) turns from a transcript, best effort. */
export function extractReply(transcript: unknown): string | null {
  const turns = calleeTurns(transcript);
  if (!turns) return null;
  const parts = turns.map((turn) => turn.text);
  return parts.length ? parts.join(" ") : null;
}
