/**
 * `speko selftest` — the package-shipped hermetic integration test.
 *
 * Unit tier: the pure check logic (tool inventory, schema invariants, child-env hermetics)
 * and the full check-runner orchestration against fake callers — one conforming fake proves
 * the green path, doctored fakes prove every FAIL path stays a FAIL (and keeps running the
 * remaining checks). Negative runSelftest tier: a broken server entry must exit 1, never 0.
 *
 * Spawn tier: one integration test drives the REAL built bundle (mcp/dist/index.js) end to
 * end. It is skipped when dist/ is not built (vitest must not depend on a build); the root
 * `test:integration` script runs `node mcp/dist/index.js selftest` unconditionally, so CI
 * always proves the shipped selftest green.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOL_NAMES,
  buildChildEnv,
  checkSchemaInvariants,
  checkToolInventory,
  runChecks,
  runSelftest,
  summarize,
  tamperDialToken,
  type CheckResult,
  type ToolCaller,
  type ToolCallOutcome,
  type ToolSchemaLike,
} from "../src/cli/selftest.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Fixtures: a conforming tools/list + a conforming simulated server ────────

function goodTools(): ToolSchemaLike[] {
  return [
    {
      name: "lookup_business",
      inputSchema: { properties: { name: {}, location: {}, phone_number: {}, utc_offset_minutes: {} }, required: ["name"] },
    },
    {
      name: "make_call",
      inputSchema: {
        properties: { dial_token: {}, objective: {}, caller_name: {}, wait: {} },
        required: ["dial_token", "objective", "caller_name"],
      },
    },
    {
      name: "call_number",
      inputSchema: {
        properties: { phone_number: {}, objective: {}, caller_name: {}, wait: {} },
        required: ["phone_number", "objective", "caller_name"],
      },
    },
    { name: "check_call_readiness", inputSchema: { properties: {}, required: [] } },
    { name: "get_call", inputSchema: { properties: { call_id: {} }, required: ["call_id"] } },
    { name: "call_me", inputSchema: { properties: { message: {}, mode: {}, wait: {} }, required: ["message"] } },
  ];
}

const FIXTURE_TOKEN = "eyJwYXlsb2FkIjoxfQ.c2lnbmF0dXJlQUFB";

const ok = (structured: Record<string, unknown>, text?: string): ToolCallOutcome => ({
  isError: false,
  text: text ?? JSON.stringify(structured),
  structured,
});
const rejected = (text: string): ToolCallOutcome => ({ isError: true, text, structured: null });

/** Behaves like the real test-mode server; `doctor` mutates one response for negative tests. */
function fakeCaller(opts: {
  tools?: ToolSchemaLike[];
  doctor?: (name: string, args: Record<string, unknown>, out: ToolCallOutcome) => ToolCallOutcome;
} = {}): ToolCaller & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    listTools: async () => opts.tools ?? goodTools(),
    callTool: async (name, args) => {
      log.push(name);
      let out: ToolCallOutcome;
      if (name === "lookup_business") {
        out = ok({ candidates: [{ name: "Test Bistro", phone: "+15005550001", dial_token: FIXTURE_TOKEN }], test_mode: true });
      } else if (name === "make_call") {
        out =
          args.dial_token === FIXTURE_TOKEN
            ? ok({ status: "completed", outcome: "[SIMULATED] table for 2 confirmed for 7pm", test_mode: true })
            : rejected(
                "[SIMULATED] Dial token signature check failed: the token was altered or signed with a different secret; " +
                  "run lookup_business again to mint a fresh dial token.; next_step=Run lookup_business again.",
              );
      } else if (name === "call_number") {
        if (/sell/i.test(String(args.objective))) {
          out = rejected(
            "[SIMULATED] This objective is blocked by the transactional-only policy; next_step=Only place transactional calls.",
          );
        } else if (args.wait === false) {
          out = ok({ status: "dialing", call_id: "sim-call-2", test_mode: true });
        } else {
          out = ok({ status: "not_connected", connected: false, answered: false, test_mode: true });
        }
      } else if (name === "get_call") {
        out = ok({ status: "completed", call_id: String(args.call_id), test_mode: true });
      } else if (name === "call_me") {
        out =
          args.mode === "notify"
            ? ok(
                { status: "completed", answered: true, test_mode: true },
                '[SIMULATED] notification delivered to the owner {"status":"completed","test_mode":true}',
              )
            : ok({
                status: "completed",
                confirmation: "confirmed",
                final_instruction: "[SIMULATED] proceed with the plan",
                test_mode: true,
              });
      } else if (name === "check_call_readiness") {
        out = ok({
          headline: "Simulated test mode: ready to place simulated calls. No real phone call is ever dialed.",
          test_mode: true,
        });
      } else {
        out = rejected(`unknown tool ${name}`);
      }
      return opts.doctor ? opts.doctor(name, args, out) : out;
    },
  };
}

