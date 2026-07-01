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
});
