/**
 * Thin wrapper over the official @spekoai/sdk. This is the ONLY module that talks
 * to api.speko.dev, and it does so with the server-side SPEKO_API_KEY — never a
 * credential held by the MCP/npx tier. The SDK handles dial, call polling, credit
 * balance, and phone-number listing.
 */
import { Speko, SpekoApiError, SpekoAuthError, SpekoRateLimitError } from "@spekoai/sdk";
import type {
  CallDetail,
  OrganizationBalance,
  PhoneNumberRow,
  VoiceDialParams,
  VoiceDialResult,
} from "@spekoai/sdk";
import type { AppConfig } from "../config.js";

export { SpekoApiError, SpekoAuthError, SpekoRateLimitError };

/** True for errors that mean "the configured Speko key is bad", not "try again". */
export function isAuthFailure(e: unknown): boolean {
  return (
    e instanceof SpekoAuthError ||
    (e instanceof SpekoApiError && (e.status === 401 || e.status === 403))
  );
}

export class SpekoClient {
  private readonly speko: Speko;

  constructor(cfg: AppConfig) {
    this.speko = new Speko({
      apiKey: cfg.speko.apiKey,
      ...(cfg.speko.baseUrl ? { baseUrl: cfg.speko.baseUrl } : {}),
      timeout: 30_000,
    });
  }

  dial(params: VoiceDialParams): Promise<VoiceDialResult> {
    return this.speko.voice.dial(params);
  }

  getCall(callId: string): Promise<CallDetail> {
    return this.speko.calls.get(callId);
  }

  getBalance(): Promise<OrganizationBalance> {
    return this.speko.credits.getBalance();
  }

  listPhoneNumbers(): Promise<PhoneNumberRow[]> {
    return this.speko.phoneNumbers.list();
  }
}
