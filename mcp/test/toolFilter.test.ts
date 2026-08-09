import { describe, expect, it } from "vitest";
import { selectTools, unknownToolsWarning } from "../src/lib/toolFilter.js";

// Mirrors the registration order in src/index.ts (the wire order of tools/list).
const VALID = ["lookup_business", "make_call", "call_number", "check_call_readiness", "get_call", "call_me"] as const;

describe("SPEKO_TOOLS selection", () => {
  it("unset registers all tools", () => {
    expect(selectTools(undefined, VALID)).toEqual({ selected: [...VALID], unknown: [] });
  });

  it("empty and whitespace-only specs register all tools", () => {
    expect(selectTools("", VALID).selected).toEqual([...VALID]);
    expect(selectTools("   ", VALID).selected).toEqual([...VALID]);
    expect(selectTools(",,", VALID).selected).toEqual([...VALID]);
  });

  it("a subset registers exactly those tools, in registry order", () => {
    const { selected, unknown } = selectTools("call_me,get_call,check_call_readiness", VALID);
    expect(selected).toEqual(["check_call_readiness", "get_call", "call_me"]);
    expect(unknown).toEqual([]);
  });

  it("tolerates whitespace around names and deduplicates", () => {
    const { selected, unknown } = selectTools(" get_call , call_me , get_call ", VALID);
    expect(selected).toEqual(["get_call", "call_me"]);
    expect(unknown).toEqual([]);
  });

  it("ignores unknown names but keeps the valid ones", () => {
    const { selected, unknown } = selectTools("make_call,bogus_tool", VALID);
    expect(selected).toEqual(["make_call"]);
    expect(unknown).toEqual(["bogus_tool"]);
  });

  it("fails closed when nothing valid remains (never re-arms the full surface)", () => {
    const { selected, unknown } = selectTools("bogus_a,bogus_b", VALID);
    expect(selected).toEqual([]);
    expect(unknown).toEqual(["bogus_a", "bogus_b"]);
  });

  it("treats a shell-injection-shaped entry as one unknown name, not a command", () => {
    const { selected, unknown } = selectTools("make_call,call_number; rm -rf /", VALID);
    expect(selected).toEqual(["make_call"]);
    expect(unknown).toEqual(["call_number; rm -rf /"]);
  });

  it("is case-sensitive: MAKE_CALL is not a registered tool", () => {
    const { selected, unknown } = selectTools("MAKE_CALL", VALID);
    expect(selected).toEqual([]);
    expect(unknown).toEqual(["MAKE_CALL"]);
  });

  it("warning names the offenders and every valid tool", () => {
    const msg = unknownToolsWarning(["bogus_tool"], VALID);
    expect(msg).toContain("bogus_tool");
    for (const name of VALID) expect(msg).toContain(name);
  });
});
