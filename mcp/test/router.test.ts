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

  it("an unknown arg (e.g. a flag an MCP host passes) → server, never a CLI handler", () => {
    expect(resolveMode(argv("--transport=stdio"))).toEqual({ kind: "server" });
    expect(resolveMode(argv("foo"))).toEqual({ kind: "server" });
    // 'speak' is a subcommand of `audio`, NOT a top-level command → must fall through to server.
    expect(resolveMode(argv("speak"))).toEqual({ kind: "server" });
  });

  it("bare invocation from a TTY → help (human); piped/non-TTY → server (MCP host)", () => {
    expect(resolveMode(argv(), { stdinIsTTY: true })).toEqual({ kind: "help" });
    expect(resolveMode(argv(), { stdinIsTTY: false })).toEqual({ kind: "server" });
    expect(resolveMode(argv())).toEqual({ kind: "server" }); // no TTY info → safe default: server
  });

  it("an unknown arg from a TTY → help; piped → server (MCP host passing a flag)", () => {
    expect(resolveMode(argv("--bogus"), { stdinIsTTY: true })).toEqual({ kind: "help" });
    expect(resolveMode(argv("--bogus"), { stdinIsTTY: false })).toEqual({ kind: "server" });
  });

  it("known subcommands route to cli regardless of stdin", () => {
    expect(resolveMode(argv("audio"), { stdinIsTTY: true })).toEqual({ kind: "cli", name: "audio" });
  });
});