const byName = (results: CheckResult[], name: string): CheckResult => {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`no check named '${name}' in [${results.map((x) => x.name).join("; ")}]`);
  return r;
};

// ── Pure checks ──────────────────────────────────────────────────────────────

describe("checkToolInventory", () => {
  it("passes on exactly the 6 tools", () => {
    const r = checkToolInventory(goodTools(), undefined);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("6");
  });

  it("FAILS on a doctored tools list (a tool missing)", () => {
    const r = checkToolInventory(goodTools().filter((t) => t.name !== "call_me"), undefined);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("call_me");
  });

  it("FAILS on an extra, unexpected tool", () => {
    const r = checkToolInventory([...goodTools(), { name: "rm_rf" }], undefined);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("rm_rf");
  });

  it("respects SPEKO_TOOLS: asserts the filtered subset and says so", () => {
    const spec = "call_me,get_call,check_call_readiness";
    const subset = goodTools().filter((t) => spec.includes(t.name));
    const r = checkToolInventory(subset, spec);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("SPEKO_TOOLS");
    // ...and still FAILS when the wire list does not match the declared filter.
    expect(checkToolInventory(goodTools(), spec).status).toBe("fail");
  });

  it("FAILS when a filter matches no known tool (no false-green with zero checks)", () => {
    // SPEKO_TOOLS=bogus → zero selected → previously passed expecting zero tools and skipped
    // everything. Now it is a hard fail: a selftest that verifies nothing is not green.
    expect(checkToolInventory([], "bogus_tool").status).toBe("fail");
  });
});

describe("checkSchemaInvariants", () => {
  it("passes on the real schema shape", () => {
    for (const r of checkSchemaInvariants(goodTools())) expect(r.status).toBe("pass");
  });

  it("FAILS when call_me grows a destination field", () => {
    const tools = goodTools();
    const callMe = tools.find((t) => t.name === "call_me");
    callMe!.inputSchema!.properties!.phone_number = {};
    expect(byName(checkSchemaInvariants(tools), "call_me schema (target-closed)").status).toBe("fail");
  });

  it("FAILS when call_me requires more than message", () => {
    const tools = goodTools();
    tools.find((t) => t.name === "call_me")!.inputSchema!.required = ["message", "mode"];
    expect(byName(checkSchemaInvariants(tools), "call_me schema (target-closed)").status).toBe("fail");
  });

  it("FAILS when make_call stops requiring dial_token or accepts phone_number", () => {
    const noToken = goodTools();
    noToken.find((t) => t.name === "make_call")!.inputSchema!.required = ["objective", "caller_name"];
    expect(byName(checkSchemaInvariants(noToken), "make_call schema (token-gated)").status).toBe("fail");

    const rawNumber = goodTools();
    rawNumber.find((t) => t.name === "make_call")!.inputSchema!.properties!.phone_number = {};
    expect(byName(checkSchemaInvariants(rawNumber), "make_call schema (token-gated)").status).toBe("fail");
  });

  it("FAILS when a dial tool loses wait", () => {
    const tools = goodTools();
    delete tools.find((t) => t.name === "call_number")!.inputSchema!.properties!.wait;
    const r = byName(checkSchemaInvariants(tools), "dial tools expose wait");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("call_number");
  });

  it("SKIPs (never passes) checks whose tool is filtered out", () => {
    const tools = goodTools().filter((t) => ["get_call", "check_call_readiness"].includes(t.name));
    for (const r of checkSchemaInvariants(tools)) expect(r.status).toBe("skip");
  });
});

