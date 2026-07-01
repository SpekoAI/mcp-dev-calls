/**
 * `speko voices [--provider <p>]` — list the voices/providers the router can pick from.
 * The differentiator vs. vercel-labs/ai-cli (which has no voices catalog). Wraps
 * speko.voices.list(). ElevenLabs voices are account-scoped and not returned here.
 */
import { parseArgs } from "node:util";
import type { Speko } from "@spekoai/sdk";
import { makeSpeko, MissingKeyError } from "./_shared/speko.js";

export interface VoicesDeps {
  speko?: Speko;
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
}

const OPTIONS = {
  provider: { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
} as const;

export async function runVoices(argv: string[], deps: VoicesDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = deps.stdout ?? process.stdout;

  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }).values;
  } catch (e) {
    stderr(`voices: ${(e as Error).message}`);
    return 2;
  }

  let speko = deps.speko;
  if (!speko) {
    try {
      speko = makeSpeko();
    } catch (e) {
      stderr(e instanceof MissingKeyError ? e.message : `voices: ${(e as Error).message}`);
      return 1;
    }
  }

  let result: Awaited<ReturnType<Speko["voices"]["list"]>>;
  try {
    result = await speko.voices.list(values.provider ? { provider: values.provider as string } : {});
  } catch (e) {
    stderr(`voices failed: ${(e as Error).message}`);
    return 1;
  }

  if (values.json) {
    stdout.write(JSON.stringify(result) + "\n");
    return 0;
  }

  const providers = result.providers ?? [];
  const voices = result.voices ?? [];
  const lines: string[] = [];

  if (providers.length) {
    lines.push("Providers (the router auto-picks the best per --optimize-for):");
    for (const p of providers) {
      const models = p.models?.length ? p.models.join(", ") : "-";
      const note = p.voicesFetchedLive ? "  (voices are account-scoped — pass --voice <id>)" : "";
      lines.push(`  ${p.key.padEnd(14)} ${p.name}${note}`);
      lines.push(`  ${" ".repeat(14)} models: ${models}`);
    }
    lines.push("");
  }

  if (voices.length) {
    lines.push(`Voices (${voices.length}):`);
    lines.push(`  ${"vendor".padEnd(14)} ${"id".padEnd(28)} name`);
    for (const v of voices) {
      lines.push(`  ${v.vendor.padEnd(14)} ${v.id.padEnd(28)} ${v.name}`);
    }
  } else {
    lines.push("No standalone voice ids returned (ElevenLabs voices are account-scoped — pass --voice <id> to speak).");
  }

  stdout.write(lines.join("\n") + "\n");
  return 0;
}
