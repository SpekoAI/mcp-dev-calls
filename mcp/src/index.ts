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

loadEnv();

const server = new MCPServer({
  name: "speko-calls",
  version: "0.1.0",
  transport: { type: "stdio" },
});

await server.start();
