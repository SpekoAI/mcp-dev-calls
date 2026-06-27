/**
 * Speko Calls MCP entry. Two modes off one bin:
 *  • `speko-calls init|setup|login` → the onboarding wizard (may log to stdout).
 *  • bare invocation → the stdio MCP server (stdout RESERVED for JSON-RPC; logs → stderr).
 *
 * Tools are registered EXPLICITLY (the package is bundled to a single file, so
 * mcp-framework's filesystem tool discovery has nothing to scan). Each tool just
 * delegates to the backend (in-process when SPEKO_API_KEY is set, else HTTP).
 */
import { MCPServer } from "mcp-framework";
import { runInit } from "./cli/init.js";
import { loadEnv } from "./lib/env.js";
import CallMeTool from "./tools/CallMeTool.js";
import CallNumberTool from "./tools/CallNumberTool.js";
import CheckCallReadinessTool from "./tools/CheckCallReadinessTool.js";
import GetCallTool from "./tools/GetCallTool.js";
import LookupBusinessTool from "./tools/LookupBusinessTool.js";
import MakeCallTool from "./tools/MakeCallTool.js";

const cmd = process.argv[2];
if (cmd === "init" || cmd === "setup" || cmd === "login") {
  await runInit(process.argv.slice(3), cmd);
  process.exit(0);
}

loadEnv();

const server = new MCPServer({
  name: "speko-calls",
  version: "0.4.0",
  transport: { type: "stdio" },
});

server.addTool(LookupBusinessTool);
server.addTool(MakeCallTool);
server.addTool(CallNumberTool);
server.addTool(CheckCallReadinessTool);
server.addTool(GetCallTool);
server.addTool(CallMeTool);

await server.start();
