import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, resolveMode } from "../src/cli/router.js";

const argv = (...a: string[]) => ["node", "bin", ...a];

describe("resolveMode — the MCP-stdio invariant", () => {
  it("routes every known subcommand to CLI mode", () => {
    for (const c of CLI_COMMANDS) {
      expect(resolveMode(argv(c))).toEqual({ kind: "cli", name: c });
    }
  });

  it("bare invocation → the stdio MCP server", () => {
    expect(resolveMode(["node", "bin"])).toEqual({ kind: "server" });
    expect(resolveMode(argv())).toEqual({ kind: "server" });
  });

  it("an unknown subcommand → usage-error (exit 2), NEVER a silent server boot", () => {
    // Regression: `speko frobnicate | x` used to boot the stdio server and hang the shell.
    expect(resolveMode(argv("frobnicate"))).toEqual({ kind: "usage-error", name: "frobnicate" });
    expect(resolveMode(argv("--transport=stdio"))).toEqual({ kind: "usage-error", name: "--transport=stdio" });
    // 'speak' is a subcommand of `audio`, NOT a top-level command → also a usage error.
    expect(resolveMode(argv("speak"))).toEqual({ kind: "usage-error", name: "speak" });
  });

  it("bare invocation from a TTY → help (human); piped/non-TTY → server (MCP host)", () => {
    expect(resolveMode(argv(), { stdinIsTTY: true })).toEqual({ kind: "help" });
    expect(resolveMode(argv(), { stdinIsTTY: false })).toEqual({ kind: "server" });
    expect(resolveMode(argv())).toEqual({ kind: "server" }); // no TTY info → safe default: server
  });

  it("an unknown arg is a usage-error regardless of TTY", () => {
    expect(resolveMode(argv("--bogus"), { stdinIsTTY: true })).toEqual({ kind: "usage-error", name: "--bogus" });
    expect(resolveMode(argv("--bogus"), { stdinIsTTY: false })).toEqual({ kind: "usage-error", name: "--bogus" });
  });

  it("known subcommands route to cli regardless of stdin", () => {
    expect(resolveMode(argv("audio"), { stdinIsTTY: true })).toEqual({ kind: "cli", name: "audio" });
  });
});
