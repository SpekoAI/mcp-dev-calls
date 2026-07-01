import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

const schema = z.object({
  phone_number: z
    .string()
    .describe(
      "Number to call in full international E.164 — leading + and country code (e.g. +14152857117, " +
        "NOT (415) 285-7117). A number the user asked you to call or explicitly provided.",
    ),
  objective: z
    .string()
    .describe(
      "What to say / accomplish — READ ALOUD VERBATIM after the AI disclosure (e.g. 'Tell Sam that " +
        "John says happy birthday and misses him.'). Put ONLY spoken content here; behavior/steering " +
        "instructions go in `behavior` (otherwise they get spoken to the callee).",
    ),
  caller_name: z
    .string()
    .describe("Name of the human the call is on behalf of (1-80 chars); spoken in the AI-disclosure opening."),
  recipient_name: z.string().optional().describe("Who you're calling, used in the greeting (e.g. 'Sam')."),
  context: z.string().optional().describe("Optional extra context for the message."),
  behavior: z
    .string()
    .optional()
    .describe(
      "PRIVATE instructions for HOW the assistant should behave — NEVER spoken aloud (e.g. 'wait for " +
        "them to say hello before you speak', 'keep it brief'). Steering/meta here; spoken content in `objective`.",
    ),
  utc_offset_minutes: z
    .number()
    .int()
    .optional()
    .describe("Callee UTC offset in minutes for quiet hours (e.g. 300 = UTC+5). Auto-derived from the number; pass it only if a call is blocked for unknown timezone."),
  max_duration_seconds: z.number().int().optional().describe("Max seconds to wait for the call to finish; clamped 30-300."),
});

const MIN_WAIT = 30;
const MAX_WAIT = 300;
const HEARTBEAT_MS = 5000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

function summarize(s: Record<string, unknown>): string {
  const status = typeof s.status === "string" ? s.status : "unknown";
  const callId = typeof s.call_id === "string" ? s.call_id : null;
  const outcome = typeof s.outcome === "string" ? s.outcome : null;
  const reason = typeof s.reason === "string" ? s.reason : null;
  const connected = s.connected === true;
  const answered = s.answered === true;

  if (status === "not_placed") {
    return reason ?? "The call was NOT placed: no outbound caller-ID/SIP is configured for this deployment.";
  }
  if (status === "not_connected") {
    // Server reason now distinguishes trunk/caller-ID dial failure from a destination no-answer (E1).
    return reason ?? "The call did not connect — the other party was never heard.";
  }
  if (status === "timeout") {
    return `Reached the wait limit; the call may still be in progress${callId ? ` (call_id '${callId}')` : ""}.`;
  }
  if (connected && !answered) {
    return reason ?? `The call connected but no one responded${callId ? ` (call_id '${callId}')` : ""}.`;
  }
  if (outcome) return outcome;
  return `Call ${callId ?? ""} finished with status '${status}'.`.trim();
}

export default class CallNumberTool extends MCPTool {
  name = "call_number";
  description =
    "Place a disclosed call to a phone number you HAVE or FOUND (e.g. via web search) — the DEFAULT path for " +
    "calling any business or person. Works with just the user's Speko key, no extra setup. Every call opens " +
    "with the non-removable AI disclosure; quiet hours and the no-sell/no-spam screen still apply (mobiles " +
    "allowed). lookup_business + make_call is the OPTIONAL verified-directory path (it needs the server's " +
    "carrier/directory keys); prefer call_number when you already have or found the number. Only dial a number " +
    "the user asked you to call or explicitly provided — never one you invented.";
  schema = schema;
  override annotations = {
    title: "Call a Number",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  async execute(input: z.infer<typeof schema>): Promise<Record<string, unknown>> {
    const maxWait = clamp(input.max_duration_seconds ?? MAX_WAIT, MIN_WAIT, MAX_WAIT);
    const client = getServerClient();

    let elapsed = 0;
    // Immediate progress so the terminal isn't silent for the first ~5s while the call places + rings.
    void this.reportProgress(0, maxWait, "Placing the call…").catch(() => {});
    const timer = setInterval(() => {
      elapsed += HEARTBEAT_MS / 1000;
      void this.reportProgress(elapsed, maxWait, `Call in progress — ${elapsed}s elapsed`).catch(() => {});
    }, HEARTBEAT_MS);

    try {
      const summary = (await client.post(
        "/call-number",
        {
          phone_number: input.phone_number,
          objective: input.objective,
          caller_name: input.caller_name,
          recipient_name: input.recipient_name,
          context: input.context,
          behavior: input.behavior,
          utc_offset_minutes: input.utc_offset_minutes,
          max_duration_seconds: input.max_duration_seconds,
        },
        { timeoutMs: (maxWait + 30) * 1000, signal: this.abortSignal },
      )) as Record<string, unknown>;

      return { summary: summarize(summary), ...summary };
    } finally {
      clearInterval(timer);
    }
  }
}
