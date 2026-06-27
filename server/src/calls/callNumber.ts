/**
 * Direct-dial path for PERSONAL calls (the `call_number` tool). Mints a short-lived
 * signed token for an arbitrary E.164 and runs the SAME make_call flow with exactly one
 * relaxation — mobiles are allowed (friends' phones). ON by default; a deployment can
 * restrict to business lines only with SPEKO_ALLOW_DIRECT_DIAL=0.
 *
 * Everything else still applies: the non-removable AI disclosure, quiet hours
 * (08:00–21:00 destination-local, fail-closed), the no-sell/no-spam objective screen,
 * and the emergency/premium-number block. The allowAnyLineType flag is set HERE
 * (server-side), never from agent-supplied input.
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

  const e164 = typeof input.phoneNumber === "string" ? input.phoneNumber.trim() : "";
  const blocked = dialBlockedReason(e164);
  if (blocked) {
    throw new RejectionError(blocked, "Pass a valid E.164 number (e.g. +77011234567) that you have consent to call.");
  }

  // Quiet-hours offset: explicit override wins; else derive from the number (+7 → Asia/Almaty,
  // etc.). null → make_call's quiet-hours rail fails closed and blocks.
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
