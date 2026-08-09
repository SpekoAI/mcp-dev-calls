/**
 * SPEKO_TOOLS — opt-in tool-surface gating for MCP-server mode.
 *
 * Agent platforms that do not approval-gate MCP tool calls can shrink the dialing
 * surface to just what a pilot needs (e.g. SPEKO_TOOLS=call_me,get_call,check_call_readiness).
 * Unset/empty registers every tool. Unknown names are IGNORED with a stderr warning —
 * and if nothing valid remains the server registers zero tools (fail closed: silently
 * re-arming the full dialing surface against an operator's explicit restriction would
 * be worse than a server with no tools).
 */
export interface ToolSelection {
  /** Valid tool names to register, in registry order. */
  selected: string[];
  /** Entries from the spec that matched no registered tool name. */
  unknown: string[];
}

/** Parse a SPEKO_TOOLS comma list against the registry's valid names. Pure; unit-tested. */
export function selectTools(spec: string | undefined, validNames: readonly string[]): ToolSelection {
  const entries = (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return { selected: [...validNames], unknown: [] };
  const requested = new Set(entries);
  const selected = validNames.filter((n) => requested.has(n));
  const unknown = [...new Set(entries.filter((e) => !validNames.includes(e)))];
  return { selected, unknown };
}

/** The one-line stderr warning for unknown SPEKO_TOOLS entries. */
export function unknownToolsWarning(unknown: string[], validNames: readonly string[]): string {
  return (
    `speko: SPEKO_TOOLS contains unknown tool name(s): ${unknown.join(", ")}. ` +
    `Valid names: ${validNames.join(", ")}.`
  );
}
