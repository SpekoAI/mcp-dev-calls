import { describe, expect, it } from "vitest";
import { checkReadiness } from "../src/calls/readiness.js";
import { shapeCallSummary } from "../src/calls/summary.js";
import { detectControlTokenLeak } from "../src/lib/transcript.js";
import type { SpekoClient } from "../src/speko/client.js";

describe("B2 — receptionist control-token leak detection", () => {
  it("flags verbalized field labels / tool tokens in the callee's turns", () => {
    const leaky = {
      entries: [
        { source: "agent", text: "Your table is confirmed for 8pm." },
        { source: "user", text: "Great. I can end the call dot type colon and underscore call farewell colon thank you." },
      ],
    };
    expect(detectControlTokenLeak(leaky)).toBe(true);
  });

  it("does not flag a clean call", () => {
    const clean = {
      entries: [
        { source: "agent", text: "Do you have a table for 4 at 8?" },
        { source: "user", text: "Yes, 8pm works. See you then!" },
      ],
    };
    expect(detectControlTokenLeak(clean)).toBe(false);
  });

  it("surfaces the flag on the shaped summary", () => {
    const s = shapeCallSummary({
      callId: "c1",
      to: "+1",
      from: "+1",
      status: "ended",
      transcript: {
        entries: [
          { source: "agent", text: "hi" },
          { source: "user", text: "reason colon caller confirmed reservation" },
        ],
      },
      outcome: null,
      session: { durationSeconds: 20, phoneCall: { callControlId: "x" }, usage: [] } as any,
      fallbackDuration: 20,
      isTerminal: true,
    });
    expect(s.receptionist_control_token_leak).toBe(true);
  });
});

describe("E1 — not_connected differentiates trunk failure vs destination no-answer", () => {
  const base = (dialFailed: boolean) =>
    shapeCallSummary({
      callId: "c1",
      to: "+1",
      from: "+1",
      status: "failed",
      transcript: { entries: [{ source: "agent", text: "hi" }] }, // agent-only → not answered
      outcome: null,
      session: { phoneCall: { callControlId: null }, usage: [] } as any,
      fallbackDuration: 0,
      isTerminal: true,
      dialFailed,
    });

  it("blames the trunk only on a hard dial failure", () => {
    const s = base(true);
    expect(s.status).toBe("not_connected");
    expect(s.reason).toMatch(/trunk|failed to dial/i);
  });

  it("reports a destination no-answer without blaming the trunk", () => {
    const s = base(false);
    expect(s.status).toBe("not_connected");
    expect(s.reason).toMatch(/no answer|never heard|try again/i);
    expect(s.reason).not.toMatch(/failed to dial/i);
  });
});

describe("D-INF2 — readiness surfaces inbound answerability", () => {
  it("marks inbound_ready / agent_attached and warns when inbound won't answer", async () => {
    const client = {
      getBalance: async () => ({ balanceUsd: 100 }),
      listPhoneNumbers: async () => [
        {
          e164: "+16365851161",
          direction: "inbound",
          source: "sip_trunk",
          agentId: null,
          setupStatus: {
            status: "ready",
            inboundReady: false,
            outboundReady: true,
            agentReady: false,
            forwardingRequired: false,
            sipConnectionReady: true,
            issues: [],
          },
        },
      ],
    } as unknown as SpekoClient;
    const r = await checkReadiness(client);
    const n = r.outbound.owned_numbers[0];
    expect(n.inbound_ready).toBe(false);
    expect(n.agent_attached).toBe(false);
    expect(r.next_steps.some((s) => /will NOT be answered|no agent/i.test(s))).toBe(true);
  });
});
