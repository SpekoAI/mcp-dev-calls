/**
 * Speko Calls entry. One bin, cli + mcp:
 *  • `speko init|setup|login`        → onboarding wizard (may log to stdout).
 *  • `speko dnc list|add|remove`     → local do-not-call guardrail ledger.
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
import { runVoices } from "./cli/voices.js";
import { runUsage } from "./cli/usage.js";
import { runCredits } from "./cli/credits.js";
import { runCall } from "./cli/call.js";
import { resolveMode } from "./cli/router.js";
import { loadEnv } from "./lib/env.js";
import CallNumberTool from "./tools/CallNumberTool.js";
import CheckCallReadinessTool from "./tools/CheckCallReadinessTool.js";
import GetCallTool from "./tools/GetCallTool.js";
import LookupBusinessTool from "./tools/LookupBusinessTool.js";
import MakeCallTool from "./tools/MakeCallTool.js";

const VERSION = "0.6.3";

function printHelp(): number {
  process.stderr.write(
    `speko ${VERSION} — call real businesses + speak/transcribe from your terminal; also an MCP server for coding agents.\n\n` +
      "Usage:\n" +
      "  speko                          (when launched by an MCP host) the stdio MCP server\n" +
      "  speko init | setup | login     onboarding & auth\n" +
      "  speko dnc list|add|remove      manage the local do-not-call list\n" +
      '  speko audio speak "<text>"     text-to-speech (TTS)\n' +
      "  speko audio transcribe <f|->   speech-to-text (STT)\n" +
      "  speko voices [--provider <p>]  list available voices\n" +
      "  speko usage                    account usage this period (sessions, minutes, spend, balance)\n" +
      "  speko credits [--ledger]       prepaid balance (+ recent credit movements)\n" +
      "  speko call report <id>         a finished call's outcome, cost + cost breakdown\n" +
      "  speko call events <id>         timeline / speech diagram of the call\n" +
      "  speko call transcript <id>     the call transcript, one line per turn\n" +
      "  speko --help | --version\n",
  );
  return 0;
}

function printVersion(): number {
  process.stdout.write(VERSION + "\n");
  return 0;
}

const rest = process.argv.slice(3);

const CLI: Record<string, () => Promise<number> | number> = {
  init: async () => (await runInit(rest, "init"), 0),
  setup: async () => (await runInit(rest, "setup"), 0),
  login: async () => (await runInit(rest, "login"), 0),
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
loadEnv();

const server = new MCPServer({
  name: "speko-calls",
  version: VERSION,
  transport: { type: "stdio" },
});

server.addTool(LookupBusinessTool);
server.addTool(MakeCallTool);
server.addTool(CallNumberTool);
server.addTool(CheckCallReadinessTool);
server.addTool(GetCallTool);
// call_me (ring the owner's verified phone) is deliberately NOT registered: the platform
// exposes no verified personal phone yet, and an always-throwing tool is a trap control
// in the agent's context (§ product doctrine). The implementation stays in
// tools/CallMeTool.ts; re-register it when the platform ships the verified-owner phone.

await server.start();
