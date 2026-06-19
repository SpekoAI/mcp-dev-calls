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
import type { SessionDetail } from "../types.js";

const DEFAULT_API_BASE = "https://api.speko.dev";

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
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(cfg: AppConfig) {
    this.apiKey = cfg.speko.apiKey;
    this.baseUrl = (cfg.speko.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
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

  /**
   * Raw `GET /v1/sessions/{id}` — the authoritative telephony record. The SDK's
   * `calls.get` (CallDetail) omits `phoneCall.callControlId` and the carrier usage
   * rows we need to prove a real outbound leg formed, so we read the session here.
   */
  async getSession(sessionId: string): Promise<SessionDetail> {
    const resp = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { accept: "application/json", authorization: `Bearer ${this.apiKey}` },
    });
    if (!resp.ok) {
      throw new SpekoApiError(`GET /v1/sessions/${sessionId} failed`, resp.status, "session_fetch_failed");
    }
    return (await resp.json()) as SessionDetail;
  }
}
