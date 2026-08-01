/**
 * OpenAI Codex CLI. Preferred path: `codex mcp add` (remove-then-add, mirroring
 * the Claude Code flow) — the CLI owns the TOML and gets syntax/precedence right.
 * Fallback (CLI missing/failed): add a `[mcp_servers.speko-calls]` block to
 * ~/.codex/config.toml. If it already exists, update only the timeout and Speko
 * env keys while preserving unrelated lines and comments.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendGuidance } from "./guidance.js";
import { PKG, SERVER_NAME, serverEntry } from "./invocation.js";
import type { AgentTarget, TargetCtx } from "./types.js";

const SERVER_SECTION = `[mcp_servers.${SERVER_NAME}]`;
const ENV_SECTION = `[mcp_servers.${SERVER_NAME}.env]`;

export function codexTomlBlock(key: string): string {
  const e = serverEntry(key, "codex");
  return [
    "",
    SERVER_SECTION,
    `command = ${JSON.stringify(e.command)}`,
    `args = [${e.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "tool_timeout_sec = 2700",
    "",
    ENV_SECTION,
    `SPEKO_API_KEY = ${JSON.stringify(key)}`,
    'SPEKO_CLIENT_PROFILE = "codex"',
    "",
  ].join("\n");
}

function sectionEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) return i;
  }
  return lines.length;
}

function upsertSectionValue(lines: string[], header: string, key: string, rendered: string): void {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return;
  const end = sectionEnd(lines, start);
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  const existing = lines.findIndex((line, index) => index > start && index < end && keyRe.test(line));
  if (existing >= 0) lines[existing] = `${key} = ${rendered}`;
  else lines.splice(end, 0, `${key} = ${rendered}`);
}

/** Update only the Speko sections, preserving every unrelated TOML line/comment. */
function writeToml(key: string, ctx: TargetCtx): { ok: boolean; detail: string } {
  const path = join(ctx.home, ".codex", "config.toml");
  try {
    const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
    if (raw) writeFileSync(`${path}.speko-backup`, raw);
    else mkdirSync(dirname(path), { recursive: true });
    if (!raw.split(/\r?\n/).some((line) => line.trim() === SERVER_SECTION)) {
      writeFileSync(path, raw + codexTomlBlock(key));
      return { ok: true, detail: path };
    }

    const lines = raw.split(/\r?\n/);
    upsertSectionValue(lines, SERVER_SECTION, "tool_timeout_sec", "2700");
    if (!lines.some((line) => line.trim() === ENV_SECTION)) {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(ENV_SECTION, `SPEKO_API_KEY = ${JSON.stringify(key)}`, 'SPEKO_CLIENT_PROFILE = "codex"', "");
    } else {
      upsertSectionValue(lines, ENV_SECTION, "SPEKO_API_KEY", JSON.stringify(key));
      upsertSectionValue(lines, ENV_SECTION, "SPEKO_CLIENT_PROFILE", '"codex"');
    }
    writeFileSync(path, lines.join("\n"));
    return { ok: true, detail: path };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export const codexTarget: AgentTarget = {
  id: "codex",
  label: "Codex CLI",
  profile: "codex",
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
        "--env",
        "SPEKO_CLIENT_PROFILE=codex",
        "--",
        "npx",
        "-y",
        PKG,
      ]);
      if (status === 0) {
        const patched = writeToml(key, ctx);
        return {
          ok: patched.ok,
          detail: patched.ok ? "added via `codex mcp add`; set tool_timeout_sec = 2700" : patched.detail,
          ...(patched.ok ? { restartHint: "New codex sessions pick it up automatically." } : {}),
        };
      }
    }
    const r = writeToml(key, ctx);
    return { ok: r.ok, detail: r.detail, ...(r.ok ? { restartHint: "New codex sessions pick it up automatically." } : {}) };
  },
};
