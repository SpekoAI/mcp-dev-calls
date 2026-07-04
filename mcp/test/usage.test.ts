import { describe, expect, it } from "vitest";
import type { Speko } from "@spekoai/sdk";
import { runUsage } from "../src/cli/usage.js";

interface Captured {
  called?: boolean;
}

function fakeSpeko(): { speko: Speko; calls: Captured } {
  const calls: Captured = {};
  const speko = {
    usage: {
      get: async () => {
        calls.called = true;
        return {
          totalSessions: 3,
          totalMinutes: 12.34,
          totalCost: 1.5,
          balanceUsd: 8.25,
          currency: "USD",
          breakdown: [
            { provider: "cartesia", type: "tts", metric: "chars", keySource: "MANAGED", quantity: 1200, cost: 0.42 },
            { provider: "deepgram", type: "stt", metric: "minutes", keySource: "BYOK", quantity: 12, cost: 0 },
          ],
        };
      },
    },
  } as unknown as Speko;
  return { speko, calls };
}

function emptySpeko(): { speko: Speko } {
  const speko = {
    usage: {
      get: async () => ({
        totalSessions: 0,
        totalMinutes: 0,
        totalCost: 0,
        balanceUsd: 0,
        currency: "USD",
        breakdown: [],
      }),
    },
  } as unknown as Speko;
  return { speko };
}

function throwingSpeko(): Speko {
  return {
    usage: {
      get: async () => {
        throw new Error("boom");
      },
    },
  } as unknown as Speko;
}

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => void out.push(s) }, stderr: (l: string) => void err.push(l) };
}

describe("runUsage", () => {
  it("renders the summary header and per-provider breakdown", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runUsage([], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(calls.called).toBe(true);
    const text = c.out.join("");
    expect(text).toContain("sessions 3");
    expect(text).toContain("minutes 12.3"); // rounded to 1 dp
    expect(text).toContain("cost $1.50");
    expect(text).toContain("bal $8.25");
    expect(text).toMatch(/cartesia/);
    expect(text).toMatch(/deepgram/);
    expect(text).toContain("$0.42");
  });

  it("says 'no usage this period' when the breakdown is empty", async () => {
    const { speko } = emptySpeko();
    const c = cap();
    const code = await runUsage([], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(c.out.join("")).toContain("no usage this period");
  });

  it("emits JSON with --json that round-trips", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runUsage(["--json"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    const json = JSON.parse(c.out.join("").trim());
    expect(json.totalSessions).toBe(3);
    expect(json.balanceUsd).toBe(8.25);
    expect(json.breakdown[0].provider).toBe("cartesia");
  });

  it("returns exit 1 and reports the message when the API rejects", async () => {
    const speko = throwingSpeko();
    const c = cap();
    const code = await runUsage([], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(1);
    expect(c.err).toEqual(["usage failed: boom"]);
    expect(c.out).toEqual([]);
  });

  it("does not crash when the live API returns breakdown rows with null fields (regression)", async () => {
    // The real UsageSummary can return rows whose provider/type/metric are null even though the
    // SDK type marks them required — the human table must render "-", not throw on .padEnd(undefined).
    const speko = {
      usage: {
        get: async () => ({
          totalSessions: 1,
          totalMinutes: 0.5,
          totalCost: 0.01,
          balanceUsd: 5,
          currency: "USD",
          breakdown: [{ provider: null, type: null, metric: null, keySource: "MANAGED", quantity: 3, cost: 0.01 }],
        }),
      },
    } as unknown as Speko;
    const c = cap();
    const code = await runUsage([], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out.join("")).toContain("-"); // null fields rendered as "-"
  });

  it("returns exit 2 on an unknown flag", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runUsage(["--nope"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(2);
    expect(c.out).toEqual([]);
  });
});
