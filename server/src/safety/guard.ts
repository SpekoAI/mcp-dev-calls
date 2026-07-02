import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RATE_CAP_PER_NUMBER_DAY, RATE_CAP_PER_NUMBER_HOUR } from "../constants.js";

const LEDGER_FILE = "ledger.jsonl";
const DNC_FILE = "dnc.jsonl";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

export function normalizeE164(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

export function resolveGuardStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.SPEKO_GUARD_STATE_DIR ?? "").trim();
  return override || join(homedir(), ".speko", "calls");
}

function ensureGuardStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function appendJsonLine(dir: string, file: string, record: Record<string, unknown>): void {
  ensureGuardStateDir(dir);
  appendFileSync(join(dir, file), `${JSON.stringify(record)}\n`, { encoding: "utf-8", flag: "a" });
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function appendDialLedger(
  entry: { ts?: string; e164: string; call_id: string | null; after_hours_confirmation?: string },
  dir = resolveGuardStateDir(),
): void {
  const record: Record<string, unknown> = {
    ts: entry.ts ?? new Date().toISOString(),
    e164: normalizeE164(entry.e164),
    call_id: entry.call_id,
  };
  if (entry.after_hours_confirmation !== undefined) {
    record.after_hours_confirmation = entry.after_hours_confirmation;
  }
  appendJsonLine(dir, LEDGER_FILE, record);
}

interface LedgerEntry {
  tsMs: number;
  e164: string;
}

function readLedger(dir: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of readLines(join(dir, LEDGER_FILE))) {
    const record = parseObject(line);
    if (!record || typeof record.ts !== "string" || typeof record.e164 !== "string") continue;
    const tsMs = Date.parse(record.ts);
    const e164 = normalizeE164(record.e164);
    if (!Number.isFinite(tsMs) || !e164) continue;
    entries.push({ tsMs, e164 });
  }
  return entries;
}

function positiveCap(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function entriesWithin(entries: LedgerEntry[], normalized: string, nowMs: number, windowMs: number): LedgerEntry[] {
  return entries
    .filter((entry) => entry.e164 === normalized && entry.tsMs <= nowMs && nowMs - entry.tsMs < windowMs)
    .sort((a, b) => a.tsMs - b.tsMs);
}

function rateCapMessage(normalized: string, count: number, windowLabel: string, windowMs: number, oldestTsMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((windowMs - (nowMs - oldestTsMs)) / MINUTE_MS));
  return (
    `Rate cap reached for ${normalized}: ${count} calls in the last ${windowLabel}. ` +
    `Retry in ${minutes} minute${minutes === 1 ? "" : "s"} when the oldest counted attempt ages out.`
  );
}

export function rateCapReason(
  e164: string,
  opts: { dir?: string; perHour?: number; perDay?: number; now?: number } = {},
): string | null {
  const normalized = normalizeE164(e164);
  if (!normalized) return null;

  const dir = opts.dir ?? resolveGuardStateDir();
  const nowMs = opts.now ?? Date.now();
  const perHour = positiveCap(opts.perHour, RATE_CAP_PER_NUMBER_HOUR);
  const perDay = positiveCap(opts.perDay, RATE_CAP_PER_NUMBER_DAY);
  const entries = readLedger(dir);

  const hourEntries = entriesWithin(entries, normalized, nowMs, HOUR_MS);
  if (hourEntries.length >= perHour) {
    return rateCapMessage(normalized, hourEntries.length, "60 minutes", HOUR_MS, hourEntries[0].tsMs, nowMs);
  }

  const dayEntries = entriesWithin(entries, normalized, nowMs, DAY_MS);
  if (dayEntries.length >= perDay) {
    return rateCapMessage(normalized, dayEntries.length, "24 hours", DAY_MS, dayEntries[0].tsMs, nowMs);
  }

  return null;
}

interface DncEntry {
  e164: string;
  ts: string;
  source: string;
  call_id?: string;
  phrase?: string;
}

function readDncNet(dir: string): Map<string, DncEntry> {
  const net = new Map<string, DncEntry>();
  for (const line of readLines(join(dir, DNC_FILE))) {
    const record = parseObject(line);
    if (!record || typeof record.e164 !== "string") continue;
    const e164 = normalizeE164(record.e164);
    if (!e164) continue;

    if (record.removed === true) {
      net.delete(e164);
      continue;
    }

    if (typeof record.ts !== "string" || typeof record.source !== "string") continue;
    const entry: DncEntry = { e164, ts: record.ts, source: record.source };
    if (typeof record.call_id === "string") entry.call_id = record.call_id;
    if (typeof record.phrase === "string") entry.phrase = record.phrase;
    net.set(e164, entry);
  }
  return net;
}

