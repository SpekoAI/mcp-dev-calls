import { describe, expect, it } from "vitest";
import { summarizeCallResult } from "../src/tools/_shared/callSummary.js";

describe("summarizeCallResult — the shared plain-language summary", () => {
  it("not_placed: names check_call_readiness and the tool to retry", () => {
    const s = summarizeCallResult({ status: "not_placed" }, { retryTool: "call_number" });
    expect(s).toContain("NOT placed");
    expect(s).toContain("check_call_readiness");
    expect(s).toContain("retry call_number");
  });

  it("not_placed without a retry tool (get_call) omits the retry hint", () => {
    const s = summarizeCallResult({ status: "not_placed" }, { retryTool: null });
    expect(s).toContain("check_call_readiness");
    expect(s).not.toContain("retry");
  });

  it("not_placed: a server-provided reason wins over the canned copy", () => {
    const s = summarizeCallResult({ status: "not_placed", reason: "after-hours gate" }, { retryTool: "make_call" });
    expect(s).toBe("after-hours gate");
  });

  it("not_connected: renders the server reason as-is (E1 — never unconditionally blame the trunk)", () => {
    const reason = "destination-side no-answer, not a trunk problem";
    expect(summarizeCallResult({ status: "not_connected", reason }, { retryTool: "make_call" })).toBe(reason);
  });

  it("timeout: always points at get_call (call_number used to omit this)", () => {
    const s = summarizeCallResult({ status: "timeout", call_id: "c-1" }, { retryTool: "call_number" });
    expect(s).toContain("call_id 'c-1'");
    expect(s).toContain("Check again with get_call");
  });

  it("in_progress (a live call via get_call) is never described as finished", () => {
    const s = summarizeCallResult(
      { status: "in_progress", call_id: "c-2", connected: true, answered: true },
      { retryTool: null },
    );
    expect(s).not.toContain("finished");
    expect(s).toContain("in progress");
  });

  it("dialing (wait:false) leads with the server reason + no-redial next_step", () => {
    const s = summarizeCallResult(
      {
        status: "dialing",
        call_id: "c-bg",
        reason: "The call was placed and is continuing in the background.",
        next_step: "Poll get_call('c-bg') until it reaches a terminal status. Do not place another call.",
      },
      { retryTool: "make_call" },
    );
    expect(s).toContain("continuing in the background");
    expect(s).toContain("get_call('c-bg')");
    expect(s).toContain("Do not place another call");
    expect(s).not.toContain("finished");
  });

  it("dialing without server prose still points at get_call and forbids another dial", () => {
    const s = summarizeCallResult({ status: "dialing", call_id: "c-bg2" }, { retryTool: "call_number" });
    expect(s).toContain("call_id 'c-bg2'");
    expect(s).toContain("get_call");
    expect(s).toContain("Do not place another call");
  });

  it("connected but unanswered → the no-response line (or the server reason)", () => {
    const s = summarizeCallResult({ status: "no_answer", connected: true, answered: false, call_id: "c-3" }, { retryTool: "make_call" });
    expect(s).toContain("no one responded");
    expect(s).toContain("c-3");
  });

  it("a completed call with an outcome returns the outcome verbatim", () => {
    const s = summarizeCallResult(
      { status: "completed", connected: true, answered: true, outcome: "Booked for 8pm under Bek." },
      { retryTool: "make_call" },
    );
    expect(s).toBe("Booked for 8pm under Bek.");
  });

  it("a completed call without an outcome says so honestly", () => {
    const s = summarizeCallResult(
      { status: "completed", connected: true, answered: true, call_id: "c-4" },
      { retryTool: "make_call" },
    );
    expect(s).toContain("no outcome was captured");
    expect(s).toContain("c-4");
  });
});
