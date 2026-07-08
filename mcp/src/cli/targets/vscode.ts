/**
 * VS Code (GitHub Copilot agent mode). Preferred path: `code --add-mcp <json>`,
 * which writes the right file for whatever VS Code version is installed.
 * Fallback (CLI not on PATH): merge the user-profile `mcp.json` directly —
 * note VS Code's schema differs from the rest: root key `servers`, and each
 * stdio entry carries an explicit `"type": "stdio"`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SERVER_NAME, serverEntry } from "./invocation.js";
import { mergeJsonFile } from "./jsonFile.js";
import { vscodeUserDir } from "./paths.js";
import type { AgentTarget } from "./types.js";

export const vscodeTarget: AgentTarget = {
  id: "vscode",
  label: "VS Code",
  detect: (ctx) => ctx.hasCli("code") || existsSync(vscodeUserDir(ctx)),
  write(key, ctx) {
    if (ctx.hasCli("code")) {
      const status = ctx.runCli("code", ["--add-mcp", JSON.stringify({ name: SERVER_NAME, ...serverEntry(key) })]);
      if (status === 0) {
        return { ok: true, detail: "added via `code --add-mcp`", restartHint: "Reload the VS Code window to load it." };
      }
    }
    const path = join(vscodeUserDir(ctx), "mcp.json");
    const r = mergeJsonFile(path, (cfg) => {
      const servers = (cfg.servers && typeof cfg.servers === "object" ? cfg.servers : {}) as Record<string, unknown>;
      return { ...cfg, servers: { ...servers, [SERVER_NAME]: { type: "stdio", ...serverEntry(key) } } };
    });
    return { ok: r.ok, detail: r.detail, ...(r.ok ? { restartHint: "Reload the VS Code window to load it." } : {}) };
  },
};
