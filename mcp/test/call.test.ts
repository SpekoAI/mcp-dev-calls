import { describe, expect, it } from "vitest";
import type { Speko } from "@spekoai/sdk";
import { runCall } from "../src/cli/call.js";

interface Captured {
  reportId?: string;
  eventsId?: string;
  getId?: string;
}

interface FakeOpts {
  throwOn?: "report" | "events" | "get";
}

function fakeSpeko(opts: FakeOpts = {}): { speko: Speko; calls: Captured } {
  const calls: Captured = {};
  const boom = (): never => {
    throw new Error("boom");
  };
  const speko = {
    calls: {
      report: async (id: string) => {
        calls.reportId = id;
        if (opts.throwOn === "report") return boom();
        return {
          session_id: id,
          summary: "asked about hours, got them",
          outcome: "completed",
          cost_micro_usd: "42000",
          cost_breakdown: [
            { provider: "telnyx", metric: "minutes", quantity: 2, costMicroUsd: "18000" },
            { provider: "cartesia", metric: "characters", quantity: 340, costMicroUsd: "24000" },
          ],
          analysis_status: "completed",
          created_at: "2026-07-01T10:00:00.000Z",
          transcript: { entries: [] },
        };
      },
      events: async (id: string) => {
        calls.eventsId = id;
        if (opts.throwOn === "events") return boom();
        return {
          events: [
            {
              event_type: "dial_answered",
              status: "ok",
              provider: "telnyx",
              occurred_at: "2026-07-01T10:00:05.000Z",
              failure_cause: null,
              sip_status_code: null,
            },
            {
              event_type: "dial_initiated",
              status: "ringing",
              provider: "telnyx",
              occurred_at: "2026-07-01T10:00:00.000Z",
              failure_cause: null,
              sip_status_code: null,
            },
            {
              event_type: "hangup",
              status: "failed",
              provider: "livekit",
              occurred_at: "2026-07-01T10:00:12.000Z",
              failure_cause: "busy",
              sip_status_code: 486,
            },
          ],
        };
      },
      get: async (id: string) => {
        calls.getId = id;
        if (opts.throwOn === "get") return boom();
        return {
          id,
          transcript: {
            entries: [
              { source: "agent", text: "hi, are you open?", started_at: "2026-07-01T10:00:06.000Z" },
              { source: "user", text: "yes until 9pm", started_at: "2026-07-01T10:00:08.000Z" },
            ],
          },
        };
      },
    },
  } as unknown as Speko;
  return { speko, calls };
}

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => void out.push(s) }, stderr: (line: string) => void err.push(line) };
}

const USAGE = "usage: speko call <report|events|transcript> <call-id> [--json]";

describe("runCall", () => {
  it("report: renders outcome/summary/cost + a cost_breakdown table", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runCall(["report", "sess-1"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(calls.reportId).toBe("sess-1");
    const text = c.out.join("");
    expect(text).toContain("completed");
    expect(text).toContain("asked about hours");
    expect(text).toContain("$0.0420"); // 42000 micro-USD, sub-$1 → 4 decimals
    expect(text).toContain("telnyx");
    expect(text).toContain("cost breakdown (2)");
    expect(text).not.toContain("hi, are you open?"); // transcript is NOT dumped here
  });

  it("report --json: emits the raw SDK result", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCall(["report", "sess-1", "--json"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    const json = JSON.parse(c.out.join("").trim());
    expect(json.cost_micro_usd).toBe("42000");
    expect(json.cost_breakdown[0].provider).toBe("telnyx");
  });

  it("events: renders a timeline sorted by occurred_at with deltas + failure/sip", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runCall(["events", "sess-2"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(calls.eventsId).toBe("sess-2");
    const text = c.out.join("");
    expect(text).toContain("timeline (3 events)");
    // sorted: dial_initiated (first) should appear before dial_answered
    expect(text.indexOf("dial_initiated")).toBeLessThan(text.indexOf("dial_answered"));
    expect(text).toContain("+0s"); // first event delta
    expect(text).toContain("+5s"); // dial_answered is 5s after
    expect(text).toContain("+12s"); // hangup is 12s after
    expect(text).toContain("failure=busy");
    expect(text).toContain("sip=486");
  });

  it("events --json: emits the raw SDK result", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCall(["events", "sess-2", "--json"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    const json = JSON.parse(c.out.join("").trim());
    expect(json.events).toHaveLength(3);
  });

  it("transcript: one line per turn from transcript.entries", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runCall(["transcript", "sess-3"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(calls.getId).toBe("sess-3");
    const text = c.out.join("");
    expect(text).toContain("agent: hi, are you open?");
    expect(text).toContain("user: yes until 9pm");
  });

  it("no sub → usage on stderr, exit 2, no stdout", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCall([], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(2);
    expect(c.err).toEqual([USAGE]);
    expect(c.out).toEqual([]);
  });

  it("missing id → usage on stderr, exit 2", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCall(["report"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(2);
    expect(c.err).toEqual([USAGE]);
    expect(c.out).toEqual([]);
  });

  it("unknown sub → usage on stderr, exit 2", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCall(["summary", "sess-1"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(2);
    expect(c.err).toEqual([USAGE]);
    expect(c.out).toEqual([]);
  });

  it("API error → 'call failed' on stderr, exit 1", async () => {
    const { speko } = fakeSpeko({ throwOn: "report" });
    const c = cap();
    const code = await runCall(["report", "sess-1"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(1);
    expect(c.err.join("")).toContain("call failed: boom");
    expect(c.out).toEqual([]);
  });
});
