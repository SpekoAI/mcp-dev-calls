/**
 * `speko credits [--ledger] [--limit <n>]` — show the org's prepaid balance, and
 * optionally a page of recent credit movements. Wraps speko.credits.getBalance()
 * (and speko.credits.getLedger({ limit }) with --ledger). Balance is USD; ledger
 * amounts are SIGNED micro-USD strings straight from the API.
 */
import { parseArgs } from "node:util";
import type { Speko } from "@spekoai/sdk";
import { makeSpeko, MissingKeyError } from "./_shared/speko.js";

export interface CreditsDeps {
  speko?: Speko;
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
}

const OPTIONS = {
  json: { type: "boolean" },
  ledger: { type: "boolean" },
  limit: { type: "string" },
} as const;

const DEFAULT_LIMIT = 10;

/** micro-USD (string|number) → "$X.XX" (4 dp for sub-dollar, 2 dp otherwise). */
const usd = (micro: string | number): string =>
  `$${(Number(micro) / 1e6).toFixed(Math.abs(Number(micro) / 1e6) < 1 ? 4 : 2)}`;

/** Parse --limit to a positive int; non-numeric or non-positive falls back to the default. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

export async function runCredits(argv: string[], deps: CreditsDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = deps.stdout ?? process.stdout;

  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }).values;
  } catch (e) {
    stderr(`credits: ${(e as Error).message}`);
    return 2;
  }

  let speko = deps.speko;
  if (!speko) {
    try {
      speko = makeSpeko();
    } catch (e) {
      stderr(e instanceof MissingKeyError ? e.message : `credits: ${(e as Error).message}`);
      return 1;
    }
  }

  const wantLedger = values.ledger === true;
  const limit = parseLimit(values.limit as string | undefined);

  let balance: Awaited<ReturnType<Speko["credits"]["getBalance"]>>;
  let ledger: Awaited<ReturnType<Speko["credits"]["getLedger"]>> | undefined;
  try {
    balance = await speko.credits.getBalance();
    if (wantLedger) {
      ledger = await speko.credits.getLedger({ limit });
    }
  } catch (e) {
    stderr(`credits failed: ${(e as Error).message}`);
    return 1;
  }

  if (values.json) {
    stdout.write(JSON.stringify(wantLedger ? { balance, ledger } : balance) + "\n");
    return 0;
  }

  const lines: string[] = [];
  lines.push(`balance: $${balance.balanceUsd.toFixed(2)}  (updated ${balance.updatedAt})`);

  if (wantLedger) {
    const entries = ledger?.entries ?? [];
    lines.push("");
    if (entries.length) {
      lines.push(`recent movements (${entries.length}):`);
      lines.push(`  ${"when".padEnd(26)} ${"kind".padEnd(11)} ${"amount".padStart(12)}  provider/metric`);
      for (const e of entries) {
        // Sign OUTSIDE the "$" so the right-aligned column lines up: "+$5.00" / "-$0.2500"
        // (usd() formats the absolute value; we prepend the sign).
        const micro = Number(e.amountMicroUsd);
        const amount = `${micro >= 0 ? "+" : "-"}${usd(Math.abs(micro))}`;
        const tag = e.provider ?? e.metric ?? "-";
        lines.push(
          `  ${String(e.createdAt ?? "-").padEnd(26)} ${String(e.kind ?? "-").padEnd(11)} ${amount.padStart(12)}  ${tag}`,
        );
      }
    } else {
      lines.push("no credit movements yet.");
    }
  }

  stdout.write(lines.join("\n") + "\n");
  return 0;
}
