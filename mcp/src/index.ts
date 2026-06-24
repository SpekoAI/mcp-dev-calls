/**
 * Speko Calls MCP — the thin, secret-free tier. Built on mcp-framework: tool
 * classes in ./tools are auto-discovered, and each one delegates to the demo
 * backing server (which holds the keys, runs the Google business lookup, enforces
 * the safety rails, and dials api.speko.dev via @spekoai/sdk).
 *
 * Run by Claude Code over stdio — stdout carries JSON-RPC, so all logging goes
 * to stderr (mcp-framework handles this).
 */
import { MCPServer } from "mcp-framework";
import { loadEnv } from "./lib/env.js";

// Bin dispatch: `speko-calls init|setup|login` runs the onboarding wizard (which may log
// freely to stdout). The default, no-arg invocation is the stdio MCP server — MCP clients
// spawn the bare command, and in serve mode stdout is RESERVED for JSON-RPC.
const cmd = process.argv[2];
if (cmd === "init" || cmd === "setup" || cmd === "login") {
  const { runInit } = await import("./cli/init.js");
  await runInit(process.argv.slice(3));
  process.exit(0);
}

loadEnv();

const server = new MCPServer({
  name: "speko-calls",
  version: "0.1.0",
  transport: { type: "stdio" },
});

await server.start();
