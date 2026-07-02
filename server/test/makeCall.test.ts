import { describe, expect, it } from "vitest";
import { runPhoneCall, type MakeCallDeps } from "../src/calls/makeCall.js";
import type { AppConfig } from "../src/config.js";
import type { SpekoClient } from "../src/speko/client.js";
import type { VoiceDialParams } from "@spekoai/sdk";

const noopSleep = async (): Promise<void> => {};
const BODY = { to: "+77771110474", from: "+15312160099" } as unknown as VoiceDialParams;

function deps(client: Partial<SpekoClient>): MakeCallDeps {
  return { client: client as unknown as SpekoClient, cfg: {} as AppConfig, bearerHash: "test", sleep: noopSleep };
}

const dialOk = (sessionId: string) =>
  async () => ({ sessionId, callControlId: `phone-${sessionId}`, roomName: "r", status: "dialing", to: BODY.to!, from: BODY.from! } as any);

describe("runPhoneCall — terminal detection (the not_connected false-negative fix)", () => {
  it("reports a RECOVERED call (premature 'failed' then a real conversation) as completed + answered", async () => {
    // The platform emits a recoverable worker.no_first_audio_timeout BEFORE room_finished, while a
    // full conversation follows. We must NOT finalize until room_finished — and then the transcript
    // (with a user turn) is the ground truth, even though the session is a callControlId-null ghost.
    const eventSeq = [
      [{ event_type: "sip.dial_started" }],
      [{ event_type: "sip.dial_started" }, { event_type: "worker.no_first_audio_timeout", failure_cause: "silent_bot_no_agent_audio" }],
      [{ event_type: "sip.dial_started" }, { event_type: "worker.first_agent_audio" }, { event_type: "room_finished" }],
    ];
    let i = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("s1"),
        getEvents: async () => eventSeq[Math.min(i++, eventSeq.length - 1)] as any,
        getCall: async () =>
          ({
            status: "failed", // the platform's misleading status
            transcript: { entries: [{ source: "agent", text: "Hey!" }, { source: "user", text: "yeah what's up" }] },
            report: { outcome: "Open until 10pm, has carnitas" },
          }) as any,
        getSession: async () => ({ status: "failed", phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.connected).toBe(true);
    expect(s.answered).toBe(true);
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("Open until 10pm, has carnitas");
    expect(s.call_id).toBe("s1");
  });

  it("does NOT finalize on a bare premature 'failed' — keeps polling until room_finished (here: times out)", async () => {
    const s = await runPhoneCall(
      BODY,
      3, // tiny cap → a couple polls then timeout (proves 'failed' alone never ends the loop)
      deps({
        dial: dialOk("s2"),
        getEvents: async () => [{ event_type: "sip.dial_started" }, { event_type: "worker.no_first_audio_timeout", failure_cause: "x" }] as any,
        getCall: async () => ({ status: "failed", transcript: null }) as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("timeout");
  });

  it("reports a genuinely silent call (room_finished, agent-only transcript) as not_connected", async () => {
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("s3"),
        getEvents: async () => [{ event_type: "sip.dial_started" }, { event_type: "room_finished" }] as any,
        getCall: async () => ({ status: "failed", transcript: { entries: [{ source: "agent", text: "Hey!" }] } }) as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.connected).toBe(false);
    expect(s.answered).toBe(false);
    expect(s.status).toBe("not_connected");
    expect(s.duration_seconds).toBe(0);
  });

  it("stops immediately on a hard failure event (agent.dispatch_failed) → not_connected", async () => {
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("s4"),
        getEvents: async () => [{ event_type: "agent.dispatch_failed" }] as any,
        getCall: async () => ({ status: "failed", transcript: null }) as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("not_connected");
  });

  it("serialize guard (D-INF1): rejects a 2nd concurrent call while one is in flight", async () => {
    let releaseDial: () => void = () => {};
    const dialGate = new Promise<void>((r) => {
      releaseDial = r;
    });
    const d: MakeCallDeps = {
      client: {
        dial: async () => {
          await dialGate; // hold the first call "in flight"
          return { sessionId: "sA", callControlId: "phone-sA", roomName: "r", status: "dialing", to: BODY.to!, from: BODY.from! } as any;
        },
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getCall: async () => ({ status: "failed", transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes" }] } }) as any,
        getSession: async () => ({ phoneCall: { callControlId: "phone-sA" }, usage: [] }) as any,
      } as unknown as SpekoClient,
      cfg: { serializeCalls: true } as AppConfig,
      bearerHash: "test",
      sleep: noopSleep,
    };
    const first = runPhoneCall(BODY, 300, d, noopSleep); // enters, sets inFlight, then awaits dial
    await Promise.resolve();
    await expect(runPhoneCall(BODY, 300, d, noopSleep)).rejects.toThrow(/already in progress/i);
    releaseDial(); // let the first call finish so the flag clears
    const s1 = await first;
    expect(s1.status).toBe("completed");
    // flag cleared → a subsequent (non-overlapping) call is allowed again
    const s2 = await runPhoneCall(BODY, 300, d, noopSleep);
    expect(s2.status).toBe("completed");
  });

  it("treats a stub dial (no callControlId) as not_placed without polling", async () => {
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: async () => ({ sessionId: "s5", callControlId: "", roomName: "r", status: "dialing-stub", to: BODY.to!, from: BODY.from! }) as any,
        getEvents: async () => {
          throw new Error("should not poll a stub dial");
        },
      }),
      noopSleep,
    );
    expect(s.status).toBe("not_placed");
  });
});

describe("runPhoneCall — agent-initiated hangup (the worker's end_call tool)", () => {
  it("finalizes the instant call.end_tool.completed appears — before room_finished and before endedAt", async () => {
    // Realistic sequence for an endCall-enabled dial: the agent confirms the answer, invokes
    // end_call (farewell spoken by the tool), and the platform records call.end_tool.completed.
    // room_finished lags the drain (11.5-21.3s on live calls) and the session's endedAt is only
    // stamped AT room_finished — so the end-tool event ALONE must end the poll loop.
    const eventSeq = [
      [{ event_type: "sip.dial_started" }],
      [{ event_type: "sip.dial_started" }, { event_type: "worker.first_agent_audio" }],
      [
        { event_type: "sip.dial_started" },
        { event_type: "worker.first_agent_audio" },
        { event_type: "call.end_tool.completed", payload: { reason: "objective answered" } },
      ],
    ];
    let polls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("end1"),
        getEvents: async () => {
          polls += 1;
          return eventSeq[Math.min(polls - 1, eventSeq.length - 1)] as any;
        },
        getCall: async () =>
          ({
            status: "ended",
            transcript: {
              entries: [
                { source: "agent", text: "Hi!" },
                { source: "user", text: "we're open till 10 tonight" },
                { source: "agent", text: "got it, open till 10 — thanks, bye!" },
              ],
            },
            report: { outcome: "Open until 10pm tonight" },
          }) as any,
        // endedAt stays null the whole loop: the phone leg is only torn down at room_finished,
        // which this sequence never reaches — proving the end-tool event is what finalized.
        getSession: async () =>
          ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-end1" }, usage: [{ provider: "telnyx", metric: "outbound_minutes" }] }) as any,
      }),
      noopSleep,
    );
    expect(polls).toBe(3); // stopped on the poll that surfaced the end-tool event — zero extra polls
    expect(s.status).toBe("completed");
    expect(s.connected).toBe(true);
    expect(s.answered).toBe(true);
    expect(s.outcome).toBe("Open until 10pm tonight");
    expect(s.call_id).toBe("end1");
  });
});

