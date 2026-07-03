#!/usr/bin/env node
/**
 * Version-lockstep check (issue #37 M1). The published version lives in FIVE places that
 * have drifted before (server.json sat at 0.4.9 while package.json said 0.5.0 — hand-fixed
 * in f9deb5a). Fails loudly, naming every mismatched source, unless ALL agree:
 *
 *   1. mcp/package.json         .version
 *   2. mcp/server.json          .version            (top-level)
 *   3. mcp/server.json          .packages[0].version
 *   4. mcp/src/index.ts         const VERSION = "…"
 *   5. package-lock.json        .packages["mcp"].version
 *
 * Used by .github/workflows/version-drift.yml (every push/PR to main) and as the gate in
 * .github/workflows/publish.yml. `--tag vX.Y.Z` additionally asserts the git tag matches.
 * `--self-test` proves the checker actually detects drift (runs against a synthetic tree).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function collectVersions(root) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const sources = {
    "mcp/package.json .version": JSON.parse(read("mcp/package.json")).version,
    "mcp/server.json .version": JSON.parse(read("mcp/server.json")).version,
    "mcp/server.json .packages[0].version": JSON.parse(read("mcp/server.json")).packages?.[0]?.version,
    'mcp/src/index.ts const VERSION': read("mcp/src/index.ts").match(/const VERSION = "([^"]+)"/)?.[1],
    'package-lock.json .packages["mcp"].version': JSON.parse(read("package-lock.json")).packages?.mcp?.version,
  };
  return sources;
}

export function findDrift(sources, tag) {
  const entries = Object.entries(sources);
  const reference = entries[0][1];
  const mismatched = entries.filter(([, v]) => v !== reference).map(([k, v]) => `${k} = ${v ?? "(missing)"}`);
  if (mismatched.length) {
    return `version drift: expected everything to equal ${reference} (from ${entries[0][0]}), but:\n  ${mismatched.join("\n  ")}`;
  }
  if (tag !== undefined) {
    const tagVersion = tag.replace(/^v/, "");
    if (tagVersion !== reference) {
      return `tag mismatch: git tag ${tag} (=${tagVersion}) does not match package version ${reference}`;
    }
  }
  return null;
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "lockstep-selftest-"));
  try {
    mkdirSync(join(root, "mcp", "src"), { recursive: true });
    const write = (p, s) => writeFileSync(join(root, p), s);
    write("mcp/package.json", JSON.stringify({ version: "1.2.3" }));
    write("mcp/server.json", JSON.stringify({ version: "1.2.3", packages: [{ version: "1.2.3" }] }));
    write("mcp/src/index.ts", 'const VERSION = "1.2.3";\n');
    write("package-lock.json", JSON.stringify({ packages: { mcp: { version: "1.2.3" } } }));

    if (findDrift(collectVersions(root)) !== null) throw new Error("self-test: clean tree flagged as drifted");
    if (findDrift(collectVersions(root), "v1.2.3") !== null) throw new Error("self-test: matching tag flagged");
    if (findDrift(collectVersions(root), "v9.9.9") === null) throw new Error("self-test: tag mismatch NOT detected");

    write("mcp/server.json", JSON.stringify({ version: "1.2.4", packages: [{ version: "1.2.3" }] }));
    const drift = findDrift(collectVersions(root));
    if (drift === null) throw new Error("self-test: server.json drift NOT detected");
    if (!drift.includes("mcp/server.json .version")) throw new Error("self-test: drift message does not name the source");

    console.log("self-test passed: drift + tag-mismatch detection work");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const tagIdx = args.indexOf("--tag");
  let tag;
  if (tagIdx >= 0) {
    tag = args[tagIdx + 1];
    if (!tag || tag.startsWith("--")) {
      // Fail loudly — a missing value must never silently skip tag validation.
      console.error("--tag requires a value, e.g. --tag v0.5.1");
      process.exit(1);
    }
  }
  const sources = collectVersions(process.cwd());
  const problem = findDrift(sources, tag);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`version lockstep OK: ${Object.values(sources)[0]}${tag ? ` (matches ${tag})` : ""}`);
}
