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
  /** Deep link to the call in the Speko dashboard (`${dashboardBaseUrl}/sessions/{call_id}`). */
  dashboard_url?: string;
  /**
   * True when the OTHER party (e.g. a platform receptionist agent) spoke internal control tokens
   * aloud — end_call/field-labels/verbalized punctuation (B2). Detection only; the real fix is
   * platform-side. Lets this report flag a leak instead of presenting the call as clean.
   */
  receptionist_control_token_leak?: boolean;
  /** Full message supplied to call_me; retained even when spoken output is duration-limited. */
  message?: string;
  /** Explicitly data-labeled owner speech for call_me converse results. */
  owner_reply?: string | null;
  /** Present only on answered call_me converse calls. */
  confirmation?: "confirmed" | "corrected" | "unconfirmed";
  /** Best deterministic extraction from the final read-back frame, if one was observed. */
  final_instruction?: string | null;
  /** Actionable continuation for nonblocking/incomplete owner calls. */
  next_step?: string;
}

/**
 * Loose subset of `GET /v1/sessions/{id}` — the authoritative record of whether a
 * real telephony leg was ever created. `phoneCall.callControlId` is null and there
 * are no carrier usage rows when the SIP leg never formed (no ring).
 */
export interface SessionDetail {
  status?: string;
  /**
   * Stamped when the platform tears the session down — measured 0.5s apart from the LiveKit
   * `room_finished` event on live MCP calls. These calls dial out via LiveKit SIP, so the
   * Telnyx `call.hangup` webhook never fires for them and nothing stamps endedAt early
   * (telnyxCallControlId exists only on inbound). A terminal signal kept as cheap redundancy,
   * NOT an early one: the early phone-leg-death signal is the source-closed `egress_ended`
   * event, and the agent-initiated-hangup signal is `call.end_tool.completed`.
   */
  endedAt?: string | null;
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
  /** Whether inbound calls to this number will be answered (setup.inboundReady). */
  inbound_ready: boolean;
  /** Whether a persisted agent is bound to this number (PhoneNumberRow.agentId != null). */
  agent_attached: boolean;
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
  call_me: { available: boolean; note: string; owner_phone_last4?: string; client_profile?: string };
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
  greetFirst?: boolean | null;
  afterHoursConfirmation?: string | null;
  maxDurationSeconds?: number;
  /**
   * false returns immediately after the dial is placed (with a call_id to poll via get_call)
   * instead of blocking until the call ends. Every pre-dial rail still runs; only the wait
   * for the call's outcome is skipped. Default/omitted = true (blocking).
   */
  wait?: boolean | null;
}

export interface CallMeInput {
  message: string;
  mode: "notify" | "converse";
  context?: string | null;
  afterHoursConfirmation?: string | null;
  maxDurationSeconds?: number;
  wait?: boolean;
}
