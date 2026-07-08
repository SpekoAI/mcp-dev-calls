/**
 * Safe read-merge-backup-write for agent config JSON — the exact semantics the
 * Claude Desktop writer has shipped with since 0.4.x: never blind-append, back
 * up the previous file, and refuse to touch a file we can't parse (a malformed
 * config is the user's to fix, not ours to clobber).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MergeResult {
  ok: boolean;
  detail: string;
}

export function mergeJsonFile(
  path: string,
  mutate: (cfg: Record<string, unknown>) => Record<string, unknown>,
): MergeResult {
  try {
    let cfg: Record<string, unknown> = {};
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      try {
        cfg = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return { ok: false, detail: `${path} is not valid JSON — left untouched. Fix it, then re-run.` };
      }
      writeFileSync(`${path}.speko-backup`, raw);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, `${JSON.stringify(mutate(cfg), null, 2)}\n`);
    return { ok: true, detail: path };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
