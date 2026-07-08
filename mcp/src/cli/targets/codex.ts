/**
 * OpenAI Codex CLI. Preferred path: `codex mcp add` (remove-then-add, mirroring
 * the Claude Code flow) — the CLI owns the TOML and gets syntax/precedence right.
 * Fallback (CLI missing/failed): APPEND a `[mcp_servers.speko-calls]` block to
 * ~/.codex/config.toml. Append-only on purpose: without a real TOML parser we
 * must never rewrite a file that may hold user comments/structure. If the
 * section already exists we leave the file alone and say how to reset it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendGuidance } from "./guidance.js";
import { PKG, SERVER_NAME, serverEntry } from "./invocation.js";
import type { AgentTarget, TargetCtx } from "./types.js";

const SECTION_RE = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}[\\].]`, "m");

export function codexTomlBlock(key: string): string {
  const e = serverEntry(key);
  return [
    "",
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(e.command)}`,
    `args = [${e.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "",
    `[mcp_servers.${SERVER_NAME}.env]`,
    `SPEKO_API_KEY = ${JSON.stringify(key)}`,
    "",
  ].join("\n");
}

function appendToml(key: string, ctx: TargetCtx): { ok: boolean; detail: string } {
  const path = join(ctx.home, ".codex", "config.toml");
  try {
    const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
    if (SECTION_RE.test(raw)) {
      return {
        ok: true,
        detail: `${path} already has [mcp_servers.${SERVER_NAME}] — left as-is (run \`codex mcp remove ${SERVER_NAME}\` and re-run init to refresh the key).`,
      };
    }
    if (raw) writeFileSync(`${path}.speko-backup`, raw);
    else mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw + codexTomlBlock(key));
    return { ok: true, detail: path };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export const codexTarget: AgentTarget = {
  id: "codex",
  label: "Codex CLI",
  detect: (ctx) => existsSync(join(ctx.home, ".codex")) || ctx.hasCli("codex"),
  // Codex reads ~/.codex/AGENTS.md globally — marker-append the calling card there.
  installGuidance: (ctx) => appendGuidance(join(ctx.home, ".codex", "AGENTS.md")),
  write(key, ctx) {
    if (ctx.hasCli("codex")) {
      ctx.runCli("codex", ["mcp", "remove", SERVER_NAME]); // idempotent: ok to fail
      const status = ctx.runCli("codex", [
        "mcp",
        "add",
        SERVER_NAME,
        "--env",
        `SPEKO_API_KEY=${key}`,
        "--",
        "npx",
        "-y",
        PKG,
      ]);
      if (status === 0) {
        return { ok: true, detail: "added via `codex mcp add`", restartHint: "New codex sessions pick it up automatically." };
      }
    }
    const r = appendToml(key, ctx);
    return { ok: r.ok, detail: r.detail, ...(r.ok ? { restartHint: "New codex sessions pick it up automatically." } : {}) };
  },
};
