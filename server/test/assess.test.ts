import { describe, expect, it } from "vitest";
import { assessConnection } from "../src/calls/assess.js";
import { shapeCallSummary } from "../src/calls/summary.js";
import type { SessionDetail } from "../src/types.js";

// The exact shape of the real failed Sakura Sushi call: session + LLM agent ran
// (greeting only), but no SIP leg formed — callControlId null, no carrier minutes.
const GHOST_SESSION: SessionDetail = {
  status: "ended",
  durationSeconds: 50,
  phoneCall: { callControlId: null, phoneNumberId: "3ad18032" },
  usage: [
    { provider: "speko", metric: "session_seconds", quantity: 51, cost: 0 },
    { provider: "openai", metric: "llm_tokens", quantity: 1611, cost: 0.0172 },
  ],
};
const AGENT_ONLY_TRANSCRIPT = {
  entries: [{ source: "agent", text: "Hi, this is an AI assistant calling on behalf of Amirlan." }],
};

describe("assessConnection", () => {
  it("reports NOT connected when there is no SIP leg and no carrier minutes (the real failure)", () => {
    const a = assessConnection(GHOST_SESSION, AGENT_ONLY_TRANSCRIPT);
    expect(a.connected).toBe(false);
    expect(a.answered).toBe(false);
    expect(a.callControlId).toBeNull();
    expect(a.carrierBilled).toBe(false);
  });

  it("reports connected when a callControlId is present", () => {
    const session: SessionDetail = { ...GHOST_SESSION, phoneCall: { callControlId: "v3:abc123" } };
    expect(assessConnection(session, AGENT_ONLY_TRANSCRIPT).connected).toBe(true);
  });

  it("reports connected when carrier minutes were billed", () => {
    const session: SessionDetail = {
      phoneCall: { callControlId: null },
      usage: [{ provider: "telnyx", metric: "outbound_minutes", quantity: 1, cost: 0.01 }],
    };
    const a = assessConnection(session, AGENT_ONLY_TRANSCRIPT);
    expect(a.connected).toBe(true);
    expect(a.carrierBilled).toBe(true);
  });

  it("counts a real conversation as connected and answered", () => {
    const transcript = {
      entries: [
        { source: "agent", text: "Hi, do you have a moment?" },
        { source: "user", text: "Sure, what do you need?" },
      ],
    };
    const a = assessConnection(GHOST_SESSION, transcript);
    expect(a.answered).toBe(true);
    expect(a.connected).toBe(true); // a caller turn alone proves a real conversation
  });

  it("returns connected=null (undetermined) when the session could not be fetched", () => {
    expect(assessConnection(null, AGENT_ONLY_TRANSCRIPT).connected).toBeNull();
  });
});

describe("shapeCallSummary", () => {
  it("maps a no-leg call to not_connected with zeroed duration and a reason", () => {
    const s = shapeCallSummary({
      callId: "c1",
      to: "+77771110474",
      from: "+13392308385",
      status: "ended",
      transcript: AGENT_ONLY_TRANSCRIPT,
      outcome: "abandoned",
      session: GHOST_SESSION,
      fallbackDuration: 50,
    });
    expect(s.status).toBe("not_connected");
    expect(s.connected).toBe(false);
    expect(s.answered).toBe(false);
    expect(s.duration_seconds).toBe(0);
    expect(s.outcome).toBeNull(); // never report an outcome for a call that did not connect
    expect(s.reason).toMatch(/never rang/i);
    expect(s.caller_id).toBe("+13392308385");
    expect(s.dialed_number).toBe("+77771110474");
  });

  it("keeps platform status but flags no-answer when connected with no caller turn", () => {
    const session: SessionDetail = {
      status: "no_answer",
      durationSeconds: 18,
      phoneCall: { callControlId: "v3:abc" },
      usage: [{ provider: "telnyx", metric: "outbound_minutes", quantity: 1 }],
    };
    const s = shapeCallSummary({
      callId: "c2",
      to: "+12025550199",
      from: "+13392308385",
      status: "no_answer",
      transcript: AGENT_ONLY_TRANSCRIPT,
      outcome: null,
      session,
      fallbackDuration: 20,
    });
    expect(s.status).toBe("no_answer");
    expect(s.connected).toBe(true);
    expect(s.answered).toBe(false);
    expect(s.duration_seconds).toBe(18); // real session duration, not poll elapsed
    expect(s.reason).toMatch(/never spoke|no answer/i);
  });

  it("reports a normal connected + answered call with its outcome", () => {
    const session: SessionDetail = {
      status: "completed",
      durationSeconds: 42,
      phoneCall: { callControlId: "v3:xyz" },
      usage: [{ provider: "telnyx", metric: "outbound_minutes", quantity: 1 }],
    };
    const transcript = {
      entries: [
        { source: "agent", text: "Table for 4 at 8?" },
        { source: "user", text: "Yes, booked." },
      ],
    };
    const s = shapeCallSummary({
      callId: "c3",
      to: "+12025550199",
      from: "+13392308385",
      status: "completed",
      transcript,
      outcome: "table for 4 at 8pm booked",
      session,
      fallbackDuration: 40,
    });
    expect(s.status).toBe("completed");
    expect(s.connected).toBe(true);
    expect(s.answered).toBe(true);
    expect(s.outcome).toBe("table for 4 at 8pm booked");
    expect(s.reason).toBeUndefined();
  });
});
