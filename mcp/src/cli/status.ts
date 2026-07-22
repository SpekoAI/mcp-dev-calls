/**
 * `speko status` (alias: `speko whoami`) — one doctor-style health check: which key is
 * configured, which backend mode the MCP tools would run in, and the account's call
 * readiness (auth, prepaid balance, caller-ID) from the same /readiness report
 * check_call_readiness uses. Never dials.
 *
 * Exit codes: 0 = ready to place calls; 1 = not ready / the check failed; 2 = bad flags.
 */
import { parseArgs } from "node:util";
import { getServerClient, type Backend } from "../http/serverClient.js";
import { loadEnv, serverEndpoint } from "../lib/env.js";

export interface StatusDeps {
  backend?: Pick<Backend, "get">;
  stdout?: { write: (s: string) => void };
  stderr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

interface ReadinessLike {
  headline?: string;
  next_steps?: string[];
  auth?: { ok?: boolean };
  credits?: { balance_usd?: number | null; minimum_usd?: number; sufficient?: boolean };
}

const OPTIONS = {
  json: { type: "boolean" },
} as const;

/** Enough of the key to recognize it, never enough to use it. */
function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export async function runStatus(argv: string[], deps: StatusDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? ((line) => process.stderr.write(line + "\n"));

  let json = false;
  try {
    json = Boolean(parseArgs({ args: argv, options: OPTIONS }).values.json);
  } catch (e) {
    stderr(`status: ${(e as Error).message}`);
    return 2;
  }

  loadEnv();
  const env = deps.env ?? process.env;
  const keySource = (env.SPEKO_API_KEY ?? "").trim()
    ? "SPEKO_API_KEY"
    : (env.SPEKOAI_API_KEY ?? "").trim()
      ? "SPEKOAI_API_KEY"
      : null;
  const key = keySource ? (env[keySource] ?? "").trim() : "";
  const explicitRemote = (env.SPEKO_MCP_SERVER_URL ?? "").trim();

  if (!key && !explicitRemote) {
    stderr(
      "No Speko key configured (SPEKO_API_KEY is not set) and no backing server URL. " +
        "Run `npx @spekoai/mcp-calls login` to set up.",
    );
    return 1;
  }

  // Mirrors getServerClient(): a key with no explicit remote runs the call backend in-process.
  const inProcess = Boolean(key) && !explicitRemote;
  const backendMode = inProcess ? "single-process (call backend runs in-process)" : `remote server at ${serverEndpoint().baseUrl}`;

  let report: ReadinessLike & Record<string, unknown>;
  try {
    const backend = deps.backend ?? getServerClient();
    report = (await backend.get("/readiness", { timeoutMs: 30_000 })) as ReadinessLike & Record<string, unknown>;
  } catch (e) {
    stderr(`status: ${(e as Error).message}`);
    return 1;
  }

  const ready = report.auth?.ok === true && report.credits?.sufficient === true;

  if (json) {
    stdout.write(
      JSON.stringify({
        key_source: keySource,
        backend: inProcess ? "in-process" : "remote",
        ...(inProcess ? {} : { server_url: serverEndpoint().baseUrl }),
        ready,
        ...report,
      }) + "\n",
    );
    return ready ? 0 : 1;
  }

  const balance = report.credits?.balance_usd;
  const minimum = report.credits?.minimum_usd;
  const lines: string[] = [
    `key:        ${keySource ? `${keySource} (${maskKey(key)})` : "none — using the backing server's credentials"}`,
    `backend:    ${backendMode}`,
    `readiness:  ${report.headline ?? (ready ? "ready" : "not ready")}`,
    `balance:    ${typeof balance === "number" ? `$${balance.toFixed(2)}` : "unknown"}${
      typeof minimum === "number" ? ` (minimum $${minimum.toFixed(2)} to place a call)` : ""
    }`,
  ];
  const steps = Array.isArray(report.next_steps) ? report.next_steps : [];
  if (steps.length) {
    lines.push("next steps:");
    for (const step of steps) lines.push(`  • ${step}`);
  }
  stdout.write(lines.join("\n") + "\n");
  return ready ? 0 : 1;
}
