import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, setDotenvMode } from "../src/lib/env.js";

/**
 * .env discovery is mode-gated: in MCP-server mode the cwd is an untrusted user repo,
 * so a planted .env there must NOT be able to repoint SPEKO_MCP_SERVER_URL.
 * Unique canary var names per test because loadEnvFile mutates the real process.env.
 */

const CANARIES = ["SPEKO_TEST_CANARY_SRV", "SPEKO_TEST_CANARY_ALLOW", "SPEKO_TEST_CANARY_CLI", "SPEKO_TEST_CANARY_NO"];
let savedServerUrl: string | undefined;
const tmpDirs: string[] = [];

function plantedDotenvDir(canary: string): string {
  const dir = mkdtempSync(join(tmpdir(), "speko-env-test-"));
  tmpDirs.push(dir);
  // Hostile shape: tries to repoint the backing server AND set a canary we can assert on.
  writeFileSync(join(dir, ".env"), `SPEKO_MCP_SERVER_URL=http://attacker.invalid:1\n${canary}=1\n`);
  return dir;
}

beforeEach(() => {
  savedServerUrl = process.env.SPEKO_MCP_SERVER_URL;
  delete process.env.SPEKO_MCP_SERVER_URL;
});

afterEach(() => {
  setDotenvMode("cli");
  if (savedServerUrl === undefined) delete process.env.SPEKO_MCP_SERVER_URL;
  else process.env.SPEKO_MCP_SERVER_URL = savedServerUrl;
  for (const name of CANARIES) delete process.env[name];
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("loadEnv mode gating", () => {
  it("MCP-server mode skips a planted .env in the cwd entirely", () => {
    const dir = plantedDotenvDir("SPEKO_TEST_CANARY_SRV");
    const lines: string[] = [];
    setDotenvMode("mcp-server");
    const loaded = loadEnv({ cwd: dir, stderr: (l) => lines.push(l) });
    expect(loaded).toBeNull();
    expect(process.env.SPEKO_TEST_CANARY_SRV).toBeUndefined();
    expect(process.env.SPEKO_MCP_SERVER_URL).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("MCP-server mode loads only with the explicit SPEKO_ALLOW_DOTENV=1 opt-in", () => {
    const dir = plantedDotenvDir("SPEKO_TEST_CANARY_ALLOW");
    const lines: string[] = [];
    setDotenvMode("mcp-server");
    const loaded = loadEnv({ cwd: dir, env: { ...process.env, SPEKO_ALLOW_DOTENV: "1" }, stderr: (l) => lines.push(l) });
    expect(loaded).toBe(join(dir, ".env"));
    expect(process.env.SPEKO_TEST_CANARY_ALLOW).toBe("1");
    expect(lines.join("\n")).toContain(join(dir, ".env"));
  });

  it("CLI mode loads the .env and announces the absolute path on stderr, once", () => {
    const dir = plantedDotenvDir("SPEKO_TEST_CANARY_CLI");
    const lines: string[] = [];
    setDotenvMode("cli");
    const loaded = loadEnv({ cwd: dir, stderr: (l) => lines.push(l) });
    expect(loaded).toBe(join(dir, ".env"));
    expect(process.env.SPEKO_TEST_CANARY_CLI).toBe("1");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(dir, ".env"));
    expect(lines[0]).toContain("SPEKO_NO_DOTENV");
    // Repeat call (status → serverClient both call loadEnv): no stderr spam.
    loadEnv({ cwd: dir, stderr: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
  });

  it("SPEKO_NO_DOTENV=1 force-disables discovery in ALL modes, even CLI", () => {
    const dir = plantedDotenvDir("SPEKO_TEST_CANARY_NO");
    setDotenvMode("cli");
    const loaded = loadEnv({ cwd: dir, env: { ...process.env, SPEKO_NO_DOTENV: "1" } });
    expect(loaded).toBeNull();
    expect(process.env.SPEKO_TEST_CANARY_NO).toBeUndefined();
  });

  it("returns null when no .env exists anywhere on the candidate path", () => {
    const dir = mkdtempSync(join(tmpdir(), "speko-env-none-"));
    tmpDirs.push(dir);
    setDotenvMode("cli");
    // Note: candidates include dirs relative to the module itself; this repo keeps no
    // checked-in .env, so an empty cwd must resolve to "nothing loaded".
    expect(loadEnv({ cwd: dir })).toBeNull();
  });
});
