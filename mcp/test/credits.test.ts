import { describe, expect, it } from "vitest";
import type { Speko } from "@spekoai/sdk";
import { runCredits } from "../src/cli/credits.js";

interface Captured {
  ledgerParams?: Record<string, unknown>;
  getBalanceCalls?: number;
  getLedgerCalls?: number;
}

function fakeSpeko(opts: { throwOnBalance?: boolean } = {}): { speko: Speko; calls: Captured } {
  const calls: Captured = { getBalanceCalls: 0, getLedgerCalls: 0 };
  const speko = {
    credits: {
      getBalance: async () => {
        calls.getBalanceCalls = (calls.getBalanceCalls ?? 0) + 1;
        if (opts.throwOnBalance) throw new Error("upstream 500");
        return { balanceUsd: 12.5, currency: "USD" as const, updatedAt: "2026-07-04T00:00:00.000Z" };
      },
      getLedger: async (params: Record<string, unknown>) => {
        calls.getLedgerCalls = (calls.getLedgerCalls ?? 0) + 1;
        calls.ledgerParams = params;
        return {
          entries: [
            {
              id: "led_1",
              kind: "topup" as const,
              amountMicroUsd: "5000000",
              metric: null,
              provider: null,
              sessionId: null,
              createdAt: "2026-07-03T10:00:00.000Z",
            },
            {
              id: "led_2",
              kind: "debit" as const,
              amountMicroUsd: "-250000",
              metric: "tts",
              provider: "cartesia",
              sessionId: "sess_9",
              createdAt: "2026-07-03T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        };
      },
    },
  } as unknown as Speko;
  return { speko, calls };
}

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (s: string) => void out.push(s) },
    stderr: (line: string) => void err.push(line),
  };
}

describe("runCredits", () => {
  it("prints the balance and does not hit the ledger by default", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runCredits([], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(0);
    expect(calls.getBalanceCalls).toBe(1);
    expect(calls.getLedgerCalls).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("balance: $12.50");
    expect(text).toContain("2026-07-04T00:00:00.000Z");
  });

  it("renders the ledger table with signed amounts and forwards --limit", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runCredits(["--ledger", "--limit", "3"], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(0);
    expect(calls.getLedgerCalls).toBe(1);
    expect(calls.ledgerParams).toEqual({ limit: 3 });
    const text = c.out.join("");
    expect(text).toContain("recent movements (2)");
    expect(text).toContain("topup");
    expect(text).toContain("+$5.00"); // positive topup keeps a leading +
    expect(text).toContain("$-0.2500"); // signed sub-dollar debit at 4 dp
    expect(text).toContain("cartesia"); // provider surfaced
  });

  it("defaults --limit when non-numeric", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runCredits(["--ledger", "--limit", "abc"], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(0);
    expect(calls.ledgerParams).toEqual({ limit: 10 });
  });

  it("emits { balance, ledger } as JSON when --json --ledger", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCredits(["--json", "--ledger"], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(0);
    const json = JSON.parse(c.out.join("").trim());
    expect(json.balance.balanceUsd).toBe(12.5);
    expect(json.ledger.entries[0].id).toBe("led_1");
  });

  it("emits just the balance object as JSON when --json without --ledger", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCredits(["--json"], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(0);
    const json = JSON.parse(c.out.join("").trim());
    expect(json.balanceUsd).toBe(12.5);
    expect(json.ledger).toBeUndefined();
  });

  it("returns exit 1 on API error", async () => {
    const { speko } = fakeSpeko({ throwOnBalance: true });
    const c = cap();
    const code = await runCredits([], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(1);
    expect(c.err.join("")).toContain("credits failed: upstream 500");
    expect(c.out).toEqual([]);
  });

  it("returns exit 2 on an unknown flag", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runCredits(["--bogus"], { speko, stdout: c.stdout, stderr: c.stderr });

    expect(code).toBe(2);
    expect(c.err.join("")).toContain("credits:");
  });
});
