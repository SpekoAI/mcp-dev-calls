import type { AppConfig, ClientProfile } from "../config.js";
import { AppError, RejectionError } from "../lib/errors.js";
import { readOwnerProfile } from "../owner/state.js";
import type { SpekoClient } from "../speko/client.js";
import type { CallMeInput, CallSummary } from "../types.js";
import { callNumber } from "./callNumber.js";
import { buildCallMeFirstMessage, buildCallMeSystemPrompt } from "./callMePrompt.js";
import {
  clearOwnerBusy,
  decorateCallMeSummary,
  getOwnerBusy,
  isCallMeTerminal,
  setOwnerBusy,
} from "./callMeResult.js";
import { describeCall } from "./getCall.js";

const DEFAULT_DURATION_SECONDS = 180;
const MIN_DURATION_SECONDS = 30;
const MAX_DURATION_SECONDS = 300;
const GEMINI_MAX_DURATION_SECONDS = 240;
const BUSY_UNKNOWN_TTL_MS = (MAX_DURATION_SECONDS + 60) * 1000;
const POLL_ONLY_PROFILES = new Set<ClientProfile>(["cursor", "windsurf", "safe-default"]);

export interface CallMeDeps {
  client: SpekoClient;
  cfg: AppConfig;
  bearerHash: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface EffectiveCallMePolicy {
  wait: boolean;
  maxDurationSeconds: number;
  profile: ClientProfile;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

export function effectiveCallMePolicy(input: CallMeInput, cfg: AppConfig): EffectiveCallMePolicy {
  const ceiling = cfg.clientProfile === "gemini" ? GEMINI_MAX_DURATION_SECONDS : MAX_DURATION_SECONDS;
  return {
    wait: POLL_ONLY_PROFILES.has(cfg.clientProfile) ? false : input.wait !== false,
    maxDurationSeconds: clamp(input.maxDurationSeconds ?? DEFAULT_DURATION_SECONDS, MIN_DURATION_SECONDS, ceiling),
    profile: cfg.clientProfile,
  };
}

async function rejectIfOwnerBusy(ownerPhone: string, deps: CallMeDeps): Promise<void> {
  const busy = getOwnerBusy(ownerPhone);
  if (!busy) return;
  // The TTL is only an escape hatch for a dial that failed before returning a call ID. Once a
  // call ID exists, its authoritative terminal state wins even if the nominal duration elapsed:
  // platform teardown can lag, and expiring a known live call would allow a second ring.
  if (!busy.callId && busy.expiresAt <= Date.now()) {
    clearOwnerBusy(ownerPhone);
    return;
  }
  if (busy.callId) {
    try {
      const current = await describeCall(busy.callId, deps.client, deps.cfg.dashboardBaseUrl);
      if (isCallMeTerminal(current.status)) {
        clearOwnerBusy(ownerPhone);
        return;
      }
    } catch {
      // Fail closed while an existing call's state cannot be read.
    }
  }
  throw new RejectionError(
    "owner_busy: an owner call is already active in this MCP process, so no second call was placed.",
    busy.callId
      ? `Wait for get_call('${busy.callId}') to finish, then invoke call_me again only if a new call is still needed.`
      : "Wait for the current owner call to finish before invoking call_me again.",
  );
}

function validateInput(input: CallMeInput): void {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message || message.length > 2_000) {
    throw new RejectionError("call_me message must contain 1-2000 characters.", "Shorten the message and retry.");
  }
  if (input.context != null && input.context.length > 500) {
    throw new RejectionError("call_me context must be at most 500 characters.", "Shorten the context and retry.");
  }
}

export async function callMe(input: CallMeInput, deps: CallMeDeps): Promise<CallSummary> {
  validateInput(input);
  if (deps.cfg.callMeDisabled) {
    throw new RejectionError(
      "call_me is disabled on this install (SPEKO_CALLME_DISABLED is enabled).",
      "Unset SPEKO_CALLME_DISABLED and restart the MCP only after the owner wants calls enabled.",
    );
  }
  const owner = readOwnerProfile(deps.cfg.ownerStateDir);
  if (!owner) {
    throw new RejectionError(
      "call_me is not set up: no verified owner phone.",
      "Run `speko me verify` (or `npx @spekoai/mcp-calls init`) to verify your number, then retry.",
    );
  }

  await rejectIfOwnerBusy(owner.owner_phone, deps);
  const policy = effectiveCallMePolicy(input, deps.cfg);
  setOwnerBusy(owner.owner_phone, { callId: null, expiresAt: Date.now() + BUSY_UNKNOWN_TTL_MS });

  try {
    const summary = await callNumber(
      {
        phoneNumber: owner.owner_phone,
        // Keep the complete owner message inside the existing content screens while ensuring a
        // short valid message (for example, "Done") is not rejected by the business objective's
        // eight-character minimum. Prompt overrides below still control exactly what is spoken.
        objective: `Deliver this owner message: ${input.message.trim()}`,
        callerName: owner.owner_name,
        recipientName: owner.owner_name,
        context: input.context ?? null,
        afterHoursConfirmation: input.afterHoursConfirmation ?? null,
        maxDurationSeconds: policy.maxDurationSeconds,
      },
      {
        client: deps.client,
        cfg: deps.cfg,
        bearerHash: deps.bearerHash,
        sleep: deps.sleep,
        ownerDial: true,
        forceFullRails: true,
        firstMessageOverride: buildCallMeFirstMessage({
          ownerName: owner.owner_name,
          message: input.message,
          mode: input.mode,
          maxDurationSeconds: policy.maxDurationSeconds,
        }),
        systemPromptOverride: (endCallTool) =>
          buildCallMeSystemPrompt({
            ownerName: owner.owner_name,
            message: input.message,
            context: input.context,
            mode: input.mode,
            endCallTool,
          }),
        metadataSource: "speko-mcp-calls/call_me",
        metadataExtra: {
          call_me_mode: input.mode,
          call_me_message: input.message,
          call_me_context: input.context ?? null,
          call_me_instance_id: owner.instance_id,
          client_profile: policy.profile,
        },
        returnAfterDial: !policy.wait,
      },
    );

    if (summary.call_id && !isCallMeTerminal(summary.status)) {
      setOwnerBusy(owner.owner_phone, {
        callId: summary.call_id,
        expiresAt: Date.now() + BUSY_UNKNOWN_TTL_MS,
      });
    } else {
      clearOwnerBusy(owner.owner_phone);
    }
    return decorateCallMeSummary(summary, {
      mode: input.mode,
      message: input.message,
      context: input.context ?? null,
      instanceId: owner.instance_id,
    });
  } catch (error) {
    const status = error instanceof AppError ? error.statusCode : 500;
    if ([400, 401, 402, 403, 404, 422].includes(status)) clearOwnerBusy(owner.owner_phone);
    throw error;
  }
}
