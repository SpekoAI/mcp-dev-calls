import type { AppConfig } from "../config.js";
import { RejectionError } from "../lib/errors.js";
import { normalizeNanpOwnerPhone, reserveOwnerVerificationCall } from "../owner/state.js";
import { sanitizeName } from "../safety/prompt.js";
import type { SpekoClient } from "../speko/client.js";
import type { CallSummary } from "../types.js";
import { callNumber } from "./callNumber.js";

export interface OwnerVerificationCallInput {
  ownerPhone: string;
  ownerName: string;
  verificationCode: string;
  maxDurationSeconds?: number;
}

export interface OwnerVerificationCallDeps {
  client: SpekoClient;
  cfg: AppConfig;
  bearerHash: string;
  sleep?: (ms: number) => Promise<void>;
}

export async function placeOwnerVerificationCall(
  input: OwnerVerificationCallInput,
  deps: OwnerVerificationCallDeps,
): Promise<CallSummary> {
  const phone = normalizeNanpOwnerPhone(input.ownerPhone);
  if (!phone) {
    throw new RejectionError(
      "Owner verification supports NANP numbers only in +1XXXXXXXXXX format.",
      "Re-run `speko me verify` with a NANP owner number.",
    );
  }
  const owner = sanitizeName(input.ownerName);
  if (!owner) {
    throw new RejectionError("Owner name is required for the AI disclosure.", "Provide the owner's real name and retry.");
  }
  if (!/^\d{6}$/.test(input.verificationCode)) {
    throw new Error("Owner verification code must contain exactly six digits.");
  }

  const spokenCode = input.verificationCode.split("").join(" ");
  const firstMessage =
    `Hi, I'm ${owner}'s AI assistant helping verify ${owner}'s phone for Speko. ` +
    `Your one-time verification code is ${spokenCode}. Again, ${spokenCode}.`;

  return callNumber(
    {
      phoneNumber: phone,
      objective: "Confirm possession of the owner's phone for Speko setup.",
      callerName: owner,
      recipientName: owner,
      maxDurationSeconds: input.maxDurationSeconds ?? 60,
    },
    {
      client: deps.client,
      cfg: deps.cfg,
      bearerHash: deps.bearerHash,
      sleep: deps.sleep,
      ownerDial: true,
      forceFullRails: true,
      // This one exception is scoped to a user-initiated OTP call. It does not make later
      // call_me traffic trusted; ordinary owner calls still require after-hours confirmation.
      skipAfterHoursGate: true,
      firstMessageOverride: firstMessage,
      systemPromptOverride: (endCallTool) =>
        [
          `You are ${owner}'s AI assistant completing a phone-possession check for ${owner}.`,
          `The one-time six-digit code ${spokenCode} was already spoken twice in the first message.`,
          "If asked, repeat only that code once. Do not discuss any other topic and do not ask for information.",
          endCallTool
            ? "Then call end_call with a short goodbye as its farewell. Do not speak a second goodbye."
            : "Then say one short goodbye and remain silent.",
        ].join("\n"),
      metadataSource: "speko-mcp-calls/owner-verification",
      metadataExtra: { owner_verification: true },
      beforeDial: () => {
        try {
          reserveOwnerVerificationCall(phone, { dir: deps.cfg.ownerStateDir });
        } catch (error) {
          throw new RejectionError(
            (error as Error).message,
            "Wait for the 24-hour verification-call window to reset; do not bypass the cap.",
          );
        }
      },
    },
  );
}
