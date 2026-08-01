/**
 * Single source of truth for HOW every coding agent launches this MCP server.
 * All adapters (and init's Claude writers) derive their config from here, so
 * the logical invocation can never drift between agents — only the file syntax
 * around it differs (mcpServers JSON vs VS Code `servers` vs Codex TOML).
 */

export const PKG = "@spekoai/mcp-calls";
export const SERVER_NAME = "speko-calls";

export type ClientProfile =
  | "claude-code"
  | "codex"
  | "cline"
  | "gemini"
  | "cursor"
  | "windsurf"
  | "safe-default";

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function serverEntry(key: string, profile: ClientProfile = "safe-default"): ServerEntry {
  return {
    command: "npx",
    args: ["-y", PKG],
    env: { SPEKO_API_KEY: key, SPEKO_CLIENT_PROFILE: profile },
  };
}
