/**
 * `speko audio transcribe <file|url|->` — speech-to-text.
 * Thin wrapper over speko.transcribe(). Accepts a file path, http(s)/file URL, or piped
 * stdin bytes. Prints the transcript to stdout (pipe-clean); provider/model/confidence to
 * stderr. Mirrors vercel-labs/ai-cli's input flexibility + artifact behavior.
 */
import { parseArgs } from "node:util";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Speko } from "@spekoai/sdk";
import { makeSpeko, MissingKeyError } from "../_shared/speko.js";
import { guessAudioContentType } from "../_shared/audio.js";
import { resolveOutTarget } from "../_shared/artifact.js";
import { randomId, readStdinBytes } from "../_shared/io.js";

type TranscribeOptions = Parameters<Speko["transcribe"]>[1];
type OptimizeFor = NonNullable<TranscribeOptions["optimizeFor"]>;

export interface TranscribeDeps {
  speko?: Speko;
  stdout?: { write: (chunk: string) => void };
  stderr?: (line: string) => void;
  readFile?: (path: string) => Uint8Array;
  readStdin?: () => Promise<Uint8Array>;
  fetchUrl?: (url: string) => Promise<Uint8Array>;
  writeFile?: (path: string, text: string) => void;
  isTTY?: boolean;
  stdinIsTTY?: boolean;
  cwd?: string;
  id?: string;
}

const OPTIMIZE = new Set(["balanced", "accuracy", "latency", "cost"]);

const OPTIONS = {
  lang: { type: "string" },
  "optimize-for": { type: "string" },
  "content-type": { type: "string" },
  keywords: { type: "string" },
  provider: { type: "string" },
  output: { type: "string", short: "o" },
  format: { type: "string", short: "f" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
} as const;

async function defaultFetch(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function runTranscribe(argv: string[], deps: TranscribeDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = deps.stdout ?? process.stdout;

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    stderr(`transcribe: ${(e as Error).message}`);
    return 2;
  }

  const input = positionals[0];
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!input && stdinIsTTY) {
    stderr("transcribe: no input. usage: speko audio transcribe <file|url>  (or pipe audio via stdin)");
    return 2;
  }

  const optimizeFor = values["optimize-for"] as string | undefined;
  if (optimizeFor && !OPTIMIZE.has(optimizeFor)) {
    stderr(`transcribe: --optimize-for must be one of ${[...OPTIMIZE].join(" | ")}`);
    return 2;
  }

  // Resolve the audio bytes from file / URL / stdin.
  let audio: Uint8Array;
  let sourceForCt: string | undefined;
  try {
    if (input) {
      if (/^https?:\/\//i.test(input)) {
        audio = await (deps.fetchUrl ?? defaultFetch)(input);
        sourceForCt = input;
      } else {
        const path = input.startsWith("file://") ? fileURLToPath(input) : input;
        audio = (deps.readFile ?? ((p) => readFileSync(p)))(path);
        sourceForCt = path;
      }
    } else {
      audio = await (deps.readStdin ?? readStdinBytes)();
    }
  } catch (e) {
    stderr(`transcribe: could not read audio: ${(e as Error).message}`);
    return 1;
  }
  if (!audio || audio.length === 0) {
    stderr("transcribe: empty audio input");
    return 2;
  }

  const contentType =
    (values["content-type"] as string | undefined) ||
    (sourceForCt ? guessAudioContentType(sourceForCt) : undefined);

  const opts = { language: (values.lang as string | undefined) || "en" } as TranscribeOptions;
  if (optimizeFor) opts.optimizeFor = optimizeFor as OptimizeFor;
  if (contentType) opts.contentType = contentType;
  if (values.keywords) {
    const kw = (values.keywords as string).split(",").map((s) => s.trim()).filter(Boolean);
    if (kw.length) opts.keywords = kw;
  }
  if (values.provider) opts.constraints = { allowedProviders: { stt: [values.provider as string] } };

  let speko = deps.speko;
  if (!speko) {
    try {
      speko = makeSpeko();
    } catch (e) {
      stderr(e instanceof MissingKeyError ? e.message : `transcribe: ${(e as Error).message}`);
      return 1;
    }
  }

  let result: Awaited<ReturnType<Speko["transcribe"]>>;
  try {
    result = await speko.transcribe(audio, opts);
  } catch (e) {
    stderr(`transcribe failed: ${(e as Error).message}`);
    return 1;
  }

  const text = result.text ?? "";
  const conf = typeof result.confidence === "number" ? ` · conf ${result.confidence.toFixed(2)}` : "";
  const routed = `via ${result.provider}:${result.model}${conf} · failover ${result.failoverCount}`;

  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  let outIsDir = false;
  if (values.output) {
    try {
      outIsDir = statSync(values.output as string).isDirectory();
    } catch {
      outIsDir = false;
    }
  }
  const ext = values.format === "md" ? "md" : "txt";
  const target = resolveOutTarget({
    out: values.output as string | undefined,
    outIsDir,
    isTTY,
    ext,
    id: deps.id ?? randomId(),
    outputDir: process.env.SPEKO_OUTPUT_DIR,
    cwd: deps.cwd ?? process.cwd(),
  });

  // Persist a file when in file mode. Under --json we only write when the user gave an explicit
  // -o (the transcript is already in the JSON payload, so don't spring a surprise <id>.txt);
  // without --json, interactive mode auto-writes <id>.txt as the predictable artifact.
  let writtenPath: string | undefined;
  if (target.mode === "file" && (Boolean(values.output) || !values.json)) {
    writtenPath = resolvePath(target.path as string);
    (deps.writeFile ?? ((p, t) => writeFileSync(p, t)))(writtenPath, text);
  }

  if (values.json) {
    stdout.write(
      JSON.stringify({
        text,
        provider: result.provider,
        model: result.model,
        confidence: result.confidence,
        failoverCount: result.failoverCount,
        ...(writtenPath ? { file: writtenPath } : {}),
      }) + "\n",
    );
    return 0;
  }

  // Surface the transcript on stdout (pipe-clean); note any persisted file on stderr.
  stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (writtenPath && !values.quiet) stderr(`✓ ${writtenPath}  (${routed})`);
  else if (!values.quiet) stderr(routed);
  return 0;
}
