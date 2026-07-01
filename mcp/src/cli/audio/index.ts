/**
 * `speko-calls audio ...` subrouter — mirrors `ai audio {speak,transcribe}`.
 */
import { runSpeak } from "./speak.js";
import { runTranscribe } from "./transcribe.js";

const HELP =
  "speko-calls audio — voice from your terminal (Speko auto-routes to the best provider)\n\n" +
  "Usage:\n" +
  '  speko-calls audio speak "<text>" [--voice <id>] [--optimize-for latency|balanced|accuracy|cost]\n' +
  "                                   [--provider <p>] [--model <m>] [--speed <n>] [--lang <code>]\n" +
  "                                   [-o <out>] [--format wav|mp3] [--no-play] [--json] [-q]\n" +
  "  speko-calls audio transcribe <file|url|-> [--lang <code>] [--keywords a,b,c] [--content-type <mime>]\n" +
  "                                   [--optimize-for ...] [--provider <p>] [-o <out>] [--format txt|md] [--json] [-q]\n\n" +
  "Pipes:\n" +
  '  echo "ship it" | speko-calls audio speak\n' +
  "  cat rec.wav | speko-calls audio transcribe\n" +
  '  speko-calls audio speak "read this back" | speko-calls audio transcribe\n';

export async function runAudio(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "speak") return runSpeak(argv.slice(1));
  if (sub === "transcribe") return runTranscribe(argv.slice(1));
  if (!sub || sub === "--help" || sub === "-h") {
    process.stderr.write(HELP);
    return sub ? 0 : 1;
  }
  process.stderr.write(`speko-calls audio: unknown subcommand '${sub}'. try: speak | transcribe\n`);
  return 2;
}
