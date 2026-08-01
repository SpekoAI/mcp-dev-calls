/**
 * Multi-agent config targets: the shared contract every coding-agent adapter
 * implements, plus the injectable context that makes adapters unit-testable
 * (temp HOME, fake platform, fake CLI runner) without touching a real machine.
 *
 * Parity invariant: every adapter derives command/args/key from `serverEntry()`
 * and supplies its declared client profile. Only profile-specific timeout fields
 * may differ (see targets.test.ts).
 */

export interface TargetCtx {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** `spawnSync(cmd, ["--version"])` probe — injectable for tests. */
  hasCli(cmd: string): boolean;
  /** Run a CLI helper (`code`, `codex`, …). Returns the exit status (null = spawn failure). */
  runCli(cmd: string, args: string[]): number | null;
}

export interface WriteResult {
  ok: boolean;
  /** One human line: what happened (path written / CLI used / why it didn't). */
  detail: string;
  /** Set when the user must finish by hand (e.g. Zed's commented JSONC settings). */
  manual?: string;
  /** Per-agent "reload to pick it up" hint, shown only on success. */
  restartHint?: string;
}

export interface AgentTarget {
  id: string;
  label: string;
  /** Timeout behavior enforced by the in-process call_me server. */
  profile: import("./invocation.js").ClientProfile;
  detect(ctx: TargetCtx): boolean;
  write(key: string, ctx: TargetCtx): WriteResult;
  /**
   * Install the calling-card guidance in THIS agent's rules convention (Codex
   * AGENTS.md, Gemini GEMINI.md, …). Absent when the agent has no safe global
   * rules file (Cursor keeps user rules in internal storage; Zed is manual).
   */
  installGuidance?(ctx: TargetCtx): WriteResult;
}