describe("buildChildEnv — the hermetic child", () => {
  it("strips live credentials/remote config and forces test mode + temp state", () => {
    const { env, stripped } = buildChildEnv(
      {
        SPEKO_API_KEY: "sk_live_real",
        SPEKOAI_API_KEY: "sk_live_real2",
        SPEKO_MCP_SERVER_URL: "https://example.invalid",
        SPEKO_OWNER_PROFILE: "blob",
        SPEKO_FAKE_NOW: "2026-01-01T23:00:00Z",
        SPEKO_TOOLS: "call_me,get_call",
        PATH: "/usr/bin",
      },
      "/tmp/state-x",
    );
    expect(env.SPEKO_API_KEY).toBeUndefined();
    expect(env.SPEKOAI_API_KEY).toBeUndefined();
    expect(env.SPEKO_MCP_SERVER_URL).toBeUndefined();
    expect(env.SPEKO_OWNER_PROFILE).toBeUndefined();
    expect(env.SPEKO_FAKE_NOW).toBeUndefined();
    expect(stripped).toEqual([
      "SPEKO_API_KEY",
      "SPEKOAI_API_KEY",
      "SPEKO_MCP_SERVER_URL",
      "SPEKO_OWNER_PROFILE",
      "SPEKO_FAKE_NOW",
      "SPEKO_TOOLS",
    ]);
    expect(env.SPEKO_TEST_MODE).toBe("1");
    expect(env.SPEKO_NO_DOTENV).toBe("1");
    expect(env.SPEKO_OWNER_STATE_DIR).toBe("/tmp/state-x");
    expect(env.SPEKO_GUARD_STATE_DIR).toBe("/tmp/state-x");
    // SPEKO_TOOLS is stripped: selftest always exercises the full 6-tool surface, so a shell
    // filter (esp. a typo) can't produce a green run with every substantive check skipped.
    expect(env.SPEKO_TOOLS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    // Deterministic blocking call_me round-trip whatever profile the shell is configured for.
    expect(env.SPEKO_CLIENT_PROFILE).toBe("claude-code");
  });

  it("reports nothing stripped when the shell is already clean", () => {
    const { stripped } = buildChildEnv({ PATH: "/usr/bin" }, "/tmp/state-y");
    expect(stripped).toEqual([]);
  });
});

describe("tamperDialToken", () => {
  it("returns a same-length, different token", () => {
    const t = tamperDialToken(FIXTURE_TOKEN);
    expect(t).not.toBe(FIXTURE_TOKEN);
    expect(t.length).toBe(FIXTURE_TOKEN.length);
  });
});

// ── runChecks orchestration against fakes ────────────────────────────────────

describe("runChecks — conforming simulated server", () => {
  it("every check passes and nothing is skipped", async () => {
    const results = await runChecks(fakeCaller(), {});
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.filter((r) => r.status === "skip")).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(12);
    expect(summarize(results).code).toBe(0);
  });

  it("streams every result through onResult", async () => {
    const seen: string[] = [];
    const results = await runChecks(fakeCaller(), { onResult: (r) => seen.push(r.name) });
    expect(seen).toEqual(results.map((r) => r.name));
  });

  it("under SPEKO_TOOLS the dialing checks SKIP instead of failing", async () => {
    const spec = "call_me,get_call,check_call_readiness";
    const caller = fakeCaller({ tools: goodTools().filter((t) => spec.includes(t.name)) });
    const results = await runChecks(caller, { toolSpec: spec });
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(byName(results, "make_call simulated happy path").status).toBe("skip");
    expect(byName(results, "rail: no-sell screen rejects with next_step").status).toBe("skip");
    expect(byName(results, "call_me converse round-trip").status).toBe("pass");
    // A filtered tool is never called over the wire.
    expect(caller.log).not.toContain("make_call");
    expect(caller.log).not.toContain("call_number");
  });
});

describe("runChecks — doctored servers FAIL and keep going", () => {
  it("a doctored tools list reports FAIL on inventory and still runs the rest", async () => {
    const results = await runChecks(fakeCaller({ tools: goodTools().filter((t) => t.name !== "check_call_readiness") }), {});
    expect(byName(results, "tools/list inventory").status).toBe("fail");
    // Later checks still ran (all run even after a failure).
    expect(byName(results, "call_me converse round-trip").status).toBe("pass");
    expect(summarize(results).code).toBe(1);
  });

  it("an unmarked outcome (missing [SIMULATED] / test_mode) FAILS the happy path", async () => {
    const caller = fakeCaller({
      doctor: (name, _args, out) =>
        name === "make_call" && !out.isError
          ? ok({ status: "completed", outcome: "table for 2 confirmed for 7pm", test_mode: true })
          : out,
    });
    const results = await runChecks(caller, {});
    const r = byName(results, "make_call simulated happy path");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("[SIMULATED]");
    expect(summarize(results).code).toBe(1);
  });

  it("a rail that stops rejecting FAILS its probe (abuse-shaped: tampered token accepted)", async () => {
    const caller = fakeCaller({
      doctor: (name, args, out) =>
        name === "make_call" && args.dial_token !== FIXTURE_TOKEN
          ? ok({ status: "completed", outcome: "[SIMULATED] done", test_mode: true })
          : out,
    });
    const results = await runChecks(caller, {});
    const r = byName(results, "rail: tampered dial_token is rejected");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("ACCEPTED");
    expect(summarize(results).code).toBe(1);
  });

  it("a rejection without next_step guidance FAILS the no-sell probe", async () => {
    const caller = fakeCaller({
      doctor: (name, args, out) =>
        name === "call_number" && /sell/i.test(String(args.objective))
          ? rejected("[SIMULATED] blocked by the transactional-only policy")
          : out,
    });
    const results = await runChecks(caller, {});
    const r = byName(results, "rail: no-sell screen rejects with next_step");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("next_step");
  });

  it("a thrown tool call becomes a FAIL for that check only", async () => {
    const caller = fakeCaller();
    const throwing: ToolCaller = {
      listTools: caller.listTools,
      callTool: async (name, args) => {
        if (name === "check_call_readiness") throw new Error("wire exploded");
        return caller.callTool(name, args);
      },
    };
    const results = await runChecks(throwing, {});
    const r = byName(results, "check_call_readiness reports simulated mode");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("wire exploded");
    expect(byName(results, "call_me converse round-trip").status).toBe("pass");
  });
});

