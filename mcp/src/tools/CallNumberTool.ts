import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

const schema = z.object({
  phone_number: z
    .string()
    .describe("Number to call, E.164 (e.g. +77011234567). A real number the user has consent to call."),
  objective: z
    .string()
    .describe("What to say / accomplish, e.g. 'Tell Karim that Amirlan says happy birthday and misses him.'"),
  caller_name: z
    .string()
    .describe("Name of the human the call is on behalf of (1-80 chars); spoken in the AI-disclosure opening."),
  recipient_name: z.string().optional().describe("Who you're calling, used in the greeting (e.g. 'Karim')."),
  context: z.string().optional().describe("Optional extra context for the message."),
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
    return (
      (reason ?? "The call did not connect — no telephony leg reached the carrier, so the phone never rang.") +
      " Re-dialing will not help until the deployment's outbound trunk is fixed."
    );
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
    "Place a disclosed PERSONAL call to a specific phone number (e.g. a friend) — NOT a business lookup. " +
    "Requires the operator to have opted in (SPEKO_ALLOW_DIRECT_DIAL=1); otherwise it returns how to enable it. " +
    "Every call opens with the non-removable AI disclosure, and quiet hours + the no-sell/no-spam screen still " +
    "apply (mobiles are allowed here, unlike make_call). Use lookup_business + make_call for businesses; use this " +
    "only for a number the user explicitly provides and has consent to call.";
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
