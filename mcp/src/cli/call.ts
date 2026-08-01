/**
 * `speko call <report|events|transcript|recording> <call-id> [--json]` — inspect a finished call.
 * report → speko.calls.report(id) (outcome/summary/cost + cost_breakdown table);
 * events → speko.calls.events(id) (a sorted "speech diagram" timeline);
 * transcript → speko.calls.get(id) (one line per turn from transcript.entries);
 * recording → speko.calls.recording(id) (the audio recording URL, pipe-friendly).
 */
import { parseArgs } from "node:util";
import type { Speko } from "@spekoai/sdk";
import { makeSpeko, MissingKeyError } from "./_shared/speko.js";

export interface CallDeps {
  speko?: Speko;
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
}

const OPTIONS = {
  json: { type: "boolean" },
} as const;

const SUBS = ["report", "events", "transcript", "recording"] as const;
type Sub = (typeof SUBS)[number];

const USAGE = "usage: speko call <report|events|transcript|recording> <call-id> [--json]";

/** Micro-USD (string|number) → a $-prefixed display value. More precision under $1. */
const usd = (micro: string | number): string =>
  `$${(Number(micro) / 1e6).toFixed(Math.abs(Number(micro) / 1e6) < 1 ? 4 : 2)}`;

function isSub(v: string | undefined): v is Sub {
  return typeof v === "string" && (SUBS as readonly string[]).includes(v);
}

// Null-safe: the live API can return null in fields the SDK types mark required, and String(null)
// would print the literal "null" in a column — render "-" instead (never trust external data).
function pad(v: string | number | null | undefined, n: number): string {
  return String(v ?? "-").padEnd(n);
}

/** HH:MM:SS from an ISO timestamp; "-" if missing, the raw value if unparseable. */
function clock(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString().slice(11, 19);
}

export async function runCall(argv: string[], deps: CallDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = deps.stdout ?? process.stdout;

  let values: Record<string, boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    stderr(`call: ${(e as Error).message}`);
    return 2;
  }

  const sub = positionals[0];
  const id = positionals[1];
  if (!isSub(sub)) {
    stderr(USAGE);
    return 2;
  }
  if (!id) {
    stderr(USAGE);
    return 2;
  }

  let speko = deps.speko;
  if (!speko) {
    try {
      speko = makeSpeko();
    } catch (e) {
      stderr(e instanceof MissingKeyError ? e.message : `call: ${(e as Error).message}`);
      return 1;
    }
  }

  const lines: string[] = [];
  try {
    if (sub === "report") {
      const report = await speko.calls.report(id);
      if (values.json) {
        stdout.write(JSON.stringify(report) + "\n");
        return 0;
      }
      lines.push(`outcome:         ${report.outcome ?? "-"}`);
      lines.push(`summary:         ${report.summary ?? "-"}`);
      lines.push(`cost:            ${usd(report.cost_micro_usd)}`);
      lines.push(`analysis_status: ${report.analysis_status ?? "-"}`);
      lines.push(`created_at:      ${report.created_at ?? "-"}`);
      const breakdown = report.cost_breakdown ?? [];
      if (breakdown.length) {
        lines.push("");
        lines.push(`cost breakdown (${breakdown.length}):`);
        lines.push(`  ${pad("provider", 14)} ${pad("metric", 20)} ${pad("qty", 10)} cost`);
        for (const line of breakdown) {
          lines.push(
            `  ${pad(line.provider, 14)} ${pad(line.metric, 20)} ${pad(line.quantity, 10)} ${usd(line.costMicroUsd)}`,
          );
        }
      }
    } else if (sub === "events") {
      const result = await speko.calls.events(id);
      if (values.json) {
        stdout.write(JSON.stringify(result) + "\n");
        return 0;
      }
      // Sort by timestamp; null/unparseable occurred_at sorts to the END deterministically
      // (a NaN comparator result gives implementation-defined ordering across JS engines).
      const ts = (e: { occurred_at: string | null }): number => {
        const t = Date.parse(e.occurred_at ?? "");
        return Number.isNaN(t) ? Infinity : t;
      };
      const events = [...(result.events ?? [])].sort((a, b) => ts(a) - ts(b));
      if (!events.length) {
        lines.push("no events");
      } else {
        const t0 = Date.parse(events[0].occurred_at);
        lines.push(`timeline (${events.length} events):`);
        for (const ev of events) {
          // Guard t0 AND the per-event timestamp: a single unparseable occurred_at must render
          // "+0s", never "+NaNs" (Math.max(0, NaN) is NaN, so the NaN check has to come first).
          const evMs = Date.parse(ev.occurred_at);
          const delta =
            Number.isNaN(t0) || Number.isNaN(evMs) ? 0 : Math.max(0, Math.round((evMs - t0) / 1000));
          const parts = [
            clock(ev.occurred_at),
            `+${delta}s`.padStart(5),
            pad(ev.provider, 10),
            pad(ev.event_type, 22),
            ev.status ?? "-",
          ];
          if (ev.failure_cause) parts.push(`failure=${ev.failure_cause}`);
          if (ev.sip_status_code !== null && ev.sip_status_code !== undefined) parts.push(`sip=${ev.sip_status_code}`);
          lines.push(`  ${parts.join("  ")}`);
        }
      }
    } else if (sub === "recording") {
      const recording = await speko.calls.recording(id);
      if (values.json) {
        stdout.write(JSON.stringify(recording) + "\n");
        return 0;
      }
      if (!recording.url) {
        stderr("call: no recording is available for this call.");
        return 1;
      }
      // Bare URL on stdout so it pipes cleanly (curl/open/afplay).
      lines.push(recording.url);
    } else {
      const detail = await speko.calls.get(id);
      if (values.json) {
        stdout.write(JSON.stringify(detail) + "\n");
        return 0;
      }
      const entries = detail.transcript?.entries ?? [];
      if (!entries.length) {
        lines.push("no transcript");
      } else {
        for (const turn of entries) {
          lines.push(`${turn.source ?? "-"}: ${turn.text ?? ""}`);
        }
      }
    }
  } catch (e) {
    stderr(`call failed: ${(e as Error).message}`);
    return 1;
  }

  stdout.write(lines.join("\n") + "\n");
  return 0;
}
