/**
 * Pure CLI routing decision, kept side-effect-free so the MCP-stdio invariant is unit-testable.
 * A recognized subcommand → CLI. Otherwise: an interactive terminal (TTY stdin) → help, like most
 * CLI tools; a piped, non-TTY stdin (how an MCP host spawns us over stdio) → the stdio MCP server.
 */
export const CLI_COMMANDS = [
  "init",
  "setup",
  "login",
  "audio",
  "dnc",
  "voices",
  "models",
  "--help",
  "-h",
  "--version",
  "-V",
] as const;

export type CliMode = { kind: "cli"; name: string } | { kind: "help" } | { kind: "server" };

export function resolveMode(argv: string[], opts: { stdinIsTTY?: boolean } = {}): CliMode {
  const cmd = argv[2];
  if (cmd && (CLI_COMMANDS as readonly string[]).includes(cmd)) {
    return { kind: "cli", name: cmd };
  }
  // No recognized command. A human at a terminal gets help; an MCP host (piped, non-TTY stdin)
  // still falls through to the stdio server — so the MCP integration is never affected.
  if (opts.stdinIsTTY) return { kind: "help" };
  return { kind: "server" };
}
