/**
 * check_call_readiness backing logic. Read-only: derives auth + credit + outbound
 * caller-ID readiness from the SDK's credit balance and phone-number list. call_me
 * is reported as a deferred v2 feature (the platform exposes no verified personal
 * phone today).
 */
import { CHECK_READINESS_NEXT_STEP, MIN_CALL_BALANCE_USD } from "../constants.js";
import { isAuthFailure, type SpekoClient } from "../speko/client.js";
import type { OwnedNumber, ReadinessReport } from "../types.js";

const CALL_ME_NOTE =
  "call_me is a v2 feature (the Speko platform exposes no verified personal phone yet); " +
  "make_call to a business does not need it.";

export async function checkReadiness(client: SpekoClient): Promise<ReadinessReport> {
  let authFailed = false;
  let balanceUsd: number | null = null;
  let creditsError: string | null = null;
  try {
    const balance = await client.getBalance();
    balanceUsd = typeof balance.balanceUsd === "number" ? balance.balanceUsd : null;
  } catch (e) {
    creditsError = (e as Error).message;
    if (isAuthFailure(e)) authFailed = true;
  }

  const owned: OwnedNumber[] = [];
  let anyOutboundReady = false;
  let numbersError: string | null = null;
  try {
    const numbers = await client.listPhoneNumbers();
    for (const n of numbers) {
      const setup = n.setupStatus;
      const outboundReady = Boolean(setup?.outboundReady);
      anyOutboundReady = anyOutboundReady || outboundReady;
      owned.push({
        e164: n.e164 ?? null,
        direction: n.direction ?? null,
        source: n.source ?? null,
        setup_status: setup?.status ?? null,
        outbound_ready: outboundReady,
        inbound_ready: Boolean(setup?.inboundReady),
        agent_attached: typeof n.agentId === "string" && n.agentId.length > 0,
        issues: Array.isArray(setup?.issues) ? setup.issues.map((i) => String(i)) : [],
      });
    }
  } catch (e) {
    numbersError = (e as Error).message;
    if (isAuthFailure(e)) authFailed = true;
  }

  const authOk = !authFailed;
  const creditsSufficient = balanceUsd != null && balanceUsd >= MIN_CALL_BALANCE_USD;

  const nextSteps: string[] = [];
  if (!authOk) {
    nextSteps.push("Authentication failed: check the demo server's SPEKO_API_KEY (repo-root .env) and restart it.");
  }
  if (!creditsSufficient) {
    const shown = balanceUsd != null ? `$${balanceUsd.toFixed(2)}` : "unknown";
    nextSteps.push(
      `Add prepaid credits (current balance ${shown}); outbound calls debit credits per minute, so top up before make_call.`,
    );
  }
  if (!anyOutboundReady && authOk) {
    nextSteps.push(
      "You own no outbound-ready caller ID, but make_call can still work if this Speko deployment has a " +
        "server-default caller ID (the 'from' field is optional), so try a call first.",
    );
  }
  if (anyOutboundReady && authOk) {
    nextSteps.push(
      "Note: a number reporting outboundReady does NOT guarantee the deployment's outbound SIP trunk is wired. " +
        "If make_call returns not_connected (the session/agent start but the phone never rings), the platform's " +
        "LiveKit outbound trunk / Telnyx outbound SIP connection for the caller-ID still needs configuring — " +
        "place one real test call to confirm.",
    );
  }
  for (const row of owned) {
    if (row.setup_status && row.setup_status !== "ready" && row.issues.length) {
      const label = row.e164 || "an owned number";
      nextSteps.push(`Resolve setup issues for ${label}: ${row.issues.join(", ")}.`);
    }
    // Inbound answerability is independent of outbound_ready. A number you can dial FROM may still
    // ring into the void when someone calls it (no agent bound / inbound not provisioned) — D-INF2.
    const dir = (row.direction ?? "").toLowerCase();
    if ((dir === "inbound" || dir === "both") && (!row.inbound_ready || !row.agent_attached)) {
      const label = row.e164 || "an owned inbound number";
      const why = !row.agent_attached ? "no agent is attached" : "inbound is not ready";
      nextSteps.push(
        `Inbound calls to ${label} will NOT be answered (${why}), even though outbound_ready may be true — ` +
          "outbound readiness says nothing about inbound answerability.",
      );
    }
  }

  let headline: string;
  if (!authOk) headline = "Ready to call: no - authentication failed.";
  else if (!creditsSufficient) headline = "Ready to call: with caveats - see next_steps.";
  else if (anyOutboundReady)
    headline = "Ready to call: caller ID available (place one test call to confirm the outbound trunk connects).";
  else
    headline =
      "Ready to call: yes (relying on the deployment's server-default caller ID; if a call returns " +
      `'dialing-stub', no outbound number is configured). ${CHECK_READINESS_NEXT_STEP}`;

  return {
    auth: { ok: authOk, error: creditsError ?? numbersError },
    credits: {
      balance_usd: balanceUsd,
      minimum_usd: MIN_CALL_BALANCE_USD,
      sufficient: creditsSufficient,
      error: creditsError,
    },
    outbound: {
      owned_numbers: owned,
      any_outbound_ready: anyOutboundReady,
      server_default_possible: true,
      error: numbersError,
    },
    call_me: { available: false, note: CALL_ME_NOTE },
    next_steps: nextSteps,
    headline,
  };
}
