/**
 * check_call_readiness backing logic. Read-only: derives auth + credit + outbound
 * caller-ID readiness from the SDK's credit balance and phone-number list. call_me
 * is reported as a deferred v2 feature (the platform exposes no verified personal
 * phone today).
 */
import { MIN_CALL_BALANCE_USD } from "../constants.js";
import { isAuthFailure, type SpekoClient } from "../speko/client.js";
import type { OwnedNumber, ReadinessReport } from "../types.js";

const CALL_ME_NOTE =
  "call_me is a v2 feature (the Speko platform exposes no verified personal phone yet); " +
  "make_call to a business does not need it.";
const NOT_CONNECTED_GUIDANCE =
  "If it returns not_connected, follow the returned reason; it distinguishes a dial/setup failure, " +
  "destination no-answer, or an unconfirmed connection.";

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
    nextSteps.push(
      "Authentication failed: re-run `npx @spekoai/mcp-calls login` to refresh your key " +
        "(or check SPEKO_API_KEY in your MCP client config).",
    );
  }
  if (!creditsSufficient) {
    const shown = balanceUsd != null ? `$${balanceUsd.toFixed(2)}` : "unknown";
    nextSteps.push(
      `Add credits at platform.speko.dev to place calls (current balance ${shown}); calls are billed per minute.`,
    );
  }
  if (authOk && creditsSufficient) {
    // Honest but plain: we can't confirm the outbound line is actually wired until a real call
    // runs, so frame the first call as the confirmation instead of a scary SIP-trunk warning.
    // (Full technical detail stays in the structured `outbound` field for anyone who needs it.)
    nextSteps.push(
      anyOutboundReady
        ? `Your first call confirms the line end to end. ${NOT_CONNECTED_GUIDANCE}`
        : "No outbound-ready number is listed. This deployment may have a shared number, but readiness " +
            `cannot confirm it. Place one call to check. ${NOT_CONNECTED_GUIDANCE}`,
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
        `Inbound calls to ${label} will NOT be answered (${why}), even though outbound_ready may be true - ` +
          "outbound readiness says nothing about inbound answerability.",
      );
    }
  }

  // Plain-language, scannable status. Honest: "ready" means auth + credits are good and a call
  // will be attempted; the first call is what confirms the outbound line (see next_steps).
  let headline: string;
  if (!authOk) headline = "Not connected: your Speko key was rejected. Sign in again to continue.";
  else if (!creditsSufficient) headline = "Almost ready: add credits and you can start placing calls.";
  else headline = "Ready to place calls.";

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
