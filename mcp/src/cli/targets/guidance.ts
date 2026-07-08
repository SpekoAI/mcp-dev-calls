/**
 * Cross-agent guidance ("the skill, everywhere"): Claude gets the full SKILL.md
 * via init's installSkill(); every other agent gets this compact calling card in
 * ITS OWN rules convention — Codex ~/.codex/AGENTS.md, Gemini ~/.gemini/GEMINI.md,
 * Windsurf global_rules.md (marker-delimited appends into files we don't own),
 * Cline rules dir + VS Code instructions dir (standalone files we do own).
 *
 * Append discipline (same bar as the config writers): backup first, idempotent —
 * re-runs REPLACE the block between markers, never duplicate it — and user
 * content outside the markers is preserved byte-for-byte.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WriteResult } from "./types.js";

export const GUIDANCE_BEGIN = "<!-- BEGIN speko-calls guidance (managed by `npx @spekoai/mcp-calls init`) -->";
export const GUIDANCE_END = "<!-- END speko-calls guidance -->";

/** Kept deliberately short: this lands in users' GLOBAL context files, so every line costs them tokens in every session. */
export const GUIDANCE_CARD = `# Speko Calls — real phone calls from this agent

The \`speko-calls\` MCP server places real, disclosed phone calls (and terminal TTS/STT).
Calls cost money and reach real people — use them deliberately, never for exploration.

- Business by name → \`lookup_business\` (mints a signed \`dial_token\`) → \`make_call\`.
- Number the user gave you or you found from an official source → \`call_number\`
  (business or personal, mobiles OK). Never dial a number you invented.
- Wait for the result: tools return an \`OUTCOME:\` line + transcript with honest
  \`connected\`/\`answered\`/\`not_connected\`. Report that outcome truthfully — never invent one.
- Re-check a call with \`get_call(call_id)\`; debug setup with \`check_call_readiness()\`.
- Every call opens with a non-removable AI disclosure. Server-enforced rails: no-sell /
  no-spam / harassment / impersonation screens, per-number rate caps, a do-not-call list,
  and an after-hours gate — late or unknown-timezone calls need the human's explicit
  go-ahead (pass it via \`after_hours_confirmation\`; never fabricate it).

Full guide: https://github.com/SpekoAI/mcp-dev-calls/blob/main/AGENTS.md`;

/** Pure: insert or replace the marker-delimited block in an existing file body. */
export function upsertGuidanceBlock(raw: string, card: string = GUIDANCE_CARD): string {
  const block = `${GUIDANCE_BEGIN}\n${card}\n${GUIDANCE_END}`;
  const begin = raw.indexOf(GUIDANCE_BEGIN);
  const end = raw.indexOf(GUIDANCE_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return raw.slice(0, begin) + block + raw.slice(end + GUIDANCE_END.length);
  }
  if (!raw.trim()) return `${block}\n`;
  return `${raw.replace(/\n*$/, "")}\n\n${block}\n`;
}

/** Marker-append into a file the USER owns (Codex AGENTS.md, GEMINI.md, global_rules.md). */
export function appendGuidance(path: string): WriteResult {
  try {
    const existed = existsSync(path);
    const raw = existed ? readFileSync(path, "utf-8") : "";
    if (existed) writeFileSync(`${path}.speko-backup`, raw);
    else mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, upsertGuidanceBlock(raw));
    return { ok: true, detail: path };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** Standalone guidance file WE own (Cline rules dir, VS Code instructions dir) — plain overwrite. */
export function writeGuidanceFile(path: string, frontmatter?: string): WriteResult {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = frontmatter ? `${frontmatter}\n${GUIDANCE_CARD}\n` : `${GUIDANCE_CARD}\n`;
    writeFileSync(path, body);
    return { ok: true, detail: path };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
