# Characterization loop — learnings (consult first, every iteration)

## Verified
- Published 0.4.9 tarball shasum: `1d4b88672623a4753000b63ca677f497439d4eef`; ships bin VERSION string "0.4.8" (stale in-source const) — so `cli.version` baseline = 0.4.8, and 0.5.0 flipping to 0.5.0 is an EXPECTED delta, not a regression.
- 0.4.9 MCP exposes 6 tools (no `dnc`); call/call_number schemas have NO `after_hours_confirmation`. Confirmed in baseline snapshots.
- "Reached the dial layer" (passed all rails) normalizes to `<NETERR>` via the 127.0.0.1:9 sinkhole. A rail rejection is a non-<NETERR> isError text.
- Unknown CLI commands in 0.4.9 fall through to starting the stdio MCP server (dnc probes on 0.4.9 = server-startup stderr). All four dnc CLI probes are therefore expected deltas.

## Intended deltas (0.4.9 -> 0.5.0), each needs an expected-deltas.json entry
- tools/list: +after_hours_confirmation on call_number+make_call; +dnc? (NO — dnc is CLI only, not an MCP tool). [#30/#31]
- rail.harassment / rail.impersonation / rail.coldcall: 0.4.9 <NETERR> -> 0.5.0 rejected. [#30/#31]
- rail.context-smuggle: 0.4.9 <NETERR> (context unscreened) -> 0.5.0 rejected. [#30/#31]
- gate.night-noconfirm: message "quiet hours" -> "after_hours_confirmation" retry text. [#30/#31]
- gate.night-confirm: 0.4.9 rejected (quiet hours, no such param) -> 0.5.0 <NETERR> (confirmation lets it dial). [#30/#31]
- gate.collection-night-confirm: 0.4.9 quiet-hours reject -> 0.5.0 FDCPA reject (still rejected, different text). [#30]
- gate.unknown-offset-noconfirm: 0.4.9 quiet-hours fail-closed reject -> 0.5.0 after-hours-confirmation reject. [#30/#31]
- gate.unknown-offset-confirm: 0.4.9 reject -> 0.5.0 <NETERR>. [#31]
- guard.* (dnc-blocked, ratecap-4th, trusted): 0.4.9 <NETERR> (no such guards) -> 0.5.0 rejected / (trusted) <NETERR>. [#30/#31]
- lookup.demo-unknown-offset + lookup.agent-provided-no-carrier: 0.4.9 blocks at lookup for unknown offset -> 0.5.0 mints token (different result). [#31]
- cli.dnc-*: 0.4.9 server-startup -> 0.5.0 real dnc output. [#30/#31]
- cli.version: 0.4.8 -> 0.5.0. [version bump]
- mcp.tools-list + tool.call-me: 0.5.6 unregisters the inert call_me stub -> 5 tools; the probe errors at dispatch (unknown tool) instead of the tool's v1 not-available error. Implementation kept in tools/CallMeTool.ts for v2. [multi-agent launch]

## Watch
- benign.* probes MUST stay parity (<NETERR> on both). If a benign probe flips to rejected on 0.5.0, that's a false-positive REGRESSION — fix the regex, do NOT add a delta.
- token.* probes (malformed/expired/tampered/wrong-account/mobile-blocked) MUST stay parity — dial-token format is unchanged.
