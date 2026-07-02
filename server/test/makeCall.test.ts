import { describe, expect, it } from "vitest";
import { runPhoneCall, type MakeCallDeps } from "../src/calls/makeCall.js";
import type { AppConfig } from "../src/config.js";
import type { SpekoClient } from "../src/speko/client.js";
import type { VoiceDialParams } from "@spekoai/sdk";

const noopSleep = async (): Promise<void> => {};
const BODY = { to: "+77771110474", from: "+15312160099" } as unknown as VoiceDialParams;

/**
 * Ties an instant fake sleep and an injectable now() to ONE time source, so sleeping still
 * advances the wall clock the poll loop's wait cap and egress confirm window measure against.
 * Tests that must hit the wait cap (or expire the confirm window) need this; tests that end
 * via a terminal event within the cap can keep the real clock + noopSleep.
 */
function makeFakeClock() {
  let nowMs = 0;
  return {
    now: (): number => nowMs,
    sleep: async (ms: number): Promise<void> => {
      nowMs += ms;
    },
    /** Simulate real latency spent outside sleep (e.g. a slow API call). */
    advance: (ms: number): void => {
      nowMs += ms;
    },
  };
}
type FakeClock = ReturnType<typeof makeFakeClock>;

function deps(client: Partial<SpekoClient>, clock?: FakeClock): MakeCallDeps {
  return {
    client: client as unknown as SpekoClient,
    cfg: {} as AppConfig,
    bearerHash: "test",
    sleep: clock?.sleep ?? noopSleep,
    ...(clock ? { now: clock.now } : {}),
  };
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
    const clock = makeFakeClock();
    const s = await runPhoneCall(
      BODY,
      3, // tiny cap → a couple polls then timeout (proves 'failed' alone never ends the loop)
      deps(
        {
          dial: dialOk("s2"),
          getEvents: async () => [{ event_type: "sip.dial_started" }, { event_type: "worker.no_first_audio_timeout", failure_cause: "x" }] as any,
          getCall: async () => ({ status: "failed", transcript: null }) as any,
          getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
        },
        clock,
      ),
      clock.sleep,
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
    const clock = makeFakeClock();
    const s = await runPhoneCall(
      BODY,
      3, // tiny cap → proves the loop kept polling and hit the cap
      deps(
        {
          dial: dialOk("hang2"),
          getEvents: async () => [{ event_type: "sip.dial_started" }] as any,
          getCall: async () => ({ status: "failed", transcript: null }) as any,
          getSession: async () =>
            ({ status: "failed", endedAt: null, phoneCall: { callControlId: null }, usage: [] }) as any, // SLA flip, call still live
        },
        clock,
      ),
      clock.sleep,
    );
    expect(s.status).toBe("timeout");
  });

  it("keeps polling when the session endpoint errors (best-effort, events remain primary)", async () => {
    const clock = makeFakeClock();
    const s = await runPhoneCall(
      BODY,
      3,
      deps(
        {
          dial: dialOk("hang3"),
          getEvents: async () => [{ event_type: "sip.dial_started" }] as any,
          getCall: async () => ({ status: "active", transcript: null }) as any,
          getSession: async () => {
            throw new Error("session endpoint down");
          },
        },
        clock,
      ),
      clock.sleep,
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
    const clock = makeFakeClock();
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
      deps(
        {
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
        },
        clock,
      ),
      clock.sleep,
    );
    expect(s.status).toBe("completed");
    expect(s.answered).toBe(true);
    expect(s.outcome).toBe("Table booked at 8pm");
    // Armed on poll 2 (elapsed 4s). The confirm window is a >=10s wall-clock minimum, so the
    // frozen checks on polls 3-5 (deltas 2/4/6s) hold, and poll 6 (delta 11s) finalizes.
    expect(eventsCalls).toBe(6);
  });

  // Two variants, one rule: turns still arriving mean the call is alive, so the fast-path must
  // stand down whether the report row is absent (recording died mid-call) or present the whole
  // time. getCall.test.ts models report rows on LIVE calls (the platform's report/finalize route
  // has no terminality guard), so the report row is corroboration for a frozen transcript, never
  // an end signal by itself.
  it.each([
    { label: "no report (recording died mid-call)", id: "eg2", report: null },
    { label: "report row present the whole time (reports exist on live calls)", id: "eg5", report: { outcome: "Table booked at 8pm" } },
  ])("does NOT finalize on egress_ended while transcript turns are still arriving — $label", async ({ id, report }) => {
    const clock = makeFakeClock();
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      12, // small cap: proves the fast-path never fired and the loop ran to the wait limit
      deps(
        {
          dial: dialOk(id),
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
              report,
            } as any;
          },
          getSession: async () =>
            ({ status: "active", endedAt: null, phoneCall: { callControlId: `phone-${id}` }, usage: [] }) as any,
        },
        clock,
      ),
      clock.sleep,
    );
    expect(s.status).toBe("timeout"); // the live call was never cut short by the dead egress
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

  it("a report row shortens the FROZEN wait — finalizes before the 10s window expires", async () => {
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
            // Turn count frozen since the egress died; the teardown report lands one beat later.
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "sure" }] },
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
    // Armed on poll 1; the very next confirm poll sees frozen turns + the report row and
    // finalizes at ~2s into the window instead of holding out for the full >=10s (poll 6).
    expect(eventsCalls).toBe(2);
    expect(getCallCalls).toBe(3); // baseline + confirm + the finalize transcript read
  });

  it("holds the confirm window for >=10s of WALL CLOCK in the fast-poll phase — 2 polls (~4s) are not enough", async () => {
    // In the fast-poll phase the polls are 2s apart, so the old 2-POLL window spanned only ~4s —
    // too short to tell "callee thinking" from "call dead". The window is a wall-clock minimum.
    const clock = makeFakeClock();
    let eventsCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps(
        {
          dial: dialOk("eg7"),
          getEvents: async () => {
            eventsCalls += 1;
            // Poll 1: live. Poll 2+: the phone leg died. room_finished NEVER fires.
            return (eventsCalls >= 2
              ? [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT]
              : [{ event_type: "sip.dial_started" }]) as any;
          },
          getCall: async () =>
            ({
              status: "active",
              transcript: {
                entries: [
                  { source: "agent", text: "Hi!" },
                  { source: "user", text: "one sec... OUTCOME: yes 8pm works" },
                ],
              },
            }) as any, // frozen turn count, no report
          getSession: async () =>
            ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-eg7" }, usage: [] }) as any,
        },
        clock,
      ),
      clock.sleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("yes 8pm works");
    // Armed at 4s of wall clock (poll 2). The frozen checks at 6s/8s/10s (deltas 2/4/6) all
    // hold; the delta only crosses 10s at 15s (poll 6). The old poll-count window would have
    // finalized at 8s — 4s after arming.
    expect(eventsCalls).toBe(6);
    expect(s.duration_seconds).toBe(15);
  });

  it("disarms the fast-path when the transcript shape is unreadable (never finalize on missing evidence)", async () => {
    // countTranscriptTurns() returns null for a transcript with no recognizable turn list. That
    // null used to be coerced to a 0==0 "frozen" baseline, fast-finalizing on evidence the loop
    // could not actually read. An unreadable count must stand the fast-path down instead.
    const clock = makeFakeClock();
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      12,
      deps(
        {
          dial: dialOk("eg6"),
          getEvents: async () => [{ event_type: "sip.dial_started" }, EGRESS_SOURCE_CLOSED_EVENT] as any,
          getCall: async () => {
            getCallCalls += 1;
            return { status: "active", transcript: { text: "opaque blob with no turn list" } } as any;
          },
          getSession: async () =>
            ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-eg6" }, usage: [] }) as any,
        },
        clock,
      ),
      clock.sleep,
    );
    expect(s.status).toBe("timeout"); // fell back to the normal end signals (none came) — no fast-finalize
    expect(getCallCalls).toBe(1); // the unreadable baseline read; the window never armed after it
  });
});

