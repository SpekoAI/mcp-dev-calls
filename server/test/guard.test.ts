import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPT_OUT_RE,
  appendDialLedger,
  dncAdd,
  dncList,
  dncReason,
  dncRemove,
  isTrustedNumber,
  normalizeE164,
  rateCapReason,
  resolveGuardStateDir,
  scanCalleeTurnsForOptOut,
  trustedNumbers,
} from "../src/safety/guard.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speko-guard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("guard normalization", () => {
  it("normalizes formatted E.164-ish strings with the shared strip", () => {
    expect(normalizeE164("+1 (415) 555-0142")).toBe("+14155550142");
    expect(normalizeE164("tel:+1.415.555.0142")).toBe("+14155550142");
  });

  it("resolves the guard state directory from env or the default home path", () => {
    expect(resolveGuardStateDir({ SPEKO_GUARD_STATE_DIR: dir })).toBe(dir);
    expect(resolveGuardStateDir({})).toMatch(/[\\/]\.speko[\\/]calls$/);
  });
});

describe("dial ledger rate caps", () => {
  const e164 = "+14155550142";
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("allows the third hourly call and blocks the fourth with minutes to free", () => {
    appendDialLedger({ ts: new Date(now - 50 * 60_000).toISOString(), e164, call_id: "call-1" }, dir);
    appendDialLedger({ ts: new Date(now - 20 * 60_000).toISOString(), e164, call_id: "call-2" }, dir);

    expect(rateCapReason(e164, { dir, now, perHour: 3 })).toBeNull();

    appendDialLedger({ ts: new Date(now - 5 * 60_000).toISOString(), e164, call_id: "call-3" }, dir);
    const reason = rateCapReason(e164, { dir, now, perHour: 3 });
    expect(reason).toMatch(/60 minutes/);
    expect(reason).toMatch(/10 minutes/);
  });

  it("blocks at the 24-hour cap when the hourly cap is not reached", () => {
    for (let i = 0; i < 8; i += 1) {
      appendDialLedger({ ts: new Date(now - (23 - i * 2) * 60 * 60_000).toISOString(), e164, call_id: `call-${i}` }, dir);
    }

    const reason = rateCapReason(e164, { dir, now, perHour: 100, perDay: 8 });
    expect(reason).toMatch(/24 hours/);
    expect(reason).toMatch(/60 minutes/);
  });

  it("keeps rate caps isolated by normalized number", () => {
    for (let i = 0; i < 3; i += 1) {
      appendDialLedger({ ts: new Date(now - i * 60_000).toISOString(), e164, call_id: `call-${i}` }, dir);
    }

    expect(rateCapReason("+14155550143", { dir, now, perHour: 3 })).toBeNull();
  });

  it("skips malformed ledger lines", () => {
    writeFileSync(join(dir, "ledger.jsonl"), "{not json}\n", "utf-8");
    appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ ts: "not a date", e164 })}\n`, "utf-8");

    expect(rateCapReason(e164, { dir, now, perHour: 1 })).toBeNull();
  });
});

describe("do-not-call ledger", () => {
  it("adds, checks, lists, and removes entries with tombstones and normalized numbers", () => {
    expect(dncReason("+14155550142", dir)).toBeNull();

    dncAdd("+1 (415) 555-0142", { source: "manual", call_id: "call-1", phrase: "stop calling me" }, dir);
    expect(dncReason("+14155550142", dir)).toMatch(/local do-not-call list/);
    expect(dncReason("+14155550142", dir)).toMatch(/speko dnc remove \+14155550142/);

    expect(dncList(dir)).toMatchObject([
      { e164: "+14155550142", source: "manual", call_id: "call-1", phrase: "stop calling me" },
    ]);

    expect(dncRemove("+1 415 555 0142", dir)).toBe(true);
    expect(dncReason("+14155550142", dir)).toBeNull();
    expect(dncList(dir)).toEqual([]);
    expect(readFileSync(join(dir, "dnc.jsonl"), "utf-8")).toContain('"removed":true');

    // Removing a never-listed number is a no-op: false, and NO tombstone line written.
    const linesBefore = readFileSync(join(dir, "dnc.jsonl"), "utf-8").split("\n").filter(Boolean).length;
    expect(dncRemove("+16505550100", dir)).toBe(false);
    const linesAfter = readFileSync(join(dir, "dnc.jsonl"), "utf-8").split("\n").filter(Boolean).length;
    expect(linesAfter).toBe(linesBefore);
  });
});

describe("opt-out detection", () => {
  it("matches FCC per-se opt-out phrases", () => {
    for (const phrase of [
      "stop",
      "stop calling",
      "stop calling me",
      "quit calling",
      "cancel",
      "opt out",
      "unsubscribe",
      "never call me again",
      "never contact me",
      "do not call",
      "don't call me",
      "take me off your list",
      "take my number off",
      "remove me from your list",
      "remove my number",
      "lose my number",
      "stop bothering me",
    ]) {
      expect(phrase.match(OPT_OUT_RE)?.[0]).toBeTruthy();
    }
  });

  it("does not match pinned benign stop/never phrases", () => {
    for (const phrase of ["no, don't stop by", "the bus stop", "we never close"]) {
      expect(phrase.match(OPT_OUT_RE)).toBeNull();
    }
  });

  it("matches 'cancel' only as a bare utterance, not inside a cancellation confirmation", () => {
    expect("cancel".match(OPT_OUT_RE)?.[0]).toBeTruthy();
    expect("Please cancel.".match(OPT_OUT_RE)?.[0]).toBeTruthy();
    // The CALLEE confirming a cancellation the caller asked for must not self-DNC the business.
    for (const phrase of ["sure, I will cancel it", "I'll cancel your reservation right away", "it's been canceled"]) {
      expect(phrase.match(OPT_OUT_RE)).toBeNull();
    }
  });

  it("scans callee turns and returns the first matched phrase trimmed to 80 chars", () => {
    const longOptOut = `stop calling me ${"right now ".repeat(20)}`;
    const result = scanCalleeTurnsForOptOut([{ text: "hello" }, { text: longOptOut }]);

    expect(result.matched).toBe(true);
    expect(result.phrase).toHaveLength(80);
    expect(result.phrase).toBe(longOptOut.slice(0, 80));
  });
});

describe("trusted numbers", () => {
  it("parses and normalizes trusted numbers from env without caching", () => {
    const env = { SPEKO_TRUSTED_NUMBERS: "+1 (415) 555-0142, +44 20 7946 0958, ," };
    expect(trustedNumbers(env)).toEqual(new Set(["+14155550142", "+442079460958"]));
    expect(isTrustedNumber("+1 415 555 0142", env)).toBe(true);
    expect(isTrustedNumber("+14155550143", env)).toBe(false);
    expect(trustedNumbers({})).toEqual(new Set());
  });
});
