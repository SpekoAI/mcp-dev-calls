#!/usr/bin/env node
/** V2 gate: every required probe id must exist in the matrix. */
import { buildMatrix } from "./probes.mjs";

const REQUIRED = [
  "mcp.initialize",
  "mcp.tools-list",
  "rail.emergency",
  "rail.premium",
  "rail.invalid-e164",
  "rail.objective-short",
  "rail.objective-sell",
  "rail.objective-survey",
  "rail.objective-fundraise",
  "rail.objective-crypto",
  "rail.behavior-smuggle",
  "rail.context-smuggle",
  "rail.harassment",
  "rail.impersonation",
  "rail.coldcall",
  "benign.prank-supplies",
  "benign.annoying-pests",
  "benign.wakeup-call",
  "benign.court-clerk",
  "benign.prospect-park",
  "gate.night-noconfirm",
  "gate.night-confirm",
  "gate.collection-night-confirm",
  "gate.collection-day",
  "gate.unknown-offset-noconfirm",
  "gate.unknown-offset-confirm",
  "rail.clean-day-dials",
  "rail.caller-name-symbols",
  "token.malformed",
  "token.expired",
  "token.tampered",
  "token.wrong-account",
  "token.mobile-blocked",
  "token.valid-day-dials",
  "token.night-noconfirm",
  "tool.call-me",
  "tool.get-call-unknown",
  "tool.readiness",
  "guard.dnc-blocked",
  "guard.ratecap-4th",
  "guard.trusted-skips-time-and-rate",
  "lookup.demo-unknown-offset",
  "lookup.agent-provided-no-carrier",
  "cli.version",
  "cli.help",
  "cli.unknown-command",
  "cli.audio-usage",
  "cli.audio-speak-usage",
  "cli.dnc-usage",
  "cli.dnc-list-empty",
  "cli.dnc-add",
  "cli.dnc-remove-noop",
];

const { sessions, cli } = buildMatrix();
const have = new Set([...sessions.flatMap((s) => s.probes.map((p) => p.id)), ...cli.map((p) => p.id)]);
const missing = REQUIRED.filter((id) => !have.has(id));
console.log(`required=${REQUIRED.length} present=${have.size} missing=${missing.length}`);
if (missing.length) {
  for (const id of missing) console.log(`MISSING ${id}`);
  process.exit(1);
}
process.exit(0);
