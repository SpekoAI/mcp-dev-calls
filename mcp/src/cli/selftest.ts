/**
 * `speko selftest` — the package-shipped hermetic integration test. Spawns THIS install's own
 * bundle as a stdio MCP server with SPEKO_TEST_MODE=1 and a fresh temp state dir, drives it
 * with the real MCP client, and prints a PASS/FAIL line per check plus a final verdict — a
 * green/red answer to "is this install wired correctly?" with zero secrets, zero network,
 * zero telephony. Always hermetic: any live SPEKO_API_KEY / SPEKOAI_API_KEY /
 * SPEKO_MCP_SERVER_URL in the environment is stripped from the child (and noted in the
 * header), so it can never touch a real backend. SPEKO_TOOLS is respected: with a filter set,
 * the inventory check asserts the filtered subset and checks needing absent tools are SKIPped.
 *
 * Exit codes: 0 = every check passed; 1 = any check failed (or the run timed out); 2 = bad flags.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { selectTools } from "../lib/toolFilter.js";

/** Mirrors TOOL_REGISTRY in ../index.ts; the checks sort names, so order is cosmetic. */
export const ALL_TOOL_NAMES = [
  "lookup_business",
  "make_call",
  "call_number",
  "check_call_readiness",
  "get_call",
  "call_me",
] as const;

// ── Pure check logic (unit-tested without any spawn) ─────────────────────────

export interface ToolSchemaLike {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: unknown };
}

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const pass = (name: string, detail: string): CheckResult => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });
const skip = (name: string, detail: string): CheckResult => ({ name, status: "skip", detail });

