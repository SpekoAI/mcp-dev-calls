/**
 * Cross-agent guidance ("the skill, everywhere"): marker-append is idempotent,
 * replaces stale blocks, preserves user content byte-for-byte, backs up; each
 * agent's installGuidance lands in that agent's documented rules convention.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexTarget } from "../src/cli/targets/codex.js";
import {
  GUIDANCE_BEGIN,
  GUIDANCE_CARD,
  GUIDANCE_END,
  appendGuidance,
  upsertGuidanceBlock,
} from "../src/cli/targets/guidance.js";
import { clineTarget, geminiTarget, windsurfTarget } from "../src/cli/targets/standardJson.js";
import { vscodeTarget } from "../src/cli/targets/vscode.js";
import type { TargetCtx } from "../src/cli/targets/types.js";

let homes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "speko-guidance-"));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function fakeCtx(home: string): TargetCtx {
  return { home, platform: "darwin", env: {}, hasCli: () => false, runCli: () => null };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("upsertGuidanceBlock (pure)", () => {
  it("appends one marker block to existing content, preserving it byte-for-byte", () => {
    const user = "# my rules\n\nalways write tests\n";
    const out = upsertGuidanceBlock(user);
    expect(out.startsWith("# my rules\n\nalways write tests")).toBe(true);
    expect(count(out, GUIDANCE_BEGIN)).toBe(1);
    expect(out).toContain(GUIDANCE_CARD);
  });

  it("is idempotent: applying twice yields exactly one block", () => {
    const once = upsertGuidanceBlock("user stuff\n");
    const twice = upsertGuidanceBlock(once);
    expect(twice).toBe(once);
    expect(count(twice, GUIDANCE_BEGIN)).toBe(1);
  });

  it("replaces a stale block in place, keeping content on both sides", () => {
    const stale = `before\n\n${GUIDANCE_BEGIN}\nOLD CARD v0\n${GUIDANCE_END}\n\nafter`;
    const out = upsertGuidanceBlock(stale);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("OLD CARD v0");
    expect(out).toContain(GUIDANCE_CARD);
    expect(count(out, GUIDANCE_BEGIN)).toBe(1);
  });
});

describe("appendGuidance (fs)", () => {
  it("creates the file (with parent dirs) when absent — no backup of nothing", () => {
    const home = freshHome();
    const path = join(home, "deep", "nested", "rules.md");
    expect(appendGuidance(path).ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain(GUIDANCE_CARD);
    expect(existsSync(`${path}.speko-backup`)).toBe(false);
  });

  it("backs up an existing file and never duplicates on re-run", () => {
    const home = freshHome();
    const path = join(home, "rules.md");
    writeFileSync(path, "# precious user rules\n");
    expect(appendGuidance(path).ok).toBe(true);
    expect(appendGuidance(path).ok).toBe(true);
    const out = readFileSync(path, "utf-8");
    expect(out).toContain("# precious user rules");
    expect(count(out, GUIDANCE_BEGIN)).toBe(1);
    expect(existsSync(`${path}.speko-backup`)).toBe(true);
  });
});

describe("per-agent guidance conventions", () => {
  it("codex → ~/.codex/AGENTS.md (marker-append)", () => {
    const home = freshHome();
    expect(codexTarget.installGuidance?.(fakeCtx(home)).ok).toBe(true);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf-8")).toContain(GUIDANCE_BEGIN);
  });

  it("gemini → ~/.gemini/GEMINI.md (marker-append, preserves user memory)", () => {
    const home = freshHome();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "GEMINI.md"), "my gemini memory\n");
    expect(geminiTarget.installGuidance?.(fakeCtx(home)).ok).toBe(true);
    const out = readFileSync(join(home, ".gemini", "GEMINI.md"), "utf-8");
    expect(out).toContain("my gemini memory");
    expect(out).toContain(GUIDANCE_CARD);
  });

  it("windsurf → memories/global_rules.md (marker-append)", () => {
    const home = freshHome();
    expect(windsurfTarget.installGuidance?.(fakeCtx(home)).ok).toBe(true);
    expect(readFileSync(join(home, ".codeium", "windsurf", "memories", "global_rules.md"), "utf-8")).toContain(
      GUIDANCE_CARD,
    );
  });

  it("cline → Documents/Cline/Rules/speko-calls.md (standalone file)", () => {
    const home = freshHome();
    expect(clineTarget.installGuidance?.(fakeCtx(home)).ok).toBe(true);
    const out = readFileSync(join(home, "Documents", "Cline", "Rules", "speko-calls.md"), "utf-8");
    expect(out).toContain(GUIDANCE_CARD);
    expect(out).not.toContain(GUIDANCE_BEGIN); // our own file — no markers needed
  });

  it("vscode → User/prompts/speko-calls.instructions.md with applyTo frontmatter", () => {
    const home = freshHome();
    expect(vscodeTarget.installGuidance?.(fakeCtx(home)).ok).toBe(true);
    const out = readFileSync(
      join(home, "Library", "Application Support", "Code", "User", "prompts", "speko-calls.instructions.md"),
      "utf-8",
    );
    expect(out.startsWith("---\napplyTo: '**'")).toBe(true);
    expect(out).toContain(GUIDANCE_CARD);
  });

  it("cursor and zed deliberately have no guidance installer (no safe global rules file)", async () => {
    const { cursorTarget } = await import("../src/cli/targets/standardJson.js");
    const { zedTarget } = await import("../src/cli/targets/zed.js");
    expect(cursorTarget.installGuidance).toBeUndefined();
    expect(zedTarget.installGuidance).toBeUndefined();
  });
});
