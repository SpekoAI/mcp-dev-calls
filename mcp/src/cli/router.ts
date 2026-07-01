/**
 * Pure CLI routing decision, kept side-effect-free so the MCP-stdio invariant
 * (bare `speko-calls` = the stdio server) is unit-testable without booting the server.
 */
export const CLI_COMMANDS = [
  "init",
  "setup",
  "login",
  "audio",
  "voices",
  "models",
  "--help",
  "-h",
  "--version",
  "-V",
] as const;

export type CliMode = { kind: "cli"; name: string } | { kind: "server" };

/**
 * A recognized subcommand → CLI mode; anything else (bare invocation, or an unknown flag an
 * MCP host might pass) → the stdio MCP server. `argv` is the full process.argv (cmd at index 2).
 */
export function resolveMode(argv: string[]): CliMode {
  const cmd = argv[2];
  if (cmd && (CLI_COMMANDS as readonly string[]).includes(cmd)) {
    return { kind: "cli", name: cmd };
  }
  return { kind: "server" };
}
