#!/usr/bin/env node
/**
 * MCP protocol end-to-end smoke against the BUILT bundle (mcp/dist/index.js) — the exact
 * artifact `npx @spekoai/mcp-calls` runs. Spawns it over stdio with the real MCP client,
 * lists tools, and exercises the read-only paths. Proves: 6 tools exposed, stdout is clean
 * JSON-RPC (any log leak would break the handshake), single-process backend works, and the
 * demo lookup dispatches. No phone call is placed.
 *
 *   node scripts/mcp-e2e.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

process.loadEnvFile?.(".env");

const bundle = resolve(process.cwd(), "mcp/dist/index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundle],
  env: { ...process.env }, // inherits SPEKO_API_KEY + SPEKO_DEMO* from .env → single-process + demo lookup
  stderr: "ignore",
});

const client = new Client({ name: "speko-mcp-e2e", version: "1.0.0" });
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✅" : "❌"} ${msg}`);
  if (!ok) failures += 1;
};

await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
const EXPECTED = ["call_me", "call_number", "check_call_readiness", "get_call", "lookup_business", "make_call"];
check(EXPECTED.every((n) => names.includes(n)), `all ${EXPECTED.length} tools exposed`);

// lookup_business advertises the agentic web-search phone_number param
const lbTool = tools.find((t) => t.name === "lookup_business");
const lbProps = lbTool?.inputSchema?.properties ?? {};
check(Boolean(lbProps.phone_number), "lookup_business exposes phone_number (agentic web-search path)");

// read-only preflight
const r = await client.callTool({ name: "check_call_readiness", arguments: {} });
const rtext = r.content?.find((c) => c.type === "text")?.text ?? "";
check(/ready to call/i.test(rtext), `check_call_readiness responds: "${rtext.slice(0, 80).replace(/\n/g, " ")}…"`);

// demo lookup mints a dial_token (SPEKO_DEMO=1 in .env)
const lb = await client.callTool({ name: "lookup_business", arguments: { name: "Sakura Sushi" } });
const lbStruct = lb.structuredContent ?? {};
const cand = lbStruct.candidates?.[0];
check(Boolean(cand?.dial_token) || /callable/i.test(lb.content?.[0]?.text ?? ""), `lookup_business(demo) returns a candidate (source=${lbStruct.source ?? "?"})`);

await client.close();
console.log(failures === 0 ? "\n✅ MCP protocol e2e PASSED" : `\n❌ MCP protocol e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
