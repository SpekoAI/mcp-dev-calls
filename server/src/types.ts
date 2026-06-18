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
  source: "google_places" | "demo";
}

export interface CallSummary {
  status: string;
  call_id: string | null;
  duration_seconds: number;
  outcome: string | null;
  transcript: unknown;
  transcript_error?: string;
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
  maxDurationSeconds?: number;
}
