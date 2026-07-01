/** Wire types shared between the demo server's modules and the MCP tier. */

export interface BusinessCandidate {
  name: string;
  address: string;
  phone: string;
  line_type: string | null;
  allowed: boolean;
  blocked_reason: string | null;
  dial_token: string | null;
  utc_offset_minutes: number | null;
}

export interface LookupResult {
  candidates: BusinessCandidate[];
  source: "google_places" | "demo" | "agent_provided";
}

export interface CallSummary {
  status: string;
  call_id: string | null;
  duration_seconds: number;
  /** True only when a real outbound telephony leg reached the carrier (the phone actually rang). */
  connected: boolean;
  /** True only when the remote party actually spoke (a non-agent transcript turn exists). */
  answered: boolean;
  /** Caller-ID the call dialed from (E.164), as resolved/returned by the platform. */
  caller_id: string | null;
  /** Destination the call dialed to (E.164). */
  dialed_number: string | null;
  outcome: string | null;
  transcript: unknown;
  transcript_error?: string;
  /** Human-readable explanation when the call did not connect / was not placed. */
  reason?: string;
}

/**
 * Loose subset of `GET /v1/sessions/{id}` — the authoritative record of whether a
 * real telephony leg was ever created. `phoneCall.callControlId` is null and there
 * are no carrier usage rows when the SIP leg never formed (no ring).
 */
export interface SessionDetail {
  status?: string;
  durationSeconds?: number;
  phoneCall?: { callControlId?: string | null; phoneNumberId?: string | null } | null;
  usage?: Array<{ provider?: string; metric?: string; quantity?: number; cost?: number }>;
}

export interface OwnedNumber {
  e164: string | null;
  direction: string | null;
  source: string | null;
  setup_status: string | null;
  outbound_ready: boolean;
  issues: string[];
}

export interface ReadinessReport {
  auth: { ok: boolean; error: string | null };
  credits: { balance_usd: number | null; minimum_usd: number; sufficient: boolean; error: string | null };
  outbound: {
    owned_numbers: OwnedNumber[];
    any_outbound_ready: boolean;
    server_default_possible: boolean;
    error: string | null;
  };
  call_me: { available: boolean; note: string };
  next_steps: string[];
  headline: string;
}

export interface MakeCallInput {
  dialToken: string;
  objective: string;
  callerName: string;
  context?: string | null;
  /** Private steering for HOW the assistant behaves (pacing, when to speak). NEVER spoken. */
  behavior?: string | null;
  maxDurationSeconds?: number;
}