/** tools/list must expose exactly the 6 tools — or exactly the SPEKO_TOOLS-selected subset. */
export function checkToolInventory(tools: ToolSchemaLike[], toolSpec: string | undefined): CheckResult {
  const { selected } = selectTools(toolSpec, ALL_TOOL_NAMES);
  const expected = [...selected].sort();
  const actual = tools.map((t) => t.name).sort();
  const filtered = expected.length !== ALL_TOOL_NAMES.length;
  // A filter that matches NO known tool (e.g. SPEKO_TOOLS=bogus) leaves nothing to verify — that
  // is a failed selftest, not a green run with zero tools. (Selftest strips SPEKO_TOOLS from the
  // child anyway, so this only fires if a caller forces an empty toolSpec in-process.)
  if (expected.length === 0) {
    return fail("tools/list inventory", `SPEKO_TOOLS matched no known tool; nothing to verify (got [${actual.join(", ")}])`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail(
      "tools/list inventory",
      `expected [${expected.join(", ")}]${filtered ? " (filtered by SPEKO_TOOLS)" : ""}, got [${actual.join(", ")}]`,
    );
  }
  return pass(
    "tools/list inventory",
    filtered
      ? `exactly the ${expected.length} tool(s) selected by SPEKO_TOOLS: ${actual.join(", ")}`
      : `exactly the ${ALL_TOOL_NAMES.length} expected tools`,
  );
}

function props(tool: ToolSchemaLike): Record<string, unknown> {
  return tool.inputSchema?.properties ?? {};
}

function required(tool: ToolSchemaLike): string[] {
  const r = tool.inputSchema?.required;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Schema invariants of the dial surface: call_me is target-closed, make_call is token-gated
 * (a raw phone number can never reach it), and both dial tools expose bounded-wait polling.
 * A tool absent from tools/list (filtered by SPEKO_TOOLS) SKIPs its check.
 */
export function checkSchemaInvariants(tools: ToolSchemaLike[]): CheckResult[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const results: CheckResult[] = [];

  const callMe = byName.get("call_me");
  if (!callMe) results.push(skip("call_me schema (target-closed)", "call_me not registered (SPEKO_TOOLS)"));
  else {
    const p = props(callMe);
    const req = required(callMe);
    if ("phone_number" in p || "dial_token" in p) {
      results.push(fail("call_me schema (target-closed)", "call_me exposes a destination field"));
    } else if (JSON.stringify(req) !== JSON.stringify(["message"])) {
      results.push(fail("call_me schema (target-closed)", `call_me must require only message, requires [${req.join(", ")}]`));
    } else {
      results.push(pass("call_me schema (target-closed)", "no destination field; requires only message"));
    }
  }

  const makeCall = byName.get("make_call");
  if (!makeCall) results.push(skip("make_call schema (token-gated)", "make_call not registered (SPEKO_TOOLS)"));
  else {
    const p = props(makeCall);
    const req = required(makeCall);
    if (!req.includes("dial_token")) {
      results.push(fail("make_call schema (token-gated)", `dial_token is not required (required: [${req.join(", ")}])`));
    } else if ("phone_number" in p || req.includes("phone_number")) {
      results.push(fail("make_call schema (token-gated)", "make_call accepts phone_number — raw numbers must never dial"));
    } else {
      results.push(pass("make_call schema (token-gated)", "requires dial_token; no phone_number field"));
    }
  }

  const callNumber = byName.get("call_number");
  const waitless = [makeCall, callNumber]
    .filter((t): t is ToolSchemaLike => Boolean(t))
    .filter((t) => !("wait" in props(t)))
    .map((t) => t.name);
  if (!makeCall && !callNumber) {
    results.push(skip("dial tools expose wait", "make_call and call_number not registered (SPEKO_TOOLS)"));
  } else if (waitless.length > 0) {
    results.push(fail("dial tools expose wait", `missing wait property on: ${waitless.join(", ")}`));
  } else {
    results.push(
      pass(
        "dial tools expose wait",
        [makeCall, callNumber]
          .filter((t): t is ToolSchemaLike => Boolean(t))
          .map((t) => t.name)
          .join(" and ") + " expose wait",
      ),
    );
  }

  return results;
}

// ── Check runner against an abstract tool caller (unit-testable with a fake) ─

export interface ToolCallOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
}

export interface ToolCaller {
  listTools(): Promise<ToolSchemaLike[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

export interface RunChecksOptions {
  toolSpec?: string | undefined;
  /** Streamed per-check reporting (human mode prints as results land). */
  onResult?: (r: CheckResult) => void;
}

const CALLER_NAME = "Selftest User";
/** fakeClient fixtures (kept literal here: the selftest must not import server internals). */
const NO_PICKUP_NUMBER = "+15005550002";
const CONNECTED_NUMBER = "+15005550001";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Corrupt a signed dial token without changing its shape (flip one signature char). */
export function tamperDialToken(token: string): string {
  const last = token.slice(-1);
  return token.slice(0, -1) + (last === "A" ? "B" : "A");
}

/**
 * The full assertion suite from the design: inventory, schema invariants, simulated happy
 * path, honest no-answer, wait:false + get_call, call_me notify/converse, and the rails
 * probes (test mode runs the real rails). Every check runs even after a failure.
 */
export async function runChecks(caller: ToolCaller, opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const report = (r: CheckResult): void => {
    results.push(r);
    opts.onResult?.(r);
  };

  let tools: ToolSchemaLike[] = [];
  try {
    tools = await caller.listTools();
    report(checkToolInventory(tools, opts.toolSpec));
  } catch (e) {
    report(fail("tools/list inventory", (e as Error).message));
  }
  for (const r of checkSchemaInvariants(tools)) report(r);

  const has = (name: string): boolean => tools.some((t) => t.name === name);
  const run = async (name: string, needs: string[], fn: () => Promise<CheckResult>): Promise<void> => {
    const missing = needs.filter((n) => !has(n));
    if (missing.length > 0) {
      report(skip(name, `requires ${missing.join(" + ")} (not registered under SPEKO_TOOLS)`));
      return;
    }
    try {
      report(await fn());
    } catch (e) {
      report(fail(name, (e as Error).message));
    }
  };

  let dialToken: string | null = null;

  await run("lookup_business mints a dial_token", ["lookup_business"], async () => {
    const r = await caller.callTool("lookup_business", { name: "Test Bistro" });
    const candidates = (r.structured?.candidates ?? []) as Array<Record<string, unknown>>;
    dialToken = str(candidates[0]?.dial_token);
    if (r.isError || !dialToken) return fail("lookup_business mints a dial_token", `no callable candidate: ${r.text.slice(0, 160)}`);
    if (r.structured?.test_mode !== true) return fail("lookup_business mints a dial_token", "result is missing test_mode: true");
    return pass("lookup_business mints a dial_token", `candidate '${str(candidates[0]?.name) ?? "?"}' with a signed dial_token`);
  });

  await run("make_call simulated happy path", ["lookup_business", "make_call"], async () => {
    if (!dialToken) return fail("make_call simulated happy path", "no dial_token from lookup_business");
    const r = await caller.callTool("make_call", {
      dial_token: dialToken,
      objective: "Book a table for two at 7pm tonight.",
      caller_name: CALLER_NAME,
    });
    const outcome = str(r.structured?.outcome) ?? "";
    if (r.isError) return fail("make_call simulated happy path", r.text.slice(0, 200));
    if (r.structured?.test_mode !== true) return fail("make_call simulated happy path", "result is missing test_mode: true");
    if (!outcome.includes("[SIMULATED]")) return fail("make_call simulated happy path", `OUTCOME is not [SIMULATED]-labeled: '${outcome.slice(0, 120)}'`);
    return pass("make_call simulated happy path", `test_mode: true, outcome: ${outcome.slice(0, 80)}`);
  });

  await run("call_number honest no-answer", ["call_number"], async () => {
    const r = await caller.callTool("call_number", {
      phone_number: NO_PICKUP_NUMBER,
      objective: "Ask whether the shop is open tomorrow.",
      caller_name: CALLER_NAME,
    });
    if (r.isError) return fail("call_number honest no-answer", r.text.slice(0, 200));
    if (r.structured?.status !== "not_connected") {
      return fail("call_number honest no-answer", `expected status 'not_connected', got '${str(r.structured?.status) ?? "?"}'`);
    }
    if (r.structured?.test_mode !== true) return fail("call_number honest no-answer", "result is missing test_mode: true");
    return pass("call_number honest no-answer", `${NO_PICKUP_NUMBER} reported not_connected, never a fake success`);
  });

  let backgroundCallId: string | null = null;

  await run("call_number wait:false returns a pollable call_id", ["call_number"], async () => {
    const r = await caller.callTool("call_number", {
      phone_number: CONNECTED_NUMBER,
      objective: "Confirm the pickup order is ready.",
      caller_name: CALLER_NAME,
      wait: false,
    });
    backgroundCallId = str(r.structured?.call_id);
    if (r.isError) return fail("call_number wait:false returns a pollable call_id", r.text.slice(0, 200));
    if (r.structured?.status !== "dialing" || !backgroundCallId) {
      return fail(
        "call_number wait:false returns a pollable call_id",
        `expected status 'dialing' with a call_id, got '${str(r.structured?.status) ?? "?"}'`,
      );
    }
    return pass("call_number wait:false returns a pollable call_id", `call_id '${backgroundCallId}'`);
  });

  await run("get_call resolves the backgrounded call", ["call_number", "get_call"], async () => {
    if (!backgroundCallId) return fail("get_call resolves the backgrounded call", "no call_id from the wait:false dial");
    const r = await caller.callTool("get_call", { call_id: backgroundCallId });
    if (r.isError) return fail("get_call resolves the backgrounded call", r.text.slice(0, 200));
    if (r.structured?.test_mode !== true) return fail("get_call resolves the backgrounded call", "result is missing test_mode: true");
    const status = str(r.structured?.status) ?? "?";
    // The wait:false dial targeted the connected-success fixture, so a resolved poll MUST reach
    // "completed" — asserting the value (not just that get_call answered) catches a describeCall
    // regression that returned a garbage/unknown status for a backgrounded call.
    if (status !== "completed") {
      return fail("get_call resolves the backgrounded call", `expected terminal status 'completed', got '${status}'`);
    }
    return pass("get_call resolves the backgrounded call", `call '${backgroundCallId}' resolved to 'completed'`);
  });

  await run("call_me notify reaches the fixture owner", ["call_me"], async () => {
    const r = await caller.callTool("call_me", { message: "Selftest notification: the build is green.", mode: "notify" });
    if (r.isError) return fail("call_me notify reaches the fixture owner", r.text.slice(0, 200));
    if (r.structured?.test_mode !== true) return fail("call_me notify reaches the fixture owner", "result is missing test_mode: true");
    if (!r.text.includes("[SIMULATED]")) return fail("call_me notify reaches the fixture owner", "result carries no [SIMULATED] marker");
    return pass("call_me notify reaches the fixture owner", "notification delivered in simulation");
  });

  await run("call_me converse round-trip", ["call_me"], async () => {
    const r = await caller.callTool("call_me", { message: "Should I proceed with the plan?", mode: "converse" });
    if (r.isError) return fail("call_me converse round-trip", r.text.slice(0, 200));
    const confirmation = str(r.structured?.confirmation);
    const finalInstruction = str(r.structured?.final_instruction) ?? "";
    if (confirmation !== "confirmed") return fail("call_me converse round-trip", `expected confirmation 'confirmed', got '${confirmation ?? "?"}'`);
    if (!finalInstruction.includes("[SIMULATED]")) {
      return fail("call_me converse round-trip", `final_instruction is not [SIMULATED]-labeled: '${finalInstruction.slice(0, 120)}'`);
    }
    return pass("call_me converse round-trip", `owner confirmed the read-back: ${finalInstruction.slice(0, 80)}`);
  });

  await run("rail: no-sell screen rejects with next_step", ["call_number"], async () => {
    const r = await caller.callTool("call_number", {
      phone_number: CONNECTED_NUMBER,
      objective: "Cold call them and sell crypto investments.",
      caller_name: CALLER_NAME,
    });
    if (!r.isError) return fail("rail: no-sell screen rejects with next_step", "a selling objective was NOT rejected");
    if (!/transactional/i.test(r.text)) return fail("rail: no-sell screen rejects with next_step", `unexpected rejection: ${r.text.slice(0, 160)}`);
    if (!r.text.includes("next_step")) return fail("rail: no-sell screen rejects with next_step", "rejection carries no next_step guidance");
    return pass("rail: no-sell screen rejects with next_step", "selling objective rejected by the transactional-only policy");
  });

  await run("rail: tampered dial_token is rejected", ["lookup_business", "make_call"], async () => {
    if (!dialToken) return fail("rail: tampered dial_token is rejected", "no dial_token from lookup_business");
    const r = await caller.callTool("make_call", {
      dial_token: tamperDialToken(dialToken),
      objective: "Book a table for two at 7pm tonight.",
      caller_name: CALLER_NAME,
    });
    if (!r.isError) return fail("rail: tampered dial_token is rejected", "a tampered dial_token was ACCEPTED");
    if (!/dial token/i.test(r.text) || !/lookup_business/i.test(r.text)) {
      return fail("rail: tampered dial_token is rejected", `unexpected rejection: ${r.text.slice(0, 160)}`);
    }
    return pass("rail: tampered dial_token is rejected", "signature check failed as required");
  });

  await run("check_call_readiness reports simulated mode", ["check_call_readiness"], async () => {
    const r = await caller.callTool("check_call_readiness", {});
    if (r.isError) return fail("check_call_readiness reports simulated mode", r.text.slice(0, 200));
    if (r.structured?.test_mode !== true) return fail("check_call_readiness reports simulated mode", "result is missing test_mode: true");
    const headline = str(r.structured?.headline) ?? "";
    if (!/simulated/i.test(headline)) return fail("check_call_readiness reports simulated mode", `headline does not say simulated: '${headline.slice(0, 120)}'`);
    return pass("check_call_readiness reports simulated mode", headline.slice(0, 100));
  });

  return results;
}

export function summarize(results: CheckResult[]): { passed: number; failed: number; skipped: number; code: 0 | 1 } {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  // Green requires zero failures AND at least one real PASS: a run where every check skipped or
  // errored verified nothing and must not exit 0 (defense against a false-green selftest).
  return { passed, failed, skipped, code: failed > 0 || passed === 0 ? 1 : 0 };
}

// ── The hermetic child environment ───────────────────────────────────────────

/** Never forwarded to the child: selftest is always hermetic, whatever the shell holds. */
export const STRIPPED_ENV_KEYS = [
  "SPEKO_API_KEY",
  "SPEKOAI_API_KEY",
  "SPEKO_MCP_SERVER_URL",
  "SPEKO_OWNER_PROFILE", // test mode's fixture owner must win — the real blob stays out
  "SPEKO_FAKE_NOW", // a shell-configured clock would move the after-hours gate mid-selftest
  "SPEKO_ALLOW_DOTENV", // no cwd .env may repoint the child
  "SPEKO_TOOLS", // selftest is a wiring test: always exercise the full 6-tool surface, so a
  // shell filter (esp. a typo'd one) can't yield a green run with every check skipped
] as const;

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  stateDir: string,
): { env: Record<string, string>; stripped: string[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  const stripped = STRIPPED_ENV_KEYS.filter((k) => (env[k] ?? "").trim() !== "");
  for (const k of STRIPPED_ENV_KEYS) delete env[k];
  env.SPEKO_TEST_MODE = "1";
  env.SPEKO_NO_DOTENV = "1";
  env.SPEKO_OWNER_STATE_DIR = stateDir;
  env.SPEKO_GUARD_STATE_DIR = stateDir;
  // Poll-only client profiles (cursor/windsurf/safe-default — the unset default) force call_me
  // to return `dialing` instead of the blocking converse round-trip the fixture asserts. Pin a
  // blocking profile so the scenario is deterministic whatever the shell is configured for.
  env.SPEKO_CLIENT_PROFILE = "claude-code";
  return { env, stripped: [...stripped] };
}

/**
 * The stdio server to spawn is THIS bundle: the package ships as one file, so in an installed
 * package import.meta.url IS the dist/index.js an MCP host would spawn — no repo path needed.
 * (Under a TS dev runner the module URL is a .ts source file node can't execute; fall back to
 * the invoked entry script.)
 */
export function resolveServerEntry(argv1: string | undefined = process.argv[1]): string {
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith(".ts") && argv1) return argv1;
  return self;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const OPTIONS = {
  json: { type: "boolean" },
  timeout: { type: "string" }, // whole-run cap in seconds (default 60) — a selftest may never hang a CI
} as const;

export interface SelftestDeps {
  entryPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
}

const HERMETIC_NOTE = "hermetic simulation - no real calls";

export async function runSelftest(argv: string[], deps: SelftestDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? ((line) => process.stderr.write(line + "\n"));

  let json = false;
  let timeoutMs = 60_000;
  try {
    const { values } = parseArgs({ args: argv, options: OPTIONS });
    json = Boolean(values.json);
    if (values.timeout !== undefined) {
      const seconds = Number(values.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--timeout must be a positive number of seconds, got '${values.timeout}'`);
      timeoutMs = seconds * 1000;
    }
  } catch (e) {
    stderr(`selftest: ${(e as Error).message}`);
    return 2;
  }

  const env = deps.env ?? process.env;
  const stateDir = mkdtempSync(join(tmpdir(), "speko-selftest-"));
  const { env: childEnv, stripped } = buildChildEnv(env, stateDir);
  const entry = deps.entryPath ?? resolveServerEntry();
  // selftest always exercises the full 6-tool surface: SPEKO_TOOLS is stripped from the child
  // (above), so the inventory assertion must expect all 6 too — never the caller's filter.
  const toolSpec = undefined;

  if (!json) {
    stdout.write(`speko selftest — ${HERMETIC_NOTE} (spawns this install's MCP server with SPEKO_TEST_MODE=1, temp state)\n`);
    if (stripped.length > 0) stdout.write(`note: stripped ${stripped.join(", ")} from the child environment — the selftest never uses live credentials\n`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: childEnv,
    stderr: "ignore",
  });
  const client = new Client({ name: "speko-selftest", version: "1.0.0" });

  const results: CheckResult[] = [];
  const onResult = json
    ? undefined
    : (r: CheckResult): void => {
        stdout.write(`${r.status.toUpperCase()} ${r.name} — ${r.detail}\n`);
      };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });

  try {
    const body = (async (): Promise<"done"> => {
      await client.connect(transport);
      const run = await runChecks(
        {
          listTools: async () => (await client.listTools()).tools as ToolSchemaLike[],
          callTool: async (name, args) => {
            const res = (await client.callTool({ name, arguments: args })) as {
              isError?: boolean;
              content?: Array<{ type?: string; text?: string }>;
              structuredContent?: unknown;
            };
            const text = Array.isArray(res.content)
              ? res.content
                  .filter((c) => c?.type === "text")
                  .map((c) => c.text ?? "")
                  .join("\n")
              : "";
            let structured =
              res.structuredContent && typeof res.structuredContent === "object" && !Array.isArray(res.structuredContent)
                ? (res.structuredContent as Record<string, unknown>)
                : null;
            if (!structured && text.trim().startsWith("{")) {
              try {
                structured = JSON.parse(text) as Record<string, unknown>;
              } catch {
                // Not JSON — the text form is still asserted where it matters.
              }
            }
            return { isError: Boolean(res.isError), text, structured };
          },
        },
        // A streamed result appends to `results` here AND prints via onResult; runChecks
        // returns the same array contents, so assign, don't concat.
        { toolSpec, onResult: (r) => { results.push(r); onResult?.(r); } },
      );
      results.length = 0;
      results.push(...run);
      return "done";
    })();

    const winner = await Promise.race([body, timedOut]);
    if (winner === "timeout") {
      const r = fail("selftest deadline", `the run did not finish within ${Math.round(timeoutMs / 1000)}s`);
      results.push(r);
      if (!json) stdout.write(`FAIL ${r.name} — ${r.detail}\n`);
      // Swallow the raced body's eventual rejection (the transport is torn down under it).
      void body.catch(() => {});
    }
  } catch (e) {
    const r = fail("selftest run", (e as Error).message);
    results.push(r);
    if (!json) stdout.write(`FAIL ${r.name} — ${r.detail}\n`);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // The child may already be gone; the verdict below is what matters.
    }
    try {
      await transport.close();
    } catch {
      // Same: teardown must never mask the check results.
    }
  }

  const { passed, failed, skipped, code } = summarize(results);
  if (json) {
    stdout.write(
      JSON.stringify({
        ok: code === 0,
        note: HERMETIC_NOTE,
        passed,
        failed,
        skipped,
        stripped_env: stripped,
        checks: results.map((r) => ({ name: r.name, pass: r.status === "pass", status: r.status, detail: r.detail })),
      }) + "\n",
    );
  } else {
    stdout.write(`selftest: ${passed} passed, ${failed} failed${skipped > 0 ? ` (${skipped} skipped)` : ""}\n`);
  }
  return code;
}
