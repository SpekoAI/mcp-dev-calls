/**
 * Per-platform config locations for the agents whose paths aren't a simple
 * dotdir under $HOME. Kept in one place so the path knowledge (which drifts
 * as vendors move things) has exactly one home.
 */
import { join } from "node:path";
import type { TargetCtx } from "./types.js";

/** VS Code's per-user config dir (also the parent of extension globalStorage). */
export function vscodeUserDir(ctx: TargetCtx): string {
  if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support", "Code", "User");
  if (ctx.platform === "win32")
    return join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "Code", "User");
  return join(ctx.home, ".config", "Code", "User");
}

/** Cline (VS Code extension) settings file — exists only once the extension has run. */
export function clineSettingsPath(ctx: TargetCtx): string {
  return join(vscodeUserDir(ctx), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
}

export function zedSettingsPath(ctx: TargetCtx): string {
  if (ctx.platform === "win32") return join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "Zed", "settings.json");
  return join(ctx.home, ".config", "zed", "settings.json");
}
