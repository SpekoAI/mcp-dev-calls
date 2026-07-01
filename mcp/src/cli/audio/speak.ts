/**
 * `speko audio speak "<text>"` — text-to-speech.
 * Thin wrapper over speko.synthesize(). Mirrors vercel-labs/ai-cli: stdin support,
 * predictable artifact (<id>.<ext>), save-then-play interactively, raw bytes to stdout
 * when piped, and it prints WHICH provider the router picked (our differentiator).
 */
import { parseArgs } from "node:util";
import { statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Speko } from "@spekoai/sdk";
import { makeSpeko, MissingKeyError } from "../_shared/speko.js";
import { toPlayable } from "../_shared/audio.js";
import { resolveOutTarget } from "../_shared/artifact.js";
import { randomId, readStdinText } from "../_shared/io.js";
import { playFile } from "../_shared/play.js";

type SynthesizeOptions = Parameters<Speko["synthesize"]>[1];
type OptimizeFor = NonNullable<SynthesizeOptions["optimizeFor"]>;

export interface SpeakDeps {
  speko?: Speko;
  stdout?: { write: (chunk: Uint8Array | string) => void };
  stderr?: (line: string) => void;
  writeFile?: (path: string, bytes: Uint8Array) => void;
  play?: (path: string) => Promise<boolean>;
  isTTY?: boolean;
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  cwd?: string;
  id?: string;
}

const OPTIMIZE = new Set(["balanced", "accuracy", "latency", "cost"]);

const OPTIONS = {
  lang: { type: "string" },
  "optimize-for": { type: "string" },
  voice: { type: "string" },
  model: { type: "string" },
  provider: { type: "string" },
  speed: { type: "string" },
  region: { type: "string" },
  output: { type: "string", short: "o" },
  format: { type: "string", short: "f" },
  "no-play": { type: "boolean" },
  "no-waveform": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
} as const;

export async function runSpeak(argv: string[], deps: SpeakDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = deps.stdout ?? process.stdout;

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    stderr(`speak: ${(e as Error).message}`);
    return 2;
  }

  // Text: positional args, else piped stdin.
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  let text = positionals.join(" ").trim();
  if (!text && !stdinIsTTY) {
    text = (await (deps.readStdin ?? readStdinText)()).trim();
  }
  if (!text) {
    stderr('speak: no text given. usage: speko audio speak "your text"  (or pipe text via stdin)');
    return 2;
  }

  const optimizeFor = values["optimize-for"] as string | undefined;
  if (optimizeFor && !OPTIMIZE.has(optimizeFor)) {
    stderr(`speak: --optimize-for must be one of ${[...OPTIMIZE].join(" | ")}`);
    return 2;
  }
  let speed: number | undefined;
  if (values.speed !== undefined) {
    speed = Number(values.speed);
    if (!Number.isFinite(speed) || speed <= 0) {
      stderr("speak: --speed must be a positive number");
      return 2;
    }
  }

  const opts = { language: (values.lang as string | undefined) || "en" } as SynthesizeOptions;
  if (optimizeFor) opts.optimizeFor = optimizeFor as OptimizeFor;
  if (values.region) opts.region = values.region as string;
  if (values.voice) opts.voice = values.voice as string;
  if (values.model) opts.model = values.model as string;
  if (speed !== undefined) opts.speed = speed;
  if (values.provider) opts.constraints = { allowedProviders: { tts: [values.provider as string] } };

  let speko = deps.speko;
  if (!speko) {
    try {
      speko = makeSpeko();
    } catch (e) {
      stderr(e instanceof MissingKeyError ? e.message : `speak: ${(e as Error).message}`);
      return 1;
    }
  }

  let result: Awaited<ReturnType<Speko["synthesize"]>>;
  try {
    result = await speko.synthesize(text, opts);
  } catch (e) {
    stderr(`speak failed: ${(e as Error).message}`);
    return 1;
  }

  const { bytes, ext: derivedExt } = toPlayable(result.audio, result.contentType);
  const ext = (values.format as string | undefined) || derivedExt;
  const routed = `via ${result.provider}:${result.model} · failover ${result.failoverCount}`;

  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  let outIsDir = false;
  if (values.output) {
    try {
      outIsDir = statSync(values.output as string).isDirectory();
    } catch {
      outIsDir = false;
    }
  }
  const target = resolveOutTarget({
    out: values.output as string | undefined,
    outIsDir,
    isTTY,
    ext,
    id: deps.id ?? randomId(),
    outputDir: process.env.SPEKO_OUTPUT_DIR,
    cwd: deps.cwd ?? process.cwd(),
  });

  if (target.mode === "stdout") {
    stdout.write(bytes);
    if (!values.quiet) stderr(routed);
    return 0;
  }

  const path = resolvePath(target.path as string);
  (deps.writeFile ?? ((p, b) => writeFileSync(p, b)))(path, bytes);

  if (values.json) {
    stdout.write(
      JSON.stringify({
        file: path,
        provider: result.provider,
        model: result.model,
        contentType: result.contentType,
        failoverCount: result.failoverCount,
      }) + "\n",
    );
  } else if (!values.quiet) {
    stderr(`✓ ${path}  (${routed})`);
  }

  if (isTTY && !values["no-play"]) {
    let played = false;
    try {
      played = await (deps.play ?? ((p) => playFile(p)))(path);
    } catch {
      played = false; // playback is best-effort — a player crash must never fail the command
    }
    if (!played && !values.quiet) stderr("(no audio player on PATH — saved the file above)");
  }
  return 0;
}