export function dncReason(e164: string, dir = resolveGuardStateDir()): string | null {
  const normalized = normalizeE164(e164);
  if (!normalized || !readDncNet(dir).has(normalized)) return null;
  return (
    `Dialing ${normalized} is blocked: the number is on the local do-not-call list. ` +
    `Remove it with: speko dnc remove ${normalized}.`
  );
}

export function dncAdd(
  e164: string,
  meta: { source: "auto" | "manual"; call_id?: string; phrase?: string },
  dir = resolveGuardStateDir(),
): void {
  const record: Record<string, unknown> = {
    e164: normalizeE164(e164),
    ts: new Date().toISOString(),
    source: meta.source,
  };
  if (meta.call_id !== undefined) record.call_id = meta.call_id;
  if (meta.phrase !== undefined) record.phrase = meta.phrase;
  appendJsonLine(dir, DNC_FILE, record);
}

export function dncRemove(e164: string, dir = resolveGuardStateDir()): boolean {
  const normalized = normalizeE164(e164);
  if (!normalized) return false;
  const wasListed = readDncNet(dir).has(normalized);
  appendJsonLine(dir, DNC_FILE, { e164: normalized, ts: new Date().toISOString(), removed: true });
  return wasListed;
}

export function dncList(dir = resolveGuardStateDir()): Array<{ e164: string; ts: string; source: string; call_id?: string; phrase?: string }> {
  return [...readDncNet(dir).values()];
}

const OPT_OUT_TAIL = String.raw`(?:\s+[^.!?\n]{0,160})?`;

export const OPT_OUT_RE = new RegExp(
  [
    String.raw`^\s*(?:please\s+)?stop\s*[.!?]*\s*$`,
    String.raw`\bstop\s+calling(?:\s+me)?${OPT_OUT_TAIL}\b`,
    String.raw`\bstop\s+contacting\s+me${OPT_OUT_TAIL}\b`,
    String.raw`\bstop\s+bothering\s+me${OPT_OUT_TAIL}\b`,
    String.raw`\bquit\s+calling${OPT_OUT_TAIL}\b`,
    // Bare-utterance only: businesses legitimately say "I'll cancel it" when the CALLER
    // asked to cancel a booking — that must not self-DNC the business's number.
    String.raw`^\s*(?:please\s+)?cancel\s*[.!?]*\s*$`,
    String.raw`\bopt\s+out\b`,
    String.raw`\bunsubscribe\b`,
    String.raw`\bnever\s+call\s+me\s+again${OPT_OUT_TAIL}\b`,
    String.raw`\bnever\s+contact\s+me${OPT_OUT_TAIL}\b`,
    String.raw`\bdo\s+not\s+call${OPT_OUT_TAIL}\b`,
    String.raw`\bdon'?t\s+call\s+me${OPT_OUT_TAIL}\b`,
    String.raw`\btake\s+me\s+off(?:\s+your\s+list)?${OPT_OUT_TAIL}\b`,
    String.raw`\btake\s+my\s+number\s+off(?:\s+your\s+list)?${OPT_OUT_TAIL}\b`,
    String.raw`\bremove\s+me\s+from\s+your\s+list${OPT_OUT_TAIL}\b`,
    String.raw`\bremove\s+my\s+number${OPT_OUT_TAIL}\b`,
    String.raw`\blose\s+my\s+number${OPT_OUT_TAIL}\b`,
  ].join("|"),
  "i",
);

export function scanCalleeTurnsForOptOut(turns: Array<{ text: string }>): { matched: boolean; phrase?: string } {
  for (const turn of turns) {
    const match = turn.text.match(OPT_OUT_RE);
    if (match?.[0]) {
      return { matched: true, phrase: match[0].trim().slice(0, 80) };
    }
  }
  return { matched: false };
}

export function trustedNumbers(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.SPEKO_TRUSTED_NUMBERS ?? "")
      .split(",")
      .map((number) => normalizeE164(number.trim()))
      .filter(Boolean),
  );
}

export function isTrustedNumber(e164: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return trustedNumbers(env).has(normalizeE164(e164));
}
