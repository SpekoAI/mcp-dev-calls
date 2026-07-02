import { describe, expect, it, vi } from "vitest";
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

  it("finalizes when getEvents errors but endedAt is set (the error path no longer skips the endedAt check)", async () => {
    // Before the restructure, a getEvents failure `continue`d straight past the session
    // endedAt check — an events-endpoint outage could leave an ENDED call polling until
    // the wait cap. Would report "timeout" on the old code.
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("err1"),
        getEvents: async () => {
          throw new Error("events endpoint down");
        },
        getCall: async () =>
          ({
            status: "active",
            transcript: { entries: [{ source: "agent", text: "Hi!" }, { source: "user", text: "all good, bye" }] },
            report: { outcome: "Confirmed pickup at noon" },
          }) as any,
        getSession: async () =>
          ({ status: "ended", endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-err1" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.answered).toBe(true);
    expect(s.outcome).toBe("Confirmed pickup at noon");
  });

  it("still falls back to a hard-terminal call status when getEvents errors and endedAt is absent", async () => {
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("err2"),
        getEvents: async () => {
          throw new Error("events endpoint down");
        },
        getCall: async () =>
          ({
            status: "completed",
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes" }] },
            report: {},
          }) as any,
        getSession: async () =>
          ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-err2" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
  });
});

// Realistic serialized shape from GET /v1/calls/{id}/events for the phone leg dying:
// LiveKit closes the recording egress's source and the platform stores the webhook payload.
const EGRESS_SOURCE_CLOSED_EVENT = {
  id: "evt-egress-1",
  event_type: "egress_ended",
  provider: "livekit",
  status: "recording_failed",
  failure_cause: "Source closed",
  payload: { egressInfo: { status: "EGRESS_ABORTED", error: "Source closed" } },
};