describe("runPhoneCall — wall-clock elapsed (API latency counts toward the wait cap)", () => {
  it("caps the wait by wall-clock deltas, not summed sleep intervals", async () => {
    const clock = makeFakeClock();
    let eventsCalls = 0;
    const s = await runPhoneCall(
      BODY,
      30,
      deps(
        {
          dial: dialOk("wc1"),
          getEvents: async () => {
            eventsCalls += 1;
            clock.advance(8000); // slow events endpoint: 8s of real latency per poll
            return [{ event_type: "sip.dial_started" }] as any;
          },
          getCall: async () => ({ status: "active", transcript: null }) as any,
          getSession: async () =>
            ({ status: "active", endedAt: null, phoneCall: { callControlId: "phone-wc1" }, usage: [] }) as any,
        },
        clock,
      ),
      clock.sleep,
    );
    expect(s.status).toBe("timeout");
    // 3 polls x (2s sleep + 8s API) = 30s of wall clock. Interval-summing would have needed
    // 7 polls (2*5 + 10*2 = 30) — i.e. ~86s of real time to enforce a 30s cap.
    expect(eventsCalls).toBe(3);
    expect(s.duration_seconds).toBe(30);
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

  it("skips the grace entirely when the transcript already carries the agent's OUTCOME statement", async () => {
    // The OUTCOME: marker is the agent's own explicit outcome — there is nothing better to wait
    // for, so the happy path must not burn grace polls waiting on report analysis.
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
    expect(getCallCalls).toBe(1); // reply found on the first read + outcome already substantive -> zero grace polls
  });

  it("never blocks termination on a report that never comes (bounded, no outcome from any source)", async () => {
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("rg4"),
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getCall: async () => {
          getCallCalls += 1;
          return {
            status: "ended",
            transcript: {
              entries: [
                { source: "agent", text: "hi" },
                { source: "user", text: "we close Mondays" },
              ],
            },
            report: null,
          } as any;
        },
        getSession: async () =>
          ({ status: "ended", endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-rg4" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBeNull(); // nothing substantive ever came - honest null, not a hang
    expect(getCallCalls).toBe(3); // 1 transcript read (reply found) + exactly 2 bounded grace polls
  });

  it("grace waits past a BARE report outcome for the substantive one (row presence is not the gate)", async () => {
    // The platform's heuristic pass writes the report row FIRST with a bare status word
    // ("completed") and analysis rewrites the real outcome moments later (upsert). Exiting the
    // grace on mere row presence would ship outcome=null here — the grace must wait for
    // substance, still bounded by REPORT_GRACE_POLLS.
    let getCallCalls = 0;
    const s = await runPhoneCall(
      BODY,
      300,
      deps({
        dial: dialOk("rg3"),
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getCall: async () => {
          getCallCalls += 1;
          return {
            status: "ended",
            // No OUTCOME: marker — the report is the only possible outcome source.
            transcript: { entries: [{ source: "agent", text: "hi" }, { source: "user", text: "yes, 8 works" }] },
            report:
              getCallCalls > 1 ? { outcome: "Table for 4 confirmed at 8pm" } : { outcome: "completed" },
          } as any;
        },
        getSession: async () =>
          ({ status: "ended", endedAt: new Date().toISOString(), phoneCall: { callControlId: "phone-rg3" }, usage: [] }) as any,
      }),
      noopSleep,
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("Table for 4 confirmed at 8pm"); // not null, not the bare "completed"
    expect(getCallCalls).toBe(2); // one read (bare row) + ONE grace poll that caught the real outcome
  });
});

describe("runPhoneCall — serialize guard released on every exit path", () => {
  it("allows a second dial after the first one TIMES OUT", async () => {
    const clock = makeFakeClock();
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
      sleep: clock.sleep,
      now: clock.now,
    };
    const first = await runPhoneCall(BODY, 3, d, clock.sleep);
    expect(first.status).toBe("timeout");
    terminal = true; // same guard, next call must be allowed through AND complete
    const second = await runPhoneCall(BODY, 300, d, clock.sleep);
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
