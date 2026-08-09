#!/usr/bin/env node
/**
 * MCP protocol end-to-end smoke against the BUILT bundle (mcp/dist/index.js) — the exact
 * artifact `npx @spekoai/mcp-calls` runs. Spawns it over stdio with the real MCP client,
 * lists tools, and exercises the read-only paths. Proves: 6 tools exposed, stdout is clean
 * JSON-RPC (any log leak would break the handshake), single-process backend works, the
 * demo lookup dispatches, SPEKO_TOOLS gating filters the registered surface over the wire,
 * and non-TTY `init --paste` fails fast (exit 1) on empty stdin. No phone call is placed
 * and NOTHING leaves the machine: SPEKOAI_API_URL points at a network sinkhole.
 *
 *   node scripts/mcp-e2e.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile?.(".env");

const bundle = resolve(process.cwd(), "mcp/dist/index.js");
const isolatedStateDir = resolve(tmpdir(), `speko-mcp-e2e-${process.pid}`);
// Keep this smoke deterministic and offline even when the invoking shell is configured
// for a remote backing server or points at real local state. SPEKOAI_API_URL is a
// sinkhole (same as characterization/probes.mjs): zero egress, connections die locally.
const e2eEnv = {
  ...process.env,
  SPEKO_MCP_SERVER_URL: "",
  SPEKOAI_API_URL: "http://127.0.0.1:9",
  SPEKO_API_KEY: "sk_mcp_e2e_offline_fixture",
  SPEKO_DIAL_TOKEN_SECRET: "mcp-e2e-offline-dial-secret",
  SPEKO_DEMO: "1",
  SPEKO_DEMO_E164: "+12025550123",
  SPEKO_DEMO_BUSINESS: "Sakura Sushi",
  SPEKO_DEMO_LINE_TYPE: "voip",
  SPEKO_DEMO_UTC_OFFSET: "-420",
  SPEKO_CLIENT_PROFILE: "safe-default",
  SPEKO_OWNER_STATE_DIR: isolatedStateDir,
  SPEKO_GUARD_STATE_DIR: isolatedStateDir,
  SPEKO_TOOLS: "",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundle],
  env: e2eEnv,
  stderr: "ignore",
});

const client = new Client({ name: "speko-mcp-e2e", version: "1.0.0" });
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
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

// call_me is target-closed: the owner is resolved from local verified state, never tool input.
const callMeTool = tools.find((t) => t.name === "call_me");
const callMeProps = callMeTool?.inputSchema?.properties ?? {};
check(Boolean(callMeProps.message), "call_me exposes message");
check(Boolean(callMeProps.wait), "call_me exposes wait/get_call recovery mode");
check(!("phone_number" in callMeProps), "call_me exposes no destination field");
check(
  JSON.stringify(callMeTool?.inputSchema?.required ?? []) === JSON.stringify(["message"]),
  "call_me requires only message",
);

// read-only preflight. Against the sinkhole the balance/number reads fail as network errors
// (not auth failures), so the deterministic headline is the "Almost ready / add credits"
// branch; the live branches stay accepted for anyone running this with a real key.
const r = await client.callTool({ name: "check_call_readiness", arguments: {} });
const rtext = r.content?.find((c) => c.type === "text")?.text ?? "";
check(
  /ready to (?:call|place calls)|almost ready|not connected|add credits/i.test(rtext),
  `check_call_readiness responds: "${rtext.slice(0, 80).replace(/\n/g, " ")}"`,
);

// demo lookup mints a dial_token (SPEKO_DEMO=1)
const lb = await client.callTool({ name: "lookup_business", arguments: { name: "Sakura Sushi" } });
const lbStruct = lb.structuredContent ?? {};
const cand = lbStruct.candidates?.[0];
check(Boolean(cand?.dial_token) || /callable/i.test(lb.content?.[0]?.text ?? ""), `lookup_business(demo) returns a candidate (source=${lbStruct.source ?? "?"})`);

await client.close();

// ── SPEKO_TOOLS gating over the stdio boundary ─────────────────────────────────────────
// A fresh server spawned with a filter (plus one unknown name) must expose EXACTLY the
// valid subset in tools/list and warn about the unknown name on stderr.
{
  const gatedTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { ...e2eEnv, SPEKO_TOOLS: "call_me,get_call,check_call_readiness,bogus_tool" },
    stderr: "pipe",
  });
  let gatedStderr = "";
  const gatedClient = new Client({ name: "speko-mcp-e2e-gated", version: "1.0.0" });
  const connectPromise = gatedClient.connect(gatedTransport);
  gatedTransport.stderr?.on("data", (d) => (gatedStderr += d));
  await connectPromise;
  const gated = await gatedClient.listTools();
  const gatedNames = gated.tools.map((t) => t.name).sort();
  check(
    JSON.stringify(gatedNames) === JSON.stringify(["call_me", "check_call_readiness", "get_call"]),
    `SPEKO_TOOLS filters tools/list to the valid subset (got: ${gatedNames.join(", ")})`,
  );
  await gatedClient.close();
  check(
    gatedStderr.includes("bogus_tool") && gatedStderr.includes("SPEKO_TOOLS"),
    "SPEKO_TOOLS unknown name produces a stderr warning naming it",
  );
}

// ── .env gate reaches the bundled server core (lazy loadConfig), not just the MCP tier ──
// Regression: a .env planted in the spawn cwd sets SPEKO_MCP_SERVER_URL; combined with
// SPEKO_TEST_MODE=1 the core's "test mode + remote URL cannot mix" refusal fires IF the
// planted file is loaded at the first tool call. With the gate propagated, readiness must
// answer in simulated mode instead of refusing.
{
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const hostileCwd = mkdtempSync(resolve(tmpdir(), "speko-e2e-hostile-"));
  writeFileSync(join(hostileCwd, ".env"), "SPEKO_MCP_SERVER_URL=http://127.0.0.1:1\n");
  const coreEnv = { ...e2eEnv, SPEKO_TEST_MODE: "1" };
  delete coreEnv.SPEKO_API_KEY;
  delete coreEnv.SPEKOAI_API_KEY;
  const hostileTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: coreEnv,
    cwd: hostileCwd,
    stderr: "ignore",
  });
  const hostileClient = new Client({ name: "speko-mcp-e2e-hostile", version: "1.0.0" });
  await hostileClient.connect(hostileTransport);
  const hr = await hostileClient.callTool({ name: "check_call_readiness", arguments: {} });
  const htext = hr.content?.find((c) => c.type === "text")?.text ?? "";
  check(
    !/SPEKO_MCP_SERVER_URL is set/i.test(htext) && /simulat/i.test(htext),
    `planted cwd .env never reaches the bundled server core in MCP mode ("${htext.slice(0, 60).replace(/\n/g, " ")}")`,
  );
  await hostileClient.close();
}

// ── init non-TTY hardening: empty piped stdin must exit 1, fast, never hang ────────────
// (Verified-live bug in 0.7.0: `echo "" | npx @spekoai/mcp-calls init --paste` exited 0.)
{
  // Strip the fixture key so init actually takes the stdin paste path (a key in env
  // would short-circuit it); the sinkhole still guarantees zero egress either way.
  const initEnv = { ...e2eEnv };
  delete initEnv.SPEKO_API_KEY;
  delete initEnv.SPEKOAI_API_KEY;
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, [bundle, "init", "--paste", "--yes"], {
      env: initEnv,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveCode("TIMEOUT");
    }, 20_000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolveCode(c);
    });
    child.stdin.end("\n"); // echo "" | …
  });
  check(code === 1, `init --paste with empty stdin exits 1 (got: ${code})`);
}

console.log(failures === 0 ? "\nMCP protocol e2e PASSED" : `\nMCP protocol e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
