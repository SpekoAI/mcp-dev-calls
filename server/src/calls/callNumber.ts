/**
 * Direct-dial path for PERSONAL calls (the `call_number` tool). Mints a short-lived
 * signed token for an arbitrary E.164 and runs the SAME make_call flow with exactly one
 * relaxation — mobiles are allowed (friends' phones). ON by default; setting
 * SPEKO_ALLOW_DIRECT_DIAL=0 disables this path entirely (businesses remain reachable
 * via lookup_business + make_call).
 *
 * Everything else still applies: the non-removable AI disclosure, abuse guardrails
 * (DNC, rate caps, after-hours confirmation gate), the no-sell/no-spam objective
 * screen, and the emergency/premium-number block. The allowAnyLineType flag is set
 * HERE (server-side), never from agent-supplied input.
 */
import type { AppConfig } from "../config.js";
import { RejectionError } from "../lib/errors.js";
import { dialBlockedReason, mintDialToken } from "../safety/dialToken.js";
import { offsetFromE164 } from "../safety/timezone.js";
import type { SpekoClient } from "../speko/client.js";
import type { CallSummary } from "../types.js";
import { makeCall } from "./makeCall.js";

export interface CallNumberInput {
  phoneNumber: string;
  objective: string;
  callerName: string;
  context?: string | null;
  /** Private steering for HOW the assistant behaves. NEVER spoken. */
  behavior?: string | null;
  greetFirst?: boolean | null;
  afterHoursConfirmation?: string | null;
  recipientName?: string | null;
  utcOffsetMinutes?: number | null;
  maxDurationSeconds?: number;
}

export interface CallNumberDeps {
  client: SpekoClient;
  cfg: AppConfig;
  bearerHash: string;
  sleep?: (ms: number) => Promise<void>;
}

export async function callNumber(input: CallNumberInput, deps: CallNumberDeps): Promise<CallSummary> {
  if (!deps.cfg.allowDirectDial) {
    throw new RejectionError(
      "Direct dialing has been turned off on this deployment (SPEKO_ALLOW_DIRECT_DIAL is set to off), so " +
        "call_number is disabled and cannot place this call. (Direct dialing is on by default.)",
      "To call a business, use lookup_business + make_call instead. To use call_number, unset " +
        "SPEKO_ALLOW_DIRECT_DIAL (or set it to 1) in the MCP's env and restart, then retry.",
    );
  }

  // Normalize formatting from web-found numbers ("+1 415-285-7117" / "+1 (415) 285-7117" ->
  // "+14152857117"); the E.164 check below still rejects anything missing a leading + / country
  // code. Mirrors the agent-provided path in lookup/index.ts so all dial paths normalize alike.
  const e164 = typeof input.phoneNumber === "string" ? input.phoneNumber.replace(/[^\d+]/g, "") : "";
  const blocked = dialBlockedReason(e164);
  if (blocked) {
    throw new RejectionError(blocked, "Pass a valid E.164 number (e.g. +77011234567) that you have consent to call.");
  }

  // Destination offset: explicit override wins; else derive from the number (+7 → Asia/Almaty,
  // etc.). null → make_call's after-hours gate requires confirmation unless trusted.
  const offset = typeof input.utcOffsetMinutes === "number" ? input.utcOffsetMinutes : offsetFromE164(e164);

  const token = mintDialToken({
    e164,
    lineType: "personal", // cosmetic; the business-line check is skipped for the direct path
    businessName: (input.recipientName && input.recipientName.trim()) || "your contact",
    utcOffsetMinutes: offset,
    bearerHash: deps.bearerHash,
    secret: deps.cfg.dialTokenSecret,
  });

  return makeCall(
    {
      dialToken: token,
      objective: input.objective,
      callerName: input.callerName,
      context: input.context ?? null,
      behavior: input.behavior ?? null,
      greetFirst: input.greetFirst ?? null,
      afterHoursConfirmation: input.afterHoursConfirmation ?? null,
      maxDurationSeconds: input.maxDurationSeconds,
    },
    {
      client: deps.client,
      cfg: deps.cfg,
      bearerHash: deps.bearerHash,
      sleep: deps.sleep,
      allowAnyLineType: true, // set server-side only, behind cfg.allowDirectDial
    },
  );
}
