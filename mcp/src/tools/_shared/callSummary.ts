/**
 * One plain-language summary for every tool that returns a call result (make_call,
 * call_number, get_call). A single source of truth so the tools can't drift apart in
 * copy again — call_number's timeout used to omit the "check again with get_call" hint
 * make_call had, and its not_placed message never said how to fix the problem.
 */

export interface SummarizeOptions {
  /**
   * Tool to suggest retrying when the call was never placed. null omits the retry hint
   * (get_call re-checks an existing call, so "retry" makes no sense there).
   */
  retryTool: "make_call" | "call_number" | null;
}

/** Canonical agent-facing summary for call_me, shared by the initial result and get_call. */
export function summarizeOwnerCallResult(s: Record<string, unknown>): string | null {
  const isOwnerCall =
    typeof s.message === "string" || typeof s.owner_reply === "string" || typeof s.confirmation === "string";
  if (!isOwnerCall) return null;

  const confirmation = typeof s.confirmation === "string" ? s.confirmation : null;
  const finalInstruction = typeof s.final_instruction === "string" ? s.final_instruction : null;
  const ownerReply = typeof s.owner_reply === "string" ? s.owner_reply : null;
  const nextStep = typeof s.next_step === "string" ? s.next_step : null;
  if (confirmation === "confirmed" || confirmation === "corrected") {
    if (!finalInstruction) {
      return (
        "The owner-call confirmation record is inconsistent, so no instruction is confirmed. " +
        (nextStep ?? "Re-confirm with the human before taking action.")
      );
    }
    const label = confirmation === "corrected" ? "corrected and confirmed" : "confirmed";
    return `Owner instruction ${label} (voice transcript, speaker unverified): ${finalInstruction}`;
  }
  if (ownerReply) return `${ownerReply}${nextStep ? ` ${nextStep}` : ""}`;
  return nextStep;
}

export function summarizeCallResult(s: Record<string, unknown>, opts: SummarizeOptions): string {
  const status = typeof s.status === "string" ? s.status : "unknown";
  const callId = typeof s.call_id === "string" ? s.call_id : null;
  const outcome = typeof s.outcome === "string" ? s.outcome : null;
  const reason = typeof s.reason === "string" ? s.reason : null;
  const connected = s.connected === true;
  const answered = s.answered === true;
  const id = callId ? ` (call_id '${callId}')` : "";

  if (status === "not_placed") {
    const retry = opts.retryTool ? `, then retry ${opts.retryTool}` : "";
    return (
      reason ??
      "The call was NOT placed: this Speko deployment has no outbound caller-ID/SIP configured. " +
        `Run check_call_readiness and configure a caller ID${retry}.`
    );
  }
  if (status === "not_connected") {
    // The server reason differentiates a trunk/caller-ID dial failure from a destination-side
    // no-answer (E1) — render it as-is instead of unconditionally blaming the outbound trunk.
    return reason ?? "The call did not connect — the other party was never heard.";
  }
  if (status === "timeout") {
    return `Reached the wait limit; the call may still be in progress${id}. Check again with get_call.`;
  }
  if (status === "in_progress") {
    // get_call on a live call — never describe it as finished.
    return reason ?? `The call is still in progress${id} — check again with get_call in a few seconds.`;
  }
  if (status === "dialing") {
    // wait:false — the dial was placed and the call continues in the background. Lead with the
    // server's no-redial next_step so the agent polls get_call instead of retrying the dial tool.
    const nextStep = typeof s.next_step === "string" ? s.next_step : null;
    const placed = reason ?? `The call was placed and is continuing in the background${id}.`;
    return `${placed} ${nextStep ?? "Poll get_call until it reaches a terminal status. Do not place another call."}`;
  }
  if (connected && !answered) {
    return reason ?? `The call connected but no one responded${id}.`;
  }
  if (outcome) return outcome;
  return `${callId ? `Call '${callId}'` : "The call"} finished with status '${status}' and no outcome was captured.`;
}
