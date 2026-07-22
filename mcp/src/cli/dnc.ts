/**
 * `speko dnc list|add|remove|check` — local do-not-call ledger management for the call guardrails.
 */
export interface DncDeps {
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

interface GuardModule {
  dncAdd(e164: string, meta: { source: "manual" }, dir?: string): void;
  dncList(dir?: string): Array<{ e164: string; ts: string; source: string; call_id?: string; phrase?: string }>;
  dncRemove(e164: string, dir?: string): boolean;
  normalizeE164(raw: string): string;
  resolveGuardStateDir(env?: NodeJS.ProcessEnv): string;
}

function isGuardModule(mod: unknown): mod is GuardModule {
  const candidate = mod as Partial<Record<keyof GuardModule, unknown>>;
  return (
    typeof candidate.dncAdd === "function" &&
    typeof candidate.dncList === "function" &&
    typeof candidate.dncRemove === "function" &&
    typeof candidate.normalizeE164 === "function" &&
    typeof candidate.resolveGuardStateDir === "function"
  );
}

async function loadGuard(): Promise<GuardModule> {
  // Static specifier so tsup inlines it into the published bundle (same pattern as
  // http/serverClient.ts); the guard helpers are re-exported from server/src/core.ts.
  const core = (await import("@spekoai/mcp-calls-demo-server/core")) as unknown;
  if (isGuardModule(core)) return core;
  throw new Error("Server guard helpers are not available from @spekoai/mcp-calls-demo-server/core.");
}

function usage(stderr: (line: string) => void): number {
  stderr("Usage: speko dnc list | add <e164> | remove <e164> | check <e164>");
  return 1;
}

/**
 * Validation is two-layered because normalizeE164 forgives junk it shouldn't: the RAW
 * input may only use phone formatting (digits, spaces, ().-, one leading +) — this rejects
 * digits embedded in prose ("call me at 5551234567 tomorrow") and "ext. 99" tails that
 * would otherwise normalize into a wrong-but-plausible number — and the normalized result
 * must fit the E.164 envelope (7-15 digits). `add` additionally requires the leading +
 * (see the add branch); `remove`/`check` accept plus-less forms so entries written under
 * the old lax validation can still be referenced and cleaned up.
 */
const PHONE_SHAPED = /^\+?[\d\s().-]+$/;

function normalizedNumber(guard: GuardModule, raw: string | undefined): string | null {
  if (typeof raw !== "string" || !PHONE_SHAPED.test(raw.trim())) return null;
  const normalized = guard.normalizeE164(raw);
  return /^\+?\d{7,15}$/.test(normalized) ? normalized : null;
}

function badNumber(stderr: (line: string) => void, raw: string): number {
  stderr(`dnc: '${raw}' does not look like a phone number — expected E.164, e.g. +14155550142.`);
  return 1;
}

export async function runDnc(argv: string[], deps: DncDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? ((line) => process.stderr.write(line + "\n"));
  const [command, rawNumber, ...extra] = argv;

  if (command === "list" && rawNumber === undefined) {
    const guard = await loadGuard();
    const dir = guard.resolveGuardStateDir(deps.env ?? process.env);
    const entries = guard.dncList(dir);
    if (!entries.length) {
      stdout.write("Do-not-call list is empty.\n");
      return 0;
    }
    for (const entry of entries) {
      const phrase = entry.phrase ? `  phrase="${entry.phrase}"` : "";
      stdout.write(`${entry.e164}  source=${entry.source}  ts=${entry.ts}${phrase}\n`);
    }
    return 0;
  }

  if (command === "add" && extra.length === 0 && typeof rawNumber === "string") {
    const guard = await loadGuard();
    const normalized = normalizedNumber(guard, rawNumber);
    if (!normalized) return badNumber(stderr, rawNumber);
    // Dial-time blocking matches normalized strings EXACTLY against dialed E.164 numbers
    // (which always carry +country), so a plus-less entry would sit on the ledger and
    // never block anything — reject it instead of storing a safety rule that can't fire.
    if (!normalized.startsWith("+")) {
      stderr(
        `dnc: '${rawNumber}' is missing the leading + and country code (e.g. +14155550142) — ` +
          "an entry without it would never match a dialed number.",
      );
      return 1;
    }
    const dir = guard.resolveGuardStateDir(deps.env ?? process.env);
    guard.dncAdd(rawNumber, { source: "manual" }, dir);
    stdout.write(`Added ${normalized} to the local do-not-call list.\n`);
    return 0;
  }

  if (command === "remove" && extra.length === 0 && typeof rawNumber === "string") {
    const guard = await loadGuard();
    const normalized = normalizedNumber(guard, rawNumber);
    if (!normalized) return badNumber(stderr, rawNumber);
    const dir = guard.resolveGuardStateDir(deps.env ?? process.env);
    const removed = guard.dncRemove(rawNumber, dir);
    stdout.write(
      removed
        ? `Removed ${normalized} from the local do-not-call list.\n`
        : `${normalized} was not on the local do-not-call list.\n`,
    );
    return 0;
  }

  // grep-style exit codes: 0 = on the list, 1 = not on it — scriptable without parsing output.
  if (command === "check" && extra.length === 0 && typeof rawNumber === "string") {
    const guard = await loadGuard();
    const normalized = normalizedNumber(guard, rawNumber);
    if (!normalized) return badNumber(stderr, rawNumber);
    const dir = guard.resolveGuardStateDir(deps.env ?? process.env);
    const entry = guard.dncList(dir).find((e) => guard.normalizeE164(e.e164) === normalized);
    if (entry) {
      stdout.write(`${normalized} IS on the local do-not-call list (source=${entry.source}, ts=${entry.ts}).\n`);
      return 0;
    }
    stdout.write(`${normalized} is not on the local do-not-call list.\n`);
    return 1;
  }

  return usage(stderr);
}
