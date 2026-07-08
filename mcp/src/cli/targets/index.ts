/**
 * Registry + selection for the multi-agent init wizard.
 *
 * `code` and `desktop` (Claude Code / Claude Desktop) are pseudo-ids handled by
 * init.ts's proven writers — they are NOT in ALL_TARGETS; everything else is an
 * AgentTarget adapter. Selection is a pure function (unit-testable):
 *   - no flag / "all"  → every detected agent
 *   - "both"           → code + desktop (exact pre-0.6 behavior)
 *   - "a,b,c"          → exactly those, forced even if undetected
 */
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { codexTarget } from "./codex.js";
import { clineTarget, cursorTarget, geminiTarget, windsurfTarget } from "./standardJson.js";
import { vscodeTarget } from "./vscode.js";
import { zedTarget } from "./zed.js";
import type { AgentTarget, TargetCtx } from "./types.js";

export const ALL_TARGETS: AgentTarget[] = [
  cursorTarget,
  windsurfTarget,
  vscodeTarget,
  geminiTarget,
  codexTarget,
  clineTarget,
  zedTarget,
];

export const CLAUDE_IDS = ["code", "desktop"] as const;

export const TARGET_LABELS: Record<string, string> = {
  code: "Claude Code",
  desktop: "Claude Desktop",
  ...Object.fromEntries(ALL_TARGETS.map((t) => [t.id, t.label])),
};

const KNOWN_IDS = Object.keys(TARGET_LABELS);

export interface Selection {
  ids: string[];
  /** true when the user named agents explicitly (write even if undetected). */
  forced: boolean;
  invalid: string[];
}

export function resolveSelection(flag: string | undefined, detectedIds: string[]): Selection {
  const v = (flag ?? "").trim().toLowerCase();
  if (!v || v === "all") return { ids: detectedIds, forced: false, invalid: [] };
  if (v === "both") return { ids: ["code", "desktop"], forced: true, invalid: [] };
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    ids: parts.filter((p) => KNOWN_IDS.includes(p)),
    forced: true,
    invalid: parts.filter((p) => !KNOWN_IDS.includes(p)),
  };
}

/** Production context: real HOME/platform/CLIs. Tests build their own. */
export function realCtx(): TargetCtx {
  return {
    home: homedir(),
    platform: platform(),
    env: process.env,
    hasCli(cmd) {
      try {
        return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    },
    runCli(cmd, args) {
      try {
        return spawnSync(cmd, args, { stdio: "ignore" }).status;
      } catch {
        return null;
      }
    },
  };
}
