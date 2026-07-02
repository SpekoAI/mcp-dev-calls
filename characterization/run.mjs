#!/usr/bin/env node
/**
 * Characterization runner.
 *
 *   node run.mjs --target tarball --capture     # record 0.4.9 baseline (once; then frozen)
 *   node run.mjs --target local                 # compare local build vs baseline (the gate)
 *   node run.mjs --target local --out runs/a.json
 *
 * Exit 0 only when every probe is parity-PASS or a justified delta-PASS.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpSession } from "./lib/mcp.mjs";
import { normalize, normalizeValue } from "./lib/normalize.mjs";
import { runCli } from "./lib/spawn.mjs";
import { baseSessionEnv, buildMatrix, makeGuardDir } from "./probes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(HERE, "baseline");
const TARBALL_BUNDLE = join(HERE, "fixtures", "v0.4.9", "dist", "index.js");
const LOCAL_BUNDLE = join(HERE, "..", "mcp", "dist", "index.js");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};
const stringFlag = (name) => {
  const v = flag(name);
  return typeof v === "string" ? v : undefined;
};

const target = flag("target");
const capture = flag("capture") === true;
const outPath = stringFlag("out");
// --bundle <path> overrides the resolved bundle (used to characterize the actually-published
// 0.5.0 tarball, not just the local build). Target still labels the run report.
const bundleOverride = stringFlag("bundle");
if (!["tarball", "local"].includes(target)) {
  console.error("Usage: run.mjs --target tarball|local [--capture] [--out file.json] [--bundle path]");
  process.exit(1);
}
// Integrity guard: --capture freezes the baseline and stamps meta.json as the 0.4.9 tarball
// (hardcoded version + shasum of fixtures/mcp-calls-0.4.9.tgz). Allowing --bundle here would
// let a DIFFERENT bundle overwrite the baseline under a meta that falsely claims 0.4.9.
if (capture && bundleOverride) {
  console.error("Refusing --capture with --bundle: the baseline may only be captured from the frozen 0.4.9 tarball.");
  process.exit(1);
}
const bundle = bundleOverride ?? (target === "tarball" ? TARBALL_BUNDLE : LOCAL_BUNDLE);
if (!existsSync(bundle)) {
  console.error(`Bundle not found: ${bundle}`);
  process.exit(1);
}

function normalizeToolResult(msg) {
  if (msg.error) return { rpcError: normalize(String(msg.error.message ?? msg.error.code)) };
  const r = msg.result ?? {};
  const text = Array.isArray(r.content) ? r.content.map((c) => (c?.type === "text" ? c.text : `<${c?.type}>`)).join("\n") : "";
  return { isError: Boolean(r.isError), text: normalize(text) };
}

async function runMatrix() {
  const { sessions, cli } = buildMatrix();
  const results = {};
  const isolatedCwd = mkdtempSync(join(tmpdir(), "char-cwd-"));

  // Per-probe isolation: each probe gets a FRESH guard-state dir and its own server spawn.
  // Without this, dial-reaching probes in a shared dir append to the ledger and the rate cap
  // trips on later probes (a harness artifact, not real behavior). Guard-accumulation probes
  // (dnc-seeded / ledger-seeded / trusted) carry a session.seed that re-runs into their fresh dir.
  for (const session of sessions) {
    const env0 = session.env ?? {};
    for (const probe of session.probes) {
      const guardDir = makeGuardDir();
      if (session.seed) session.seed(guardDir);
      const env = { ...baseSessionEnv(guardDir), ...env0 };
      const mcp = new McpSession(bundle, { env, cwd: isolatedCwd });
      const init = await mcp.initialize();
      if (probe.meta === "initialize") {
        results[probe.id] = { serverInfo: normalizeValue(init.result?.serverInfo ?? init.error ?? null) };
      } else if (probe.meta === "tools-list") {
        const list = await mcp.listTools();
        const tools = (list.result?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        tools.sort((a, b) => a.name.localeCompare(b.name));
        results[probe.id] = normalizeValue({ tools });
      } else {
        const res = await mcp.callTool(probe.tool, probe.args(), probe.timeoutMs ?? 60_000);
        results[probe.id] = normalizeToolResult(res);
      }
      mcp.close();
    }
  }

  // CLI probes share one guard dir so the dnc add/list sequence is meaningful and fresh per run.
  const cliGuard = makeGuardDir();
  for (const probe of cli) {
    const { code, stdout, stderr } = await runCli(bundle, probe.argv, {
      cwd: isolatedCwd,
      env: { ...baseSessionEnv(cliGuard) },
      timeoutMs: 30_000,
    });
    results[probe.id] = { code, stdout: normalize(stdout), stderr: normalize(stderr) };
  }
  return results;
}

function loadDeltas() {
  const p = join(HERE, "expected-deltas.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : [];
}

function deltaMatches(delta, actual) {
  const hay = JSON.stringify(actual);
  if (Array.isArray(delta.expectContains)) return delta.expectContains.every((s) => hay.includes(s));
  if (typeof delta.expectRegex === "string") return new RegExp(delta.expectRegex, "i").test(hay);
  return false;
}

const results = await runMatrix();

if (capture) {
  if (target !== "tarball") {
    console.error("--capture is only valid with --target tarball (baseline = published 0.4.9 only)");
    process.exit(1);
  }
  mkdirSync(BASELINE_DIR, { recursive: true });
  for (const [id, value] of Object.entries(results)) {
    writeFileSync(join(BASELINE_DIR, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  const shasum = execSync("shasum fixtures/mcp-calls-0.4.9.tgz", { cwd: HERE }).toString().split(" ")[0];
  writeFileSync(
    join(BASELINE_DIR, "meta.json"),
    `${JSON.stringify({ package: "@spekoai/mcp-calls", version: "0.4.9", tarballShasum: shasum, probeCount: Object.keys(results).length, capturedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`Captured ${Object.keys(results).length} baseline probes to ${BASELINE_DIR}`);
  process.exit(0);
}

// Compare mode
const deltas = loadDeltas();
const deltaById = new Map(deltas.map((d) => [d.probeId, d]));
let parityPass = 0;
let deltaPass = 0;
const failures = [];

for (const [id, actual] of Object.entries(results)) {
  const baselinePath = join(BASELINE_DIR, `${id}.json`);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf-8")) : undefined;
  const delta = deltaById.get(id);

  if (delta) {
    if (!delta.justification || !(Array.isArray(delta.expectContains) || delta.expectRegex)) {
      failures.push({ id, why: "delta entry missing justification or concrete expect", actual });
    } else if (deltaMatches(delta, actual)) {
      deltaPass++;
    } else {
      failures.push({ id, why: "delta expectation not met by actual output", expected: delta, actual });
    }
    continue;
  }
  if (baseline === undefined) {
    failures.push({ id, why: "no baseline snapshot and no delta entry (new probe must be captured or declared)", actual });
    continue;
  }
  if (JSON.stringify(baseline) === JSON.stringify(actual)) {
    parityPass++;
  } else {
    failures.push({ id, why: "PARITY BREAK: differs from 0.4.9 baseline and not in expected-deltas", baseline, actual });
  }
}

const sha = execSync("git rev-parse HEAD", { cwd: join(HERE, "..") }).toString().trim();
const report = {
  target,
  bundle,
  gitSha: sha,
  totals: { probes: Object.keys(results).length, parityPass, deltaPass, failures: failures.length },
  failures,
};
if (outPath) {
  const outAbs = join(HERE, outPath);
  mkdirSync(dirname(outAbs), { recursive: true }); // runs/ is gitignored; ensure it exists per checkout
  writeFileSync(outAbs, `${JSON.stringify({ report, results }, null, 2)}\n`);
}

console.log(`probes=${report.totals.probes} parity=${parityPass} delta=${deltaPass} failures=${failures.length} sha=${sha}`);
for (const f of failures) {
  console.log(`\nFAIL ${f.id} - ${f.why}`);
  if (f.baseline !== undefined) console.log(`  baseline: ${JSON.stringify(f.baseline).slice(0, 400)}`);
  console.log(`  actual  : ${JSON.stringify(f.actual).slice(0, 400)}`);
}
process.exit(failures.length === 0 ? 0 : 1);