describe("runPhoneCall — egress_ended fast-path (phone leg dies ~20s before room_finished)", () => {
  it("finalizes after the confirm window when the transcript is frozen — no room_finished ever arrives", async () => {
    let eventsCalls = 0;
    const transcript = {
      entries: [
        { source: "agent", text: "Hi, this is an AI assistant calling on behalf of Amir." },
        { source: "user", text: "yes 8pm works, bye" },
        { source: "agent", text: "Great. OUTCOME: Table booked at 8pm" },
      ],
    };
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("eg1"),
        getEvents: async () => {
          eventsCalls += 1;
          // Poll 1: live. Poll 2+: the phone leg died (source-closed egress). room_finished NEVER fires.
          return (eventsCalls >= 2
            ? [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT]
            : [{ event_type: "sip.dial_started" }]) as any;
        },
        getCall: async () => ({ status: "active", transcript }) as any, // frozen turn count, no report
        getSession: async () =>
          ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-eg1" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.answered).toBe(true);
    expect(s.outcome).toBe("Table booked at 8pm");
    // Armed on poll 2, then exactly the bounded confirm window (2 polls) before finalizing.
    expect(eventsCalls).toBe(4);
  });

  it("does NOT finalize on egress_ended while transcript turns are still arriving (recording died mid-call)", async () => {
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      12, // small cap: proves the fast-path never fired and the loop ran to the wait limit
      deps({
        dial: dialOk("eg2"),
        // Egress dead from the first poll; the room never finishes (call keeps going).
        getEvents: async () => [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT] as any,
        getCall: async () => {
          getCallCalls += 1;
          // The conversation continues: every read shows MORE turns than the last.
          return {
            status: "active",
            transcript: {
              entries: Array.from({ length: 2 + getCallCalls }, (_, k) => ({
                source: k % 2 ? "user" : "agent",
                text: `turn ${k}`,
              })),
            },
          } as any;
        },
        getSession: async () =>
          ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-eg2" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("timeout"); // live call was never cut short by the dead egress
    expect(getCallCalls).toBeGreaterThanOrEqual(2); // baseline + expiry comparison actually ran
  });

  it("defers to room_finished when it lands inside the confirm window (the measured live sequence)", async () => {
    // The 5/5 live timeline: answered -> transcript turns -> egress_ended (source closed) ->
    // 11.5-21.3s gap -> room_finished. The fast-path must only be a fallback: the real
    // teardown event finalizes the moment it shows up.
    let eventsCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("eg4"),
        getEvents: async () => {
          eventsCalls += 1;
          if (eventsCalls === 1) return [{ event_type: "sip.dial_started" }] as any;
          if (eventsCalls === 2) return [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT] as any;
          return [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT, { event_type: "room_finished" }] as any;
        },
        getCall: async () =>
          ({
            status: "ended",
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yep, see you" }] },
            report: { outcome: "Order confirmed for pickup" },
          }) as any,
        getSession: async () =>
          ({ status: "ended", endedAt: null, phoneCall: { callControlId: "phone-eg4" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("Order confirmed for pickup");
    expect(eventsCalls).toBe(3); // ended on room_finished (poll 3), not by burning the whole window
  });

  it("egress fast-path finalizes at the confirm-window expiry when the call report has arrived", async () => {
    let eventsCalls = 0;
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("eg3"),
        getEvents: async () => {
          eventsCalls += 1;
          return [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT] as any;
        },
        getCall: async () => {
          getCallCalls += 1;
          return {
            status: "ended",
            transcript: {
              // One MORE turn on later reads (a final turn flushed at teardown) — the report's
              // arrival must finalize even though the turn count moved.
              entries: [
                { source: "agent", text: "hi" },
                { source: "user", text: "sure" },
                ...(getCallCalls > 1 ? [{ source: "agent", text: "bye" }] : []),
              ],
            },
            report: getCallCalls > 1 ? { outcome: "They open at 9am" } : null,
          } as any;
        },
        getSession: async () =>
          ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-eg3" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("They open at 9am");
    expect(eventsCalls).toBe(3); // armed on poll 1 + the 2-poll confirm window
  });
});

describe("runPhoneCall — wall-clock elapsed (API latency counts toward the wait cap)", () => {
  it("caps the wait by Date.now() deltas, not summed sleep intervals", async () => {
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const fakeSleep = async (ms: number): Promise<void> => {
      nowMs += ms;
    };
    let eventsCalls = 0;
    try {
      const s = await runPhoneCall(
        BODY,
        30,
        deps({
          dial: dialOk("wc1"),
          getEvents: async () => {
            eventsCalls += 1;
            nowMs += 8000; // slow events endpoint: 8s of real latency per poll
            return [{ event_type: "sip.dial_started" }] as any;
          },
          getCall: async () => ({ status: "active", transcript: null }) as any,
          getSession: async () =>
            ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-wc1" }, usage: [] }) as any,
        }),
        fakeSleep,
      );
      expect(s.status).toBe("timeout");
      // 3 polls x (2s sleep + 8s API) = 30s of wall clock. Interval-summing would have needed
      // 7 polls (2*5 + 10*2 = 30) — i.e. ~86s of real time to enforce a 30s cap.
      expect(eventsCalls).toBe(3);
      expect(s.duration_seconds).toBe(30);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("finalize — report-grace (finalize-vs-report race)", () => {
  it("waits a bounded beat for the call report so the outcome label doesn't degrade", async () => {
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("rg1"),
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getCall: async () => {
          getCallCalls += 1;
          return {
            status: "ended",
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes, 8 works" }] },
            report: getCallCalls > 1 ? { outcome: "Table for 4 confirmed at 8pm" } : null, // report lags one beat
          } as any;
        },
        getSession: async () =>
          ({ status: "ended", endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-rg1" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("Table for 4 confirmed at 8pm");
    expect(getCallCalls).toBe(2); // one transcript read + ONE grace poll, then it stopped waiting
  });

  it("never blocks termination on a report that never comes (bounded, falls back to the transcript)", async () => {
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("rg2"),
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getCall: async () => {
          getCallCalls += 1;
          return {
            status: "ended",
            transcript: {
              entries: [
                { source: "agent", text: "hi" },
                { source: "user", text: "we close Mondays" },
                { source: "agent", text: "OUTCOME: closed Mondays" },
              ],
            },
            report: null,
          } as any;
        },
        getSession: async () =>
          ({ status: "ended", endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-rg2" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("closed Mondays"); // transcript OUTCOME marker, not degraded to null
    expect(getCallCalls).toBe(3); // 1 transcript read (reply found) + exactly 2 grace polls
  });
});

describe("runPhoneCall — serialize guard released on every exit path", () => {
  it("allows a second dial after the first one TIMES OUT", async () => {
    let terminal = false;
    const d: MakeCallDeps = {
      client: {
        dial: dialOk("gt1"),
        getEvents: async () => (terminal ? [{ event_type: "room_finished" }] : [{ event_type: "sip.dial_started" }]) as any,
        getCall: async () =>
          ({
            status: "active",
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes" }] },
            report: {},
          }) as any,
        getSession: async () =>
          ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-gt1" }, usage: [] }) as any,
      } as unknown as SpekoClient,
      cfg: { serializeCalls: true } as AppConfig,
      bearerHash: "test",
      sleep: noopSleep,
    };
    const first = await runPhoneCall(BODY, 3, d, noopSleep);
    expect(first.status).toBe("timeout");
    terminal = true; // same guard, next call must be allowed through AND complete
    const second = await runPhoneCall(BODY, 300, d, noopSleep);
    expect(second.status).toBe("completed");
  });

  it("allows a second dial after the first one THROWS mid-poll", async () => {
    let healthy = false;
    const d: MakeCallDeps = {
      client: {
        dial: dialOk("gt2"),
        getEvents: async () => {
          if (!healthy) throw new Error("events endpoint down");
          return [{ event_type: "room_finished" }] as any;
        },
        getCall: async () => {
          if (!healthy) throw new Error("calls endpoint down"); // events + call detail both dark → AppError
          return {
            status: "ended",
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes" }] },
            report: {},
          } as any;
        },
        getSession: async () => {
          if (!healthy) throw new Error("sessions endpoint down");
          return { status: "ended", endedAt: null, phoneCall: { callControlId: "phone-gt2" }, usage: [] } as any;
        },
      } as unknown as SpekoClient,
      cfg: { serializeCalls: true } as AppConfig,
      bearerHash: "test",
      sleep: noopSleep,
    };
    await expect(runPhoneCall(BODY, 300, d, noopSleep)).rejects.toThrow(/calls endpoint down/i);
    healthy = true;
    const second = await runPhoneCall(BODY, 300, d, noopSleep);
    expect(second.status).toBe("completed");
  });
});
