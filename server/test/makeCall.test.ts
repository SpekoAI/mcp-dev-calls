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