describe("runPhoneCall — phone-leg hangup detection (Bek: 'I hang up but terminal keeps showing in call')", () => {
  it("finalizes as soon as the session endedAt is stamped (callee hung up), without waiting for room_finished", async () => {
    // Telnyx call.hangup sets session endedAt immediately; the LiveKit room (and its
    // room_finished event) lags ~45-60s because the agent idles inside. The poll loop
    // must treat endedAt as terminal — otherwise the caller sits "in call" until the
    // room drains or the wait cap expires.
    let sessionCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("hang1"),
        getEvents: async () => [{ event_type: "sip.dial_started" }, { event_type: "worker.first_agent_audio" }] as any, // never a room-end event
        getCall: async () =>
          ({
            status: "active",
            transcript: { entries: [{ source: "agent", text: "Hi!" }, { source: "user", text: "yes 8pm works, bye" }] },
            report: { outcome: "Table booked at 8pm" },
          }) as any,
        getSession: async () => {
          sessionCalls += 1;
          // First poll: still live. From the second poll on: the human hung up.
          return (sessionCalls >= 2
            ? { status: "ended", endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-hang1" }, usage: [] }
            : { status: "active", endedAt: null, phoneCall: { callControlId: "phone-hang1" }, usage: [] }) as any;
        },
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed"); // finalized honestly — NOT "timeout"
    expect(s.answered).toBe(true);
    expect(s.outcome).toBe("Table booked at 8pm");
  });

  it("does NOT end on a premature 'failed' status while endedAt is still null (A2 guard preserved)", async () => {
    const s = await runPhoneCall(
      BODY,
      3, // tiny cap → proves the loop kept polling and hit the cap
      deps({
        dial: dialOk("hang2"),
        getEvents: async () => [{ event_type: "sip.dial_started" }] as any,
        getCall: async () => ({ status: "failed", transcript: null }) as any,
        getSession: async () =>
          ({ status: "failed", endedAt: null, phoneCall: { callControlId: null }, usage: [] }) as any, // SLA flip, call still live
      }),
      noopSleep,
    );
    expect(s.status).toBe("timeout");
  });

  it("keeps polling when the session endpoint errors (best-effort, events remain primary)", async () => {
    const s = await runPhoneCall(
      BODY,
      3,
      deps({
        dial: dialOk("hang3"),
        getEvents: async () => [{ event_type: "sip.dial_started" }] as any,
        getCall: async () => ({ status: "active", transcript: null }) as any,
        getSession: async () => {
          throw new Error("session endpoint down");
        },
      }),
      noopSleep,
    );
    expect(s.status).toBe("timeout"); // survived the errors, no crash
  });
});