describe("summarize — a run that verifies nothing is not green", () => {
  it("exit code 1 when zero checks passed (all skipped or failed)", () => {
    const allSkipped = [
      { name: "a", status: "skip", detail: "" },
      { name: "b", status: "skip", detail: "" },
    ] as const;
    const s = summarize([...allSkipped]);
    expect(s.passed).toBe(0);
    expect(s.code).toBe(1);
  });
});

// ── runSelftest exit-code contract ───────────────────────────────────────────

function captureStdout(): { write: (s: string) => void; text: () => string } {
  let buffer = "";
  return { write: (s: string) => (buffer += s), text: () => buffer };
}

describe("runSelftest — flags and failure exit codes (no build required)", () => {
  it("exits 2 on unknown flags", async () => {
    const out = captureStdout();
    const errs: string[] = [];
    const code = await runSelftest(["--bogus"], { stdout: out, stderr: (l) => errs.push(l) });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--bogus");
  });

  it("exits 2 on a non-numeric --timeout", async () => {
    const code = await runSelftest(["--timeout", "soon"], { stdout: captureStdout(), stderr: () => {} });
    expect(code).toBe(2);
  });

  it("a server entry that is not an MCP server yields FAIL + exit 1 (never a false green)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "speko-selftest-broken-"));
    const brokenEntry = join(dir, "broken.mjs");
    writeFileSync(brokenEntry, "process.exit(0);\n");
    const out = captureStdout();
    const code = await runSelftest(["--json", "--timeout", "20"], {
      entryPath: brokenEntry,
      env: { PATH: process.env.PATH },
      stdout: out,
      stderr: () => {},
    });
    expect(code).toBe(1);
    const report = JSON.parse(out.text()) as { ok: boolean; failed: number; note: string };
    expect(report.ok).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    expect(report.note).toContain("no real calls");
  }, 30_000);
});

// ── Spawn tier: the REAL built bundle (skipped when dist/ is absent) ─────────

const BUNDLE = resolve(HERE, "..", "dist", "index.js");

describe.skipIf(!existsSync(BUNDLE))("runSelftest — integration against the built bundle", () => {
  it("all checks pass against mcp/dist/index.js, even with a live-looking env", async () => {
    const out = captureStdout();
    const code = await runSelftest(["--json"], {
      entryPath: BUNDLE,
      env: {
        ...process.env,
        // A configured shell must not break the selftest: these are stripped for the child.
        SPEKO_API_KEY: "sk_live_configured_in_shell",
        SPEKO_MCP_SERVER_URL: "https://example.invalid",
        SPEKO_TOOLS: "",
        SPEKO_FAKE_NOW: "",
      },
      stdout: out,
      stderr: () => {},
    });
    const report = JSON.parse(out.text()) as {
      ok: boolean;
      passed: number;
      failed: number;
      skipped: number;
      stripped_env: string[];
      checks: Array<{ name: string; pass: boolean; detail: string }>;
    };
    expect(report.failed, JSON.stringify(report.checks.filter((c) => !c.pass))).toBe(0);
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(12);
    expect(report.stripped_env).toContain("SPEKO_API_KEY");
    expect(report.stripped_env).toContain("SPEKO_MCP_SERVER_URL");
  }, 60_000);
});
