/**
 * `speko usage` — show this billing period's usage: sessions, minutes, spend, credit
 * balance, and a per-provider breakdown. Wraps speko.usage.get() (UsageSummary).
 * totalCost / balanceUsd are plain USD numbers straight from the API — no markup math.
 */
import { parseArgs } from "node:util";
import type { Speko } from "@spekoai/sdk";
import { makeSpeko, MissingKeyError } from "./_shared/speko.js";

export interface UsageDeps {
  speko?: Speko;
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
}

const OPTIONS = {
  json: { type: "boolean" },
} as const;

/** Plain-USD number → "$x.xx". UsageSummary reports dollars, not micro-USD, so no /1e6 here. */
const usd = (dollars: number): string => `$${(dollars ?? 0).toFixed(2)}`;

export async function runUsage(argv: string[], deps: UsageDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = deps.stdout ?? process.stdout;

  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }).values;
  } catch (e) {
    stderr(`usage: ${(e as Error).message}`);
    return 2;
  }

  let speko = deps.speko;
  if (!speko) {
    try {
      speko = makeSpeko();
    } catch (e) {
      stderr(e instanceof MissingKeyError ? e.message : `usage: ${(e as Error).message}`);
      return 1;
    }
  }

  let result: Awaited<ReturnType<Speko["usage"]["get"]>>;
  try {
    result = await speko.usage.get();
  } catch (e) {
    stderr(`usage failed: ${(e as Error).message}`);
    return 1;
  }

  if (values.json) {
    stdout.write(JSON.stringify(result) + "\n");
    return 0;
  }

  const breakdown = result.breakdown ?? [];
  const lines: string[] = [];

  lines.push(
    `sessions ${result.totalSessions ?? 0}  ` +
      `minutes ${(result.totalMinutes ?? 0).toFixed(1)}  ` +
      `cost ${usd(result.totalCost)}  ` +
      `bal ${usd(result.balanceUsd)}`,
  );

  if (breakdown.length) {
    lines.push("");
    lines.push(
      `  ${"provider".padEnd(14)} ${"type".padEnd(5)} ${"metric".padEnd(16)} ${"qty".padStart(10)} ${"cost".padStart(10)}`,
    );
    for (const b of breakdown) {
      // Coerce every field defensively: the live API returns rows whose provider/type/metric
      // can be null even though the SDK type marks them required (never trust external data).
      lines.push(
        `  ${String(b.provider ?? "-").padEnd(14)} ${String(b.type ?? "-").padEnd(5)} ${String(b.metric ?? "-").padEnd(16)} ` +
          `${String(b.quantity ?? 0).padStart(10)} ${usd(b.cost ?? 0).padStart(10)}`,
      );
    }
  } else {
    lines.push("no usage this period");
  }

  stdout.write(lines.join("\n") + "\n");
  return 0;
}
