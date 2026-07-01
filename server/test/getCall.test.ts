import { describe, expect, it } from "vitest";
import { describeCall } from "../src/calls/getCall.js";
import type { SpekoClient } from "../src/speko/client.js";

function client(overrides: Partial<SpekoClient>): SpekoClient {
  return overrides as unknown as SpekoClient;
}

const withUserTurn = {
  entries: [
    { source: "agent", text: "Hi, this is Bruce's assistant." },
    { source: "user", text: "sure, we've got 8pm" },
  ],
};

describe("describeCall — terminality gate (A2: no stale 'completed' on a LIVE call)", () => {
  it("reports a live call (no room-end event, ended_at null) as in_progress — not completed/0s/outcome", async () => {
    const s = await describeCall(
      "live1",
      client({
        getCall: async () =>
          ({
            status: "failed", // premature first-audio SLA flag while the call is still live
            transcript: withUserTurn,
            report: { outcome: "Table booked at 8pm" }, // a report can exist before teardown
            ended_at: null,
            created_at: new Date(Date.now() - 40_000).toISOString(),
            duration_seconds: null,
            metadata: { to: "+16500000000", from: "+15312160099" },
          }) as any,
        // NO room_finished / hard-failure event → the call has NOT ended
        getEvents: async () =>
          [{ event_type: "sip.dial_started" }, { event_type: "worker.first_agent_audio" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
    );
    expect(s.status).toBe("in_progress");
    expect(s.outcome).toBeNull(); // never surface an outcome mid-call
    expect(s.connected).toBe(true); // a user turn proves it connected
    expect(s.duration_seconds).toBeGreaterThan(0); // live elapsed, not a bogus 0 masquerading as finished
  });

  it("reports a truly ended call (room_finished present) as completed with its outcome", async () => {
    const s = await describeCall(
      "done1",
      client({
        getCall: async () =>
          ({
            status: "failed",
            transcript: withUserTurn,
            report: { outcome: "Table booked at 8pm" },
            ended_at: new Date().toISOString(),
            created_at: new Date(Date.now() - 90_000).toISOString(),
            duration_seconds: 88,
            metadata: {},
          }) as any,
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
    );
    expect(s.status).toBe("completed");
    expect(s.outcome).toBe("Table booked at 8pm");
    expect(s.duration_seconds).toBe(88);
  });

  it("attaches a /sessions/{id} dashboard deep link when a base URL is provided (E3)", async () => {
    const mk = () =>
      client({
        getCall: async () =>
          ({
            status: "completed",
            transcript: withUserTurn,
            report: null,
            ended_at: new Date().toISOString(),
            created_at: new Date(Date.now() - 60_000).toISOString(),
            duration_seconds: 50,
            metadata: {},
          }) as any,
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      });
    const withUrl = await describeCall("call-xyz", mk(), "https://platform.speko.dev");
    expect(withUrl.dashboard_url).toBe("https://platform.speko.dev/sessions/call-xyz");
    const noUrl = await describeCall("call-xyz", mk());
    expect(noUrl.dashboard_url).toBeUndefined();
  });

  it("treats ended_at as terminal even when the events endpoint is unavailable", async () => {
    const s = await describeCall(
      "done2",
      client({
        getCall: async () =>
          ({
            status: "completed",
            transcript: withUserTurn,
            report: null,
            ended_at: new Date().toISOString(),
            created_at: new Date(Date.now() - 60_000).toISOString(),
            duration_seconds: 55,
            metadata: {},
          }) as any,
        getEvents: async () => {
          throw new Error("events endpoint down");
        },
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
    );
    expect(s.status).toBe("completed");
    expect(s.duration_seconds).toBe(55);
  });
});
