import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

const schema = z.object({
  dial_token: z
    .string()
    .describe("Signed dial token minted by lookup_business. Raw phone numbers are rejected."),
  objective: z
    .string()
    .describe(
      "Single transactional request in plain words - the ask, not a script (e.g. 'Book a table " +
        "for 4 at 8pm tonight under Bek'). The server composes the spoken opening line from it " +
        "and always prepends the AI disclosure, so never write greetings or self-introductions " +
        "('Hi! I'm calling to...') - they garble the opener. Do NOT put behavior/steering " +
        "instructions here (they can end up spoken to the callee); use `behavior` for those.",
    ),
  caller_name: z
    .string()
    .describe("Name of the human the call is on behalf of (1-80 chars); spoken in the AI-disclosure opening line."),
  context: z.string().optional().describe("Optional extra task context (party size, dates, order numbers)."),
  behavior: z
    .string()
    .optional()
    .describe(
      "PRIVATE instructions for HOW the assistant should behave — NEVER spoken aloud (e.g. 'wait for " +
        "them to say hello before you speak', 'be extra concise', 'if they offer takeout, decline'). " +
        "Steering/meta goes here; the ask itself goes in `objective`.",
    ),
  after_hours_confirmation: z
    .string()
    .optional()
    .describe(
      "Set ONLY after your human explicitly confirms placing this call outside 08:00-21:00 destination-local time " +
        "(or when the timezone is unverified) - pass the human's own words. Never set it on your own. " +
        "By setting it you confirm the callee has consented to be called.",
    ),
  max_duration_seconds: z
    .number()
    .int()
    .optional()
    .describe("Max seconds to wait for the call to finish; clamped to 30-300."),
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
    return (
      reason ??
      "The call was NOT placed: this Speko deployment has no outbound caller-ID/SIP configured. " +
        "Run check_call_readiness, configure a caller ID, then retry make_call."
    );
  }
  if (status === "not_connected") {
    // The server reason now differentiates a trunk/caller-ID dial failure from a destination-side
    // no-answer (E1) — render it as-is instead of unconditionally blaming the outbound trunk.
    return reason ?? "The call did not connect — the other party was never heard.";
  }
  if (status === "timeout") {
    return `Reached the wait limit; the call may still be in progress${callId ? ` (call_id '${callId}')` : ""}. Check again with get_call.`;
  }
  if (connected && !answered) {
    return reason ?? `The call connected but no one responded${callId ? ` (call_id '${callId}')` : ""}.`;
  }
  if (outcome) return outcome;
  return `Call ${callId ?? ""} finished with status '${status}' and no OUTCOME line.`.trim();
}

export default class MakeCallTool extends MCPTool {
  name = "make_call";
  description =
    "Place a disclosed, objective-scoped phone call authorized by a dial_token from lookup_business. " +
    "Stays open until the call finishes and returns the OUTCOME line plus the transcript. Every call " +
    "opens with the non-removable AI disclosure; the no-sell/no-spam + harassment + impersonation screens, " +
    "per-number rate caps, the local do-not-call list, and an after-hours confirmation gate " +
    "(08:00-21:00 destination local; late calls need your human's explicit OK) all apply server-side. " +
    'If alternatives are acceptable (a different time/size/substitute), say so in the objective (e.g. "book 8pm, or anything between 7:30 and 9"), otherwise the assistant only reports counter-offers back and never accepts them.';
  schema = schema;
  override annotations = {
    title: "Make Call",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  async execute(input: z.infer<typeof schema>): Promise<Record<string, unknown>> {
    const maxWait = clamp(input.max_duration_seconds ?? MAX_WAIT, MIN_WAIT, MAX_WAIT);
    const client = getServerClient();

    // Heartbeat so the call feels alive in the terminal. The authoritative status lives
    // server-side; here we surface elapsed time from the wall clock — counting ticks drifts
    // behind reality whenever the event loop is busy (skipped/late intervals), understating
    // the progress %. Clamp the progress value to the cap so it never renders past 100%.
    const startedAtMs = Date.now();
    // Immediate progress so the terminal isn't silent for the first ~5s while the call places + rings.
    void this.reportProgress(0, maxWait, "Placing the call…").catch(() => {});
    const timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAtMs) / 1000);
      void this.reportProgress(Math.min(elapsed, maxWait), maxWait, `Call in progress — ${elapsed}s elapsed`).catch(
        () => {},
      );
    }, HEARTBEAT_MS);

    try {
      const summary = (await client.post(
        "/call",
        {
          dial_token: input.dial_token,
          objective: input.objective,
          caller_name: input.caller_name,
          context: input.context,
          behavior: input.behavior,
          after_hours_confirmation: input.after_hours_confirmation,
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
