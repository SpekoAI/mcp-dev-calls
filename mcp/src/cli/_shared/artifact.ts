/**
 * Predictable artifact-output resolution, mirroring vercel-labs/ai-cli:
 *  - `-o <file>`      → that exact path
 *  - `-o <dir>`       → auto-named `<id>.<ext>` inside the dir
 *  - piped (no TTY)   → stdout (raw bytes / text), no file
 *  - interactive TTY  → auto-named `<id>.<ext>` in SPEKO_OUTPUT_DIR || cwd
 * Pure: the caller precomputes `outIsDir` (a filesystem check) and passes it in.
 */
import { join } from "node:path";

export interface OutTarget {
  mode: "stdout" | "file";
  path?: string;
}

export interface ResolveOutArgs {
  /** value of -o/--output, if any */
  out?: string;
  /** precomputed: does `out` point at an existing directory? */
  outIsDir?: boolean;
  /** process.stdout.isTTY */
  isTTY: boolean;
  /** file extension without the dot */
  ext: string;
  /** artifact id for auto-naming */
  id: string;
  /** SPEKO_OUTPUT_DIR override */
  outputDir?: string;
  /** process.cwd() */
  cwd: string;
}

export function resolveOutTarget(a: ResolveOutArgs): OutTarget {
  const name = `${a.id}.${a.ext}`;
  if (a.out !== undefined && a.out !== "") {
    if (a.outIsDir || a.out.endsWith("/") || a.out.endsWith("\\")) {
      return { mode: "file", path: join(a.out, name) };
    }
    return { mode: "file", path: a.out };
  }
  if (!a.isTTY) return { mode: "stdout" };
  const dir = a.outputDir && a.outputDir.trim() ? a.outputDir.trim() : a.cwd;
  return { mode: "file", path: join(dir, name) };
}
