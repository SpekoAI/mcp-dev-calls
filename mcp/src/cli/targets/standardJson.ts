/**
 * The `mcpServers`-family adapters: Cursor, Windsurf, Gemini CLI, and Cline all
 * share the standard `{ "mcpServers": { name: { command, args, env } } }` JSON
 * shape — only the file path, detection marker, and (for Cline) two extra
 * fields differ. One factory, four targets.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SERVER_NAME, serverEntry } from "./invocation.js";
import { mergeJsonFile } from "./jsonFile.js";
import { clineSettingsPath, vscodeUserDir } from "./paths.js";
import type { AgentTarget, TargetCtx } from "./types.js";

function upsertMcpServers(
  cfg: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}) as Record<
    string,
    unknown
  >;
  return { ...cfg, mcpServers: { ...servers, [SERVER_NAME]: entry } };
}

function standardTarget(opts: {
  id: string;
  label: string;
  configPath: (ctx: TargetCtx) => string;
  detect: (ctx: TargetCtx) => boolean;
  restartHint: string;
  /** Extra per-agent fields merged into the server entry (e.g. Cline's autoApprove). */
  extraFields?: Record<string, unknown>;
}): AgentTarget {
  return {
    id: opts.id,
    label: opts.label,
    detect: opts.detect,
    write(key, ctx) {
      const path = opts.configPath(ctx);
      const entry = { ...serverEntry(key), ...(opts.extraFields ?? {}) };
      const r = mergeJsonFile(path, (cfg) => upsertMcpServers(cfg, entry));
      return { ok: r.ok, detail: r.detail, ...(r.ok ? { restartHint: opts.restartHint } : {}) };
    },
  };
}

export const cursorTarget = standardTarget({
  id: "cursor",
  label: "Cursor",
  configPath: (ctx) => join(ctx.home, ".cursor", "mcp.json"),
  detect: (ctx) => existsSync(join(ctx.home, ".cursor")),
  restartHint: "Reload Cursor to load it (Settings → MCP lists the server).",
});

export const windsurfTarget = standardTarget({
  id: "windsurf",
  label: "Windsurf",
  configPath: (ctx) => join(ctx.home, ".codeium", "windsurf", "mcp_config.json"),
  detect: (ctx) => existsSync(join(ctx.home, ".codeium", "windsurf")),
  restartHint: "Reload Windsurf (Cascade → MCP) to load it.",
});

export const geminiTarget = standardTarget({
  id: "gemini",
  label: "Gemini CLI",
  configPath: (ctx) => join(ctx.home, ".gemini", "settings.json"),
  detect: (ctx) => existsSync(join(ctx.home, ".gemini")) || ctx.hasCli("gemini"),
  restartHint: "Restart gemini (or run /mcp refresh) to load it.",
});

export const clineTarget = standardTarget({
  id: "cline",
  label: "Cline",
  configPath: clineSettingsPath,
  // The extension's globalStorage dir exists only once Cline has run — writing a
  // config for an uninstalled extension would be a stray file, so gate on it.
  detect: (ctx) => existsSync(join(vscodeUserDir(ctx), "globalStorage", "saoudrizwan.claude-dev")),
  restartHint: "Reload the VS Code window; the server appears in Cline's MCP panel.",
  extraFields: { disabled: false, autoApprove: [] },
});
