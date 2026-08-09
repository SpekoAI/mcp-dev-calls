/**
 * Speko Calls entry. One bin, cli + mcp:
 *  • `speko init|setup|login`        → onboarding wizard (may log to stdout).
 *  • `speko status|whoami`           → doctor: key, backend mode, credits, call readiness.
 *  • `speko selftest`                → hermetic offline self-test (no key, no real calls).
 *  • `speko me verify|status|export` → verify/inspect/export the local call_me owner.
 *  • `speko dnc list|add|remove|check` → local do-not-call guardrail ledger.
 *  • `speko audio speak|transcribe`  → terminal TTS/STT (voice on the CLI).
 *  • `speko voices|models`           → list voices the router can pick.
 *  • `speko usage | credits`         → account usage/spend + prepaid balance.
 *  • `speko call report|events|transcript <id>` → inspect a finished call.
 *  • `speko --help|--version`        → help/version.
 *  • bare invocation                       → the stdio MCP server (stdout RESERVED for
 *                                            JSON-RPC; logs → stderr).
 *
 * Every CLI subcommand runs its handler and process.exit()s BEFORE the MCP server is
 * ever constructed — that's what keeps stdout clean for JSON-RPC in server mode.
 *
 * Tools are registered EXPLICITLY (the package is bundled to a single file, so
 * mcp-framework's filesystem tool discovery has nothing to scan).
 */
import { MCPServer } from "mcp-framework";
import { runInit } from "./cli/init.js";
import { runAudio } from "./cli/audio/index.js";
import { runDnc } from "./cli/dnc.js";
import { runSelftest } from "./cli/selftest.js";
import { runStatus } from "./cli/status.js";
import { runVoices } from "./cli/voices.js";
import { runUsage } from "./cli/usage.js";
import { runCredits } from "./cli/credits.js";
import { runCall } from "./cli/call.js";
import { runMe } from "./cli/me.js";
import { resolveMode } from "./cli/router.js";
import { loadEnv, setDotenvMode } from "./lib/env.js";
import { selectTools, unknownToolsWarning } from "./lib/toolFilter.js";
import CallNumberTool from "./tools/CallNumberTool.js";
import CallMeTool from "./tools/CallMeTool.js";
import CheckCallReadinessTool from "./tools/CheckCallReadinessTool.js";
import GetCallTool from "./tools/GetCallTool.js";
import LookupBusinessTool from "./tools/LookupBusinessTool.js";
import MakeCallTool from "./tools/MakeCallTool.js";

const VERSION = "0.7.0";

function printHelp(): number {
  process.stderr.write(
    `speko ${VERSION} — call real businesses + speak/transcribe from your terminal; also an MCP server for coding agents.\n\n` +
      "Usage:\n" +
      "  speko                          (when launched by an MCP host) the stdio MCP server\n" +
      "  speko init | setup | login     onboarding & auth\n" +
      "  speko status                   health check: key, backend, credits, call readiness (alias: whoami)\n" +
      "  speko selftest                 hermetic self-test of the MCP server — no key, no network, no real calls\n" +
      "  speko me verify|status|export  verify, inspect, or export the local call_me owner\n" +
      "  speko dnc list|add|remove|check  manage the local do-not-call list\n" +
      '  speko audio speak "<text>"     text-to-speech (TTS)\n' +
      "  speko audio transcribe <f|->   speech-to-text (STT)\n" +
      "  speko voices [--provider <p>]  list available voices (alias: models)\n" +
      "  speko usage                    account usage this period (sessions, minutes, spend, balance)\n" +
      "  speko credits [--ledger]       prepaid balance (+ recent credit movements)\n" +
      "  speko call report <id>         a finished call's outcome, cost + cost breakdown\n" +
      "  speko call events <id>         timeline / speech diagram of the call\n" +
      "  speko call transcript <id>     the call transcript, one line per turn\n" +
      "  speko call recording <id>      the call's audio recording URL\n" +
      "  speko --help | --version\n\n" +
      "`status`/`whoami`, `selftest`, `audio speak|transcribe`, `voices`/`models`, `usage`, `credits`, and `call *` accept --json.\n",
  );
  return 0;
}

function printVersion(): number {
  process.stdout.write(VERSION + "\n");
  return 0;
}

const rest = process.argv.slice(3);

const CLI: Record<string, () => Promise<number> | number> = {
  init: () => runInit(rest, "init"),
  setup: () => runInit(rest, "setup"),
  login: () => runInit(rest, "login"),
  status: () => runStatus(rest),
  whoami: () => runStatus(rest),
  selftest: () => runSelftest(rest),
  me: () => runMe(rest),
  dnc: () => runDnc(rest),
  audio: () => runAudio(rest),
  voices: () => runVoices(rest),
  models: () => runVoices(rest),
  usage: () => runUsage(rest),
  credits: () => runCredits(rest),
  call: () => runCall(rest),
  "--help": printHelp,
  "-h": printHelp,
  "--version": printVersion,
  "-V": printVersion,
};

const mode = resolveMode(process.argv, { stdinIsTTY: Boolean(process.stdin.isTTY) });
if (mode.kind === "cli") {
  try {
    const code = await CLI[mode.name]();
    process.exit(typeof code === "number" ? code : 0);
  } catch (e) {
    // A handler threw/rejected (e.g. Ctrl+C during `init`): report cleanly on stderr — never
    // stdout (reserved for JSON-RPC) — and exit non-zero instead of an unhandled-rejection crash.
    process.stderr.write(`${mode.name}: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

if (mode.kind === "help") {
  // Interactive terminal with no command → show the command list (like most CLI tools).
  printHelp();
  process.exit(0);
}

if (mode.kind === "usage-error") {
  // Unknown subcommand: fail fast on stderr with a distinct exit code — never boot the
  // stdio server (a typo'd `speko frobnicate | ...` used to hang the caller's shell).
  process.stderr.write(`speko: unknown command '${mode.name}'\n\n`);
  printHelp();
  process.exit(2);
}

// Piped / non-TTY invocation (an MCP host spawning us over stdio) → the stdio MCP server.
// Server mode: the cwd is an untrusted user repo, so .env discovery is OFF here (a planted
// .env could repoint the backing server). SPEKO_ALLOW_DOTENV=1 opts back in.
setDotenvMode("mcp-server");
loadEnv();

const server = new MCPServer({
  name: "speko-calls",
  version: VERSION,
  transport: { type: "stdio" },
});

// Registration order is the wire order in tools/list; SPEKO_TOOLS filters it (unset = all).
const TOOL_REGISTRY = [
  ["lookup_business", LookupBusinessTool],
  ["make_call", MakeCallTool],
  ["call_number", CallNumberTool],
  ["check_call_readiness", CheckCallReadinessTool],
  ["get_call", GetCallTool],
  ["call_me", CallMeTool],
] as const;

const validNames = TOOL_REGISTRY.map(([name]) => name);
const { selected, unknown } = selectTools(process.env.SPEKO_TOOLS, validNames);
if (unknown.length > 0) {
  process.stderr.write(`${unknownToolsWarning(unknown, validNames)}\n`);
}
for (const [name, Tool] of TOOL_REGISTRY) {
  if (selected.includes(name)) server.addTool(Tool);
}

await server.start();
