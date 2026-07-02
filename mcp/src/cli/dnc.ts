/**
 * `speko dnc list|add|remove` — local do-not-call ledger management for the call guardrails.
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
  stderr("Usage: speko dnc list | add <e164> | remove <e164>");
  return 1;
}

function looksLikePhoneNumber(raw: string | undefined): raw is string {
  return typeof raw === "string" && /\d/.test(raw);
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

  if (command === "add" && extra.length === 0 && looksLikePhoneNumber(rawNumber)) {
    const guard = await loadGuard();
    const dir = guard.resolveGuardStateDir(deps.env ?? process.env);
    guard.dncAdd(rawNumber, { source: "manual" }, dir);
    stdout.write(`Added ${guard.normalizeE164(rawNumber)} to the local do-not-call list.\n`);
    return 0;
  }

  if (command === "remove" && extra.length === 0 && looksLikePhoneNumber(rawNumber)) {
    const guard = await loadGuard();
    const dir = guard.resolveGuardStateDir(deps.env ?? process.env);
    const normalized = guard.normalizeE164(rawNumber);
    const removed = guard.dncRemove(rawNumber, dir);
    stdout.write(
      removed
        ? `Removed ${normalized} from the local do-not-call list.\n`
        : `${normalized} was not on the local do-not-call list.\n`,
    );
    return 0;
  }

  return usage(stderr);
}
