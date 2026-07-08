/**
 * Multi-agent init targets: the parity + safety guarantees, as tests.
 *  - every adapter writes the SAME logical (command,args,env) triple (anti-drift)
 *  - writes are idempotent, merge-safe (never clobber other servers/settings),
 *    backed up, and refuse to touch malformed files
 *  - detection is marker-based; selection resolves flags with back-compat
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexTarget, codexTomlBlock } from "../src/cli/targets/codex.js";
import { PKG, SERVER_NAME, serverEntry } from "../src/cli/targets/invocation.js";
import { ALL_TARGETS, TARGET_LABELS, resolveSelection } from "../src/cli/targets/index.js";
import { clineTarget, cursorTarget, geminiTarget, windsurfTarget } from "../src/cli/targets/standardJson.js";
import { vscodeTarget } from "../src/cli/targets/vscode.js";
import { zedTarget } from "../src/cli/targets/zed.js";
import type { TargetCtx } from "../src/cli/targets/types.js";

const KEY = "sk_test_targets_123";

let homes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "speko-targets-"));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function fakeCtx(home: string, over: Partial<TargetCtx> = {}): TargetCtx {
  return { home, platform: "darwin", env: {}, hasCli: () => false, runCli: () => null, ...over };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8")) as Record<string, any>;

describe("standard mcpServers adapters (Cursor / Windsurf / Gemini / Cline)", () => {
  const cases = [
    { target: cursorTarget, marker: [".cursor"], config: [".cursor", "mcp.json"] },
    { target: windsurfTarget, marker: [".codeium", "windsurf"], config: [".codeium", "windsurf", "mcp_config.json"] },
    { target: geminiTarget, marker: [".gemini"], config: [".gemini", "settings.json"] },
  ] as const;

  for (const { target, marker, config } of cases) {
    it(`${target.id}: detects by marker, writes the canonical entry, idempotently`, () => {
      const home = freshHome();
      const ctx = fakeCtx(home);
      expect(target.detect(ctx)).toBe(false);
      mkdirSync(join(home, ...marker), { recursive: true });
      expect(target.detect(ctx)).toBe(true);

      expect(target.write(KEY, ctx).ok).toBe(true);
      const path = join(home, ...config);
      const first = readJson(path);
      expect(first.mcpServers[SERVER_NAME]).toEqual(serverEntry(KEY));

      // idempotent: second write yields the identical file, no duplicates
      expect(target.write(KEY, ctx).ok).toBe(true);
      expect(readJson(path)).toEqual(first);
    });

    it(`${target.id}: merge preserves existing servers + unrelated settings, and backs up`, () => {
      const home = freshHome();
      const ctx = fakeCtx(home);
      const path = join(home, ...config);
      mkdirSync(join(home, ...marker), { recursive: true });
      writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "foo" } } }));

      expect(target.write(KEY, ctx).ok).toBe(true);
      const cfg = readJson(path);
      expect(cfg.theme).toBe("dark");
      expect(cfg.mcpServers.other).toEqual({ command: "foo" });
      expect(cfg.mcpServers[SERVER_NAME]).toEqual(serverEntry(KEY));
      expect(existsSync(`${path}.speko-backup`)).toBe(true);
    });

    it(`${target.id}: refuses to touch a malformed config`, () => {
      const home = freshHome();
      const ctx = fakeCtx(home);
      const path = join(home, ...config);
      mkdirSync(join(home, ...marker), { recursive: true });
      writeFileSync(path, "{ not json !!!");

      const r = target.write(KEY, ctx);
      expect(r.ok).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe("{ not json !!!"); // untouched
    });
  }

  it("cline: gated on the extension's globalStorage; adds disabled/autoApprove fields", () => {
    const home = freshHome();
    const ctx = fakeCtx(home);
    expect(clineTarget.detect(ctx)).toBe(false); // VS Code alone is not Cline

    const extDir = join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
    mkdirSync(extDir, { recursive: true });
    expect(clineTarget.detect(ctx)).toBe(true);

    expect(clineTarget.write(KEY, ctx).ok).toBe(true);
    const cfg = readJson(join(extDir, "settings", "cline_mcp_settings.json"));
    expect(cfg.mcpServers[SERVER_NAME]).toEqual({ ...serverEntry(KEY), disabled: false, autoApprove: [] });
  });
});

describe("VS Code adapter", () => {
  it("prefers `code --add-mcp` and passes the canonical entry", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const ctx = fakeCtx(freshHome(), {
      hasCli: (cmd) => cmd === "code",
      runCli: (cmd, args) => (calls.push({ cmd, args }), 0),
    });
    const r = vscodeTarget.write(KEY, ctx);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("code");
    expect(calls[0].args[0]).toBe("--add-mcp");
    // Explicit type:"stdio" so the CLI payload matches the file-fallback schema (Greptile #53).
    expect(JSON.parse(calls[0].args[1])).toEqual({ name: SERVER_NAME, type: "stdio", ...serverEntry(KEY) });
  });

  it("falls back to the user-profile mcp.json with the `servers` root key + type:stdio", () => {
    const home = freshHome();
    const ctx = fakeCtx(home); // no CLI
    expect(vscodeTarget.write(KEY, ctx).ok).toBe(true);
    const cfg = readJson(join(home, "Library", "Application Support", "Code", "User", "mcp.json"));
    expect(cfg.servers[SERVER_NAME]).toEqual({ type: "stdio", ...serverEntry(KEY) });
  });
});

describe("Codex adapter", () => {
  it("prefers `codex mcp add` (remove-then-add, canonical args)", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const ctx = fakeCtx(freshHome(), {
      hasCli: (cmd) => cmd === "codex",
      runCli: (cmd, args) => (calls.push({ cmd, args }), 0),
    });
    expect(codexTarget.write(KEY, ctx).ok).toBe(true);
    expect(calls.map((c) => c.args[1])).toEqual(["remove", "add"]);
    expect(calls[1].args).toEqual(["mcp", "add", SERVER_NAME, "--env", `SPEKO_API_KEY=${KEY}`, "--", "npx", "-y", PKG]);
  });

  it("TOML fallback: append-only, preserves existing content, idempotent, backed up", () => {
    const home = freshHome();
    const ctx = fakeCtx(home); // no CLI
    const path = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const prior = '# my codex config\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "foo"\n';
    writeFileSync(path, prior);

    expect(codexTarget.write(KEY, ctx).ok).toBe(true);
    const after = readFileSync(path, "utf-8");
    expect(after.startsWith(prior)).toBe(true); // append never rewrites
    expect(after).toContain(`[mcp_servers.${SERVER_NAME}]`);
    expect(after).toContain(`SPEKO_API_KEY = ${JSON.stringify(KEY)}`);
    expect(existsSync(`${path}.speko-backup`)).toBe(true);

    // idempotent: section already present → left as-is, still ok
    const r2 = codexTarget.write(KEY, ctx);
    expect(r2.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(after);
  });

  it("TOML block escapes values safely", () => {
    const block = codexTomlBlock('k"with\\quotes');
    expect(block).toContain('SPEKO_API_KEY = "k\\"with\\\\quotes"');
  });
});

describe("Zed adapter", () => {
  it("never writes — returns a manual snippet for the detected settings file", () => {
    const home = freshHome();
    mkdirSync(join(home, ".config", "zed"), { recursive: true });
    const ctx = fakeCtx(home);
    expect(zedTarget.detect(ctx)).toBe(true);
    const r = zedTarget.write(KEY, ctx);
    expect(r.ok).toBe(false);
    expect(r.manual).toContain("context_servers");
    expect(existsSync(join(home, ".config", "zed", "settings.json"))).toBe(false);
  });
});

describe("parity: every auto-writing adapter emits the same logical invocation", () => {
  it("command/args/env are identical across Cursor, Windsurf, Gemini, Cline, VS Code, Codex", () => {
    const entries: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

    for (const t of [cursorTarget, windsurfTarget, geminiTarget]) {
      const home = freshHome();
      mkdirSync(join(home, `.${t.id === "windsurf" ? "codeium/windsurf" : t.id === "gemini" ? "gemini" : "cursor"}`), {
        recursive: true,
      });
      t.write(KEY, fakeCtx(home));
      const file = t.id === "cursor" ? ".cursor/mcp.json" : t.id === "windsurf" ? ".codeium/windsurf/mcp_config.json" : ".gemini/settings.json";
      const { command, args, env } = readJson(join(home, file)).mcpServers[SERVER_NAME];
      entries[t.id] = { command, args, env };
    }
    {
      const home = freshHome();
      mkdirSync(join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"), { recursive: true });
      clineTarget.write(KEY, fakeCtx(home));
      const { command, args, env } = readJson(
        join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      ).mcpServers[SERVER_NAME];
      entries.cline = { command, args, env };
    }
    {
      const home = freshHome();
      vscodeTarget.write(KEY, fakeCtx(home));
      const { command, args, env } = readJson(join(home, "Library", "Application Support", "Code", "User", "mcp.json")).servers[SERVER_NAME];
      entries.vscode = { command, args, env };
    }
    {
      const home = freshHome();
      codexTarget.write(KEY, fakeCtx(home));
      const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
      expect(toml).toContain('command = "npx"');
      expect(toml).toContain(`args = ["-y", ${JSON.stringify(PKG)}]`);
      expect(toml).toContain(`SPEKO_API_KEY = ${JSON.stringify(KEY)}`);
    }

    const canonical = serverEntry(KEY);
    for (const [id, e] of Object.entries(entries)) {
      expect(e, `adapter '${id}' drifted from the canonical invocation`).toEqual(canonical);
    }
  });
});

describe("resolveSelection — flag semantics + back-compat", () => {
  it("no flag / 'all' → detected set", () => {
    expect(resolveSelection(undefined, ["code", "cursor"])).toEqual({ ids: ["code", "cursor"], forced: false, invalid: [] });
    expect(resolveSelection("all", ["gemini"])).toEqual({ ids: ["gemini"], forced: false, invalid: [] });
  });
  it("'both' keeps the pre-0.6 meaning: Claude Code + Desktop, forced", () => {
    expect(resolveSelection("both", [])).toEqual({ ids: ["code", "desktop"], forced: true, invalid: [] });
  });
  it("comma list forces exactly those; unknown names are reported, not written", () => {
    expect(resolveSelection("cursor,codex", [])).toEqual({ ids: ["cursor", "codex"], forced: true, invalid: [] });
    expect(resolveSelection("cursor,frobnicate", [])).toEqual({ ids: ["cursor"], forced: true, invalid: ["frobnicate"] });
  });
  it("every registered target id resolves and has a label", () => {
    for (const t of ALL_TARGETS) {
      expect(resolveSelection(t.id, []).ids).toEqual([t.id]);
      expect(TARGET_LABELS[t.id]).toBeTruthy();
    }
  });
});
