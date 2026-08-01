import { describe, expect, it } from "vitest";
import { describeCall } from "../src/calls/getCall.js";
import { READBACK_PREFIX, READBACK_SUFFIX } from "../src/calls/callMePrompt.js";
import { getOwnerBusy, setOwnerBusy } from "../src/calls/callMeResult.js";
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

describe("describeCall — get_call parity fixes (H4 dialed number, H5 trunk reason)", () => {
  it("surfaces dialed_number/caller_id from metadata (H4)", async () => {
    const s = await describeCall(
      "meta1",
      client({
        getCall: async () =>
          ({
            status: "completed",
            transcript: withUserTurn,
            report: null,
            ended_at: new Date().toISOString(),
            created_at: new Date(Date.now() - 60_000).toISOString(),
            duration_seconds: 50,
            metadata: { to: "+14152857117", from: "+15312160099" },
          }) as any,
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: "x" }, usage: [] }) as any,
      }),
    );
    expect(s.dialed_number).toBe("+14152857117");
    expect(s.caller_id).toBe("+15312160099");
  });

  it("blames the trunk on a hard-failure event, matching make_call (H5)", async () => {
    const s = await describeCall(
      "trunk1",
      client({
        getCall: async () =>
          ({
            status: "failed",
            transcript: { entries: [{ source: "agent", text: "..." }] }, // agent-only → not answered
            report: null,
            ended_at: new Date().toISOString(),
            created_at: new Date(Date.now() - 5_000).toISOString(),
            duration_seconds: 0,
            metadata: {},
          }) as any,
        getEvents: async () => [{ event_type: "sip.dial_failed" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
    );
    expect(s.status).toBe("not_connected");
    expect(s.reason).toMatch(/trunk|will not help/i);
  });

  it("reports a plain destination no-answer WITHOUT blaming the trunk (H5)", async () => {
    const s = await describeCall(
      "noans1",
      client({
        getCall: async () =>
          ({
            status: "completed",
            transcript: { entries: [{ source: "agent", text: "..." }] },
            report: null,
            ended_at: new Date().toISOString(),
            created_at: new Date(Date.now() - 20_000).toISOString(),
            duration_seconds: 0,
            metadata: {},
          }) as any,
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: null }, usage: [] }) as any,
      }),
    );
    expect(s.status).toBe("not_connected");
    expect(s.reason).not.toMatch(/failed to dial|will not help/i);
  });
});

describe("describeCall - call_me recovery", () => {
  const metadata = {
    source: "speko-mcp-calls/call_me",
    call_me_mode: "converse",
    call_me_message: "Which environment should I deploy?",
    call_me_context: "platform repo",
    call_me_instance_id: "11111111-2222-4333-8444-555555555555",
    to: "+13463760044",
    from: "+15312160099",
  };

  it("reconstructs confirmation fields from persisted metadata + attributed transcript", async () => {
    setOwnerBusy("+13463760044", { callId: "owner_done", expiresAt: Date.now() + 60_000 });
    const s = await describeCall(
      "owner_done",
      client({
        getCall: async () => ({
          status: "completed",
          transcript: {
            entries: [
              {
                source: "agent",
                text: `${READBACK_PREFIX} Deploy staging. ${READBACK_SUFFIX}`,
              },
              { source: "user", text: "CONFIRMED" },
            ],
          },
          report: { outcome: "owner replied" },
          ended_at: new Date().toISOString(),
          created_at: new Date(Date.now() - 30_000).toISOString(),
          duration_seconds: 28,
          metadata,
        }) as any,
        getEvents: async () => [{ event_type: "room_finished" }] as any,
        getSession: async () => ({ phoneCall: { callControlId: "phone_1" }, usage: [] }) as any,
      }),
    );
    expect(s).toMatchObject({
      status: "completed",
      message: "Which environment should I deploy?",
      confirmation: "confirmed",
      final_instruction: "Deploy staging",
    });
    expect(s.owner_reply).toContain("OWNER_REPLY (voice transcript, speaker unverified)");
    expect(getOwnerBusy("+13463760044")).toBeUndefined();
  });

  it("keeps a live call nonterminal and tells the agent to poll without redialing", async () => {
    const s = await describeCall(
      "owner_live",
      client({
        getCall: async () => ({
          status: "dialing",
          transcript: { entries: [] },
          report: null,
          ended_at: null,
          created_at: new Date(Date.now() - 5_000).toISOString(),
          duration_seconds: null,
          metadata,
        }) as any,
        getEvents: async () => [] as any,
        getSession: async () => ({ phoneCall: { callControlId: "phone_1" }, usage: [] }) as any,
      }),
    );
    expect(s.status).toBe("in_progress");
    expect(s.confirmation).toBeUndefined();
    expect(s.message).toBe("Which environment should I deploy?");
    expect(s.next_step).toContain("get_call('owner_live')");
    expect(s.next_step).toContain("Do not place another call");
  });
});
