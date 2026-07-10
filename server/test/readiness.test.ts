/**
 * check_call_readiness speaks plain language: a scannable ✅/⏳/❌ headline and
 * human next-steps, without the old jargon wall (no "outbound SIP trunk" /
 * "dialing-stub" / "Ready to call:" prose). Honesty preserved — "ready" only when
 * auth + credits are good, and the first-call caveat still surfaces as plain text.
 */
import { describe, expect, it } from "vitest";
import { checkReadiness } from "../src/calls/readiness.js";
import { SpekoApiError, type SpekoClient } from "../src/speko/client.js";

const authError = () => new SpekoApiError("unauthorized", 401, "unauthorized");

const fakeClient = (over: {
  balanceUsd?: number | null;
  authFail?: boolean;
  numbers?: unknown[];
}): SpekoClient =>
  ({
    getBalance: async () => {
      if (over.authFail) throw authError();
      return { balanceUsd: over.balanceUsd ?? 100 };
    },
    listPhoneNumbers: async () => {
      if (over.authFail) throw authError();
      return over.numbers ?? [];
    },
  }) as unknown as SpekoClient;

const NO_JARGON = /outbound SIP trunk|dialing-stub|Ready to call:|LiveKit outbound|Telnyx/;

describe("check_call_readiness — plain-language headline", () => {
  it("ready: ✅ headline, no jargon wall", async () => {
    const r = await checkReadiness(fakeClient({ balanceUsd: 100 }));
    expect(r.headline).toMatch(/^✅/);
    expect(r.headline).not.toMatch(NO_JARGON);
    expect(r.next_steps.join(" ")).not.toMatch(NO_JARGON);
  });

  it("no credits: ⏳ headline pointing at credits, not a caveat dump", async () => {
    const r = await checkReadiness(fakeClient({ balanceUsd: 0 }));
    expect(r.headline).toMatch(/^⏳/);
    expect(r.credits.sufficient).toBe(false);
    expect(r.next_steps.some((s) => /add credits/i.test(s))).toBe(true);
  });

  it("auth failure: ❌ headline that says sign in again", async () => {
    const r = await checkReadiness(fakeClient({ authFail: true }));
    expect(r.headline).toMatch(/^❌/);
    expect(r.auth.ok).toBe(false);
    expect(r.next_steps.some((s) => /sign in|login/i.test(s))).toBe(true);
  });

  it("ready with an outbound number: first-call confirm is plain, not scary", async () => {
    const r = await checkReadiness(
      fakeClient({
        balanceUsd: 50,
        numbers: [
          {
            e164: "+14155550142",
            direction: "outbound",
            source: "sip_trunk",
            agentId: "agent_1",
            setupStatus: { status: "ready", inboundReady: true, outboundReady: true, agentReady: true, issues: [] },
          },
        ],
      }),
    );
    expect(r.headline).toMatch(/^✅/);
    expect(r.next_steps.some((s) => /first call/i.test(s))).toBe(true);
    expect(r.next_steps.join(" ")).not.toMatch(NO_JARGON);
  });
});
