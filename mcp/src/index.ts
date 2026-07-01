/**
 * Speko Calls entry. One bin, cli + mcp:
 *  • `speko-calls init|setup|login`        → onboarding wizard (may log to stdout).
 *  • `speko-calls audio speak|transcribe`  → terminal TTS/STT (voice on the CLI).
 *  • `speko-calls voices|models`           → list voices the router can pick.
 *  • `speko-calls --help|--version`        → help/version.
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
import { runVoices } from "./cli/voices.js";
import { resolveMode } from "./cli/router.js";
import { loadEnv } from "./lib/env.js";
import CallMeTool from "./tools/CallMeTool.js";
import CallNumberTool from "./tools/CallNumberTool.js";
import CheckCallReadinessTool from "./tools/CheckCallReadinessTool.js";
import GetCallTool from "./tools/GetCallTool.js";
import LookupBusinessTool from "./tools/LookupBusinessTool.js";
import MakeCallTool from "./tools/MakeCallTool.js";

const VERSION = "0.4.6";

function printHelp(): number {
  process.stderr.write(
    `speko-calls ${VERSION} — call real businesses + speak/transcribe from your terminal; also an MCP server for coding agents.\n\n` +
      "Usage:\n" +
      "  speko-calls                          start the MCP stdio server (Claude Code, etc.)\n" +
      "  speko-calls init | setup | login     onboarding & auth\n" +
      '  speko-calls audio speak "<text>"     text-to-speech (TTS)\n' +
      "  speko-calls audio transcribe <f|->   speech-to-text (STT)\n" +
      "  speko-calls voices [--provider <p>]  list available voices\n" +
      "  speko-calls --help | --version\n",
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
  audio: () => runAudio(rest),
  voices: () => runVoices(rest),
  models: () => runVoices(rest),
  "--help": printHelp,
  "-h": printHelp,
  "--version": printVersion,
  "-V": printVersion,
};

const mode = resolveMode(process.argv);
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

// Bare invocation (or an unknown arg an MCP host may pass) → the stdio MCP server.
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
server.addTool(CallMeTool);

await server.start();
