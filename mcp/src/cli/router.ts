/**
 * Pure CLI routing decision, kept side-effect-free so the MCP-stdio invariant is unit-testable.
 * A recognized subcommand → CLI. A NON-EMPTY unrecognized subcommand → usage-error (usage to
 * stderr + exit 2) — it must never boot the stdio server, or a typo like `speko frobnicate | x`
 * hangs the caller's shell holding a JSON-RPC server open. With no subcommand at all: an
 * interactive terminal (TTY stdin) gets help; a piped, non-TTY stdin (how an MCP host spawns
 * us over stdio) falls through to the MCP server.
 */
export const CLI_COMMANDS = [
  "init",
  "setup",
  "login",
  "status",
  "whoami",
  "me",
  "audio",
  "dnc",
  "voices",
  "models",
  "usage",
  "credits",
  "call",
  "--help",
  "-h",
  "--version",
  "-V",
] as const;

export type CliMode =
  | { kind: "cli"; name: string }
  | { kind: "help" }
  | { kind: "usage-error"; name: string }
  | { kind: "server" };

export function resolveMode(argv: string[], opts: { stdinIsTTY?: boolean } = {}): CliMode {
  const cmd = argv[2];
  if (cmd && (CLI_COMMANDS as readonly string[]).includes(cmd)) {
    return { kind: "cli", name: cmd };
  }
  // A typo'd/unknown command fails fast regardless of TTY — never a silent server boot.
  if (cmd) return { kind: "usage-error", name: cmd };
  // No command at all: a human at a terminal gets help; an MCP host (piped, non-TTY stdin)
  // gets the stdio server — so the MCP integration is never affected.
  if (opts.stdinIsTTY) return { kind: "help" };
  return { kind: "server" };
}
