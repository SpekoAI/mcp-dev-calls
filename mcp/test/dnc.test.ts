import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDnc } from "../src/cli/dnc.js";

const dirs: string[] = [];

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "speko-dnc-"));
  dirs.push(dir);
  return dir;
}

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => void out.push(s) }, stderr: (line: string) => void err.push(line) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runDnc", () => {
  it("prints an empty-list message", async () => {
    const c = cap();
    const code = await runDnc(["list"], { ...c, env: { SPEKO_GUARD_STATE_DIR: tempStateDir() } });

    expect(code).toBe(0);
    expect(c.out.join("")).toBe("Do-not-call list is empty.\n");
  });

  it("adds a formatted number and lists the normalized entry", async () => {
    const dir = tempStateDir();
    const c = cap();

    expect(await runDnc(["add", "+1 (415) 555-0142"], { ...c, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(0);
    expect(c.out.join("")).toContain("Added +14155550142");

    const listed = cap();
    expect(await runDnc(["list"], { ...listed, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(0);
    const text = listed.out.join("");
    expect(text).toContain("+14155550142");
    expect(text).toContain("source=manual");
    expect(text).toMatch(/ts=\d{4}-\d{2}-\d{2}T/);
  });

  it("removes an entry and reports whether it was listed", async () => {
    const dir = tempStateDir();
    await runDnc(["add", "+1 (415) 555-0142"], { ...cap(), env: { SPEKO_GUARD_STATE_DIR: dir } });

    const removed = cap();
    expect(await runDnc(["remove", "+14155550142"], { ...removed, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(0);
    expect(removed.out.join("")).toContain("Removed +14155550142");

    const missing = cap();
    expect(await runDnc(["remove", "+14155550142"], { ...missing, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(0);
    expect(missing.out.join("")).toContain("+14155550142 was not on the local do-not-call list");

    const listed = cap();
    await runDnc(["list"], { ...listed, env: { SPEKO_GUARD_STATE_DIR: dir } });
    expect(listed.out.join("")).toBe("Do-not-call list is empty.\n");
  });

  it("returns a usage error when an add/remove number is missing", async () => {
    const c = cap();
    const code = await runDnc(["add"], { ...c, env: { SPEKO_GUARD_STATE_DIR: tempStateDir() } });

    expect(code).toBe(1);
    expect(c.err).toEqual(["Usage: speko dnc list | add <e164> | remove <e164> | check <e164>"]);
    expect(c.out).toEqual([]);
  });

  it("rejects input that is not a phone number instead of adding junk (regression)", async () => {
    // The old check accepted any string containing a digit — "abc1" normalized to "1"
    // and landed on the ledger as a useless entry.
    const dir = tempStateDir();
    const c = cap();
    const code = await runDnc(["add", "abc1"], { ...c, env: { SPEKO_GUARD_STATE_DIR: dir } });

    expect(code).toBe(1);
    expect(c.err.join("")).toContain("does not look like a phone number");
    expect(c.out).toEqual([]);

    const listed = cap();
    await runDnc(["list"], { ...listed, env: { SPEKO_GUARD_STATE_DIR: dir } });
    expect(listed.out.join("")).toBe("Do-not-call list is empty.\n");
  });

  it("rejects digits embedded in prose even when there are enough of them (Greptile #64)", async () => {
    // normalizeE164 would strip "call me at ... tomorrow" down to a plausible 10-digit
    // number — the raw input must be phone-shaped, not just digit-bearing.
    const dir = tempStateDir();
    const c = cap();
    const code = await runDnc(["add", "call me at 5551234567 tomorrow"], { ...c, env: { SPEKO_GUARD_STATE_DIR: dir } });

    expect(code).toBe(1);
    expect(c.err.join("")).toContain("does not look like a phone number");

    const listed = cap();
    await runDnc(["list"], { ...listed, env: { SPEKO_GUARD_STATE_DIR: dir } });
    expect(listed.out.join("")).toBe("Do-not-call list is empty.\n");
  });

  it("add requires the leading + — a plus-less entry can never match a dialed E.164 number", async () => {
    const dir = tempStateDir();
    const c = cap();
    const code = await runDnc(["add", "4155550142"], { ...c, env: { SPEKO_GUARD_STATE_DIR: dir } });

    expect(code).toBe(1);
    expect(c.err.join("")).toContain("missing the leading +");
    expect(c.err.join("")).toContain("never match a dialed number");

    const listed = cap();
    await runDnc(["list"], { ...listed, env: { SPEKO_GUARD_STATE_DIR: dir } });
    expect(listed.out.join("")).toBe("Do-not-call list is empty.\n");
  });

  it("check and remove still accept plus-less forms (legacy entries stay reachable)", async () => {
    const dir = tempStateDir();

    const checked = cap();
    expect(await runDnc(["check", "4155550142"], { ...checked, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(1);
    expect(checked.out.join("")).toContain("4155550142 is not on the local do-not-call list");
    expect(checked.err).toEqual([]);

    const removed = cap();
    expect(await runDnc(["remove", "4155550142"], { ...removed, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(0);
    expect(removed.out.join("")).toContain("4155550142 was not on the local do-not-call list");
  });

  it("check: exit 0 when the number is listed, exit 1 when it is not (grep-style)", async () => {
    const dir = tempStateDir();
    await runDnc(["add", "+1 (415) 555-0142"], { ...cap(), env: { SPEKO_GUARD_STATE_DIR: dir } });

    const hit = cap();
    expect(await runDnc(["check", "+14155550142"], { ...hit, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(0);
    expect(hit.out.join("")).toContain("+14155550142 IS on the local do-not-call list");

    const miss = cap();
    expect(await runDnc(["check", "+14155550199"], { ...miss, env: { SPEKO_GUARD_STATE_DIR: dir } })).toBe(1);
    expect(miss.out.join("")).toContain("+14155550199 is not on the local do-not-call list");
  });
});
