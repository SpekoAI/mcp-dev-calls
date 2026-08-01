import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";
import { clampCallWait, startCallProgress } from "./_shared/callProgress.js";
import { summarizeCallResult } from "./_shared/callSummary.js";

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
      "What to accomplish, in plain words - the ask, not a script (e.g. 'Tell Sam that John says " +
        "happy birthday and misses him'). The server composes the spoken opening line and always " +
        "includes the AI disclosure automatically, so never write greetings or self-introductions " +
        "('Hi! I'm calling to...'). Behavior/steering instructions go in `behavior` (in the " +
        "objective they can end up spoken to the callee).",
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
        "them to say hello before you speak', 'keep it brief'). Steering/meta here; the ask itself in `objective`. " +
        "Opener timing is NOT controlled here — use greet_first:false to wait for the callee to speak first.",
    ),
  greet_first: z
    .boolean()
    .optional()
    .describe(
      "Speak the opener immediately when the call is answered (default true). Set false to hold the opener until " +
        "the callee speaks first (e.g. 'wait for them to say hello') — behavior text alone CANNOT change opener timing.",
    ),
  utc_offset_minutes: z
    .number()
    .int()
    .optional()
    .describe(
      "Callee UTC offset in minutes for the after-hours gate (e.g. 300 = UTC+5). Auto-derived from the " +
        "number; pass it only when you know the destination timezone. Unknown timezone asks for " +
        "after_hours_confirmation instead of blocking.",
    ),
  after_hours_confirmation: z
    .string()
    .optional()
    .describe(
      "Set ONLY after your human explicitly confirms placing this call outside 08:00-21:00 destination-local time " +
        "(or when the timezone is unverified) - pass the human's own words. Never set it on your own. " +
        "By setting it you confirm the callee has consented to be called.",
    ),
  max_duration_seconds: z.number().int().optional().describe("Max seconds to wait for the call to finish; clamped 30-300."),
});

export default class CallNumberTool extends MCPTool {
  name = "call_number";
  description =
    "Place a disclosed call to a phone number you HAVE or FOUND (e.g. via web search) — the DEFAULT path for " +
    "calling any business or person. Works with just the user's Speko key, no extra setup. Every call opens " +
    "with the non-removable AI disclosure; the no-sell/no-spam + harassment + impersonation screens, " +
    "per-number rate caps, the local do-not-call list, and an after-hours confirmation gate " +
    "(08:00-21:00 destination local; late calls need your human's explicit OK) still apply (mobiles allowed). " +
    "lookup_business + make_call is the OPTIONAL verified-directory path (it needs the server's " +
    "carrier/directory keys); prefer call_number when you already have or found the number. Only dial a number " +
    "the user asked you to call or explicitly provided — never one you invented. " +
    'If alternatives are acceptable (a different time/size/substitute), say so in the objective (e.g. "book 8pm, or anything between 7:30 and 9"), otherwise the assistant only reports counter-offers back and never accepts them.';
  schema = schema;
  override annotations = {
    title: "Call a Number",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  async execute(input: z.infer<typeof schema>): Promise<Record<string, unknown>> {
    const maxWait = clampCallWait(input.max_duration_seconds);
    const client = getServerClient();
    const stopProgress = startCallProgress(
      (progress, total, message) => this.reportProgress(progress, total, message),
      maxWait,
    );

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
          greet_first: input.greet_first,
          utc_offset_minutes: input.utc_offset_minutes,
          after_hours_confirmation: input.after_hours_confirmation,
          max_duration_seconds: input.max_duration_seconds,
        },
        { timeoutMs: (maxWait + 30) * 1000, signal: this.abortSignal },
      )) as Record<string, unknown>;

      return { summary: summarizeCallResult(summary, { retryTool: "call_number" }), ...summary };
    } finally {
      stopProgress();
    }
  }
}
