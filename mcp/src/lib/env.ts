/**
 * The MCP tier holds NO Speko credentials. It only needs to know where the demo
 * backing server is. SPEKO_MCP_SERVER_URL (and an optional shared MCP_INTERNAL_KEY)
 * can come from the MCP host config or the repo-root .env.
 *
 * .env discovery is mode-gated. In MCP-server mode the cwd is whatever untrusted
 * repo the host happened to spawn us in — a planted .env there could silently
 * repoint SPEKO_MCP_SERVER_URL (or the API base) at an attacker's endpoint. So:
 *   • MCP-server mode SKIPS .env discovery unless SPEKO_ALLOW_DOTENV=1.
 *   • SPEKO_NO_DOTENV=1 force-disables discovery in ALL modes.
 *   • Whenever a .env IS loaded, one loud stderr line names the absolute path
 *     (stderr only — stdout stays reserved for JSON-RPC in server mode).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const truthy = (v: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

type DotenvMode = "cli" | "mcp-server";

// Default "cli": every CLI handler runs and exits before the server path, which flips
// this to "mcp-server" once — so later lazy loadEnv() calls (e.g. getServerClient inside
// a tool) inherit the server-mode gate.
let dotenvMode: DotenvMode = "cli";

export function setDotenvMode(mode: DotenvMode): void {
  dotenvMode = mode;
}

// Announce each loaded path once per process: loadEnv() is called from several CLI
// entry points (status, me, the SDK client factory) and must not spam stderr.
const announced = new Set<string>();

export interface LoadEnvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
}

/** Discover + load the nearest .env (mode-gated). Returns the loaded path, or null. */
export function loadEnv(opts: LoadEnvOptions = {}): string | null {
  const env = opts.env ?? process.env;
  if (truthy(env.SPEKO_NO_DOTENV)) return null;
  if (dotenvMode === "mcp-server" && !truthy(env.SPEKO_ALLOW_DOTENV)) return null;
  const load = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (!load) return null;
  const cwd = opts.cwd ?? process.cwd();
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(cwd, ".env"),
    resolve(cwd, "..", ".env"),
    resolve(here, "..", ".env"),
    resolve(here, "..", "..", ".env"),
    resolve(here, "..", "..", "..", ".env"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        load(path);
      } catch {
        // Fall back to the host environment if the file can't be read.
        return null;
      }
      if (!announced.has(path)) {
        announced.add(path);
        const write = opts.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
        write(`speko: loaded .env from ${path} (set SPEKO_NO_DOTENV=1 to disable .env discovery)`);
      }
      return path;
    }
  }
  return null;
}

/**
 * True when SPEKO_TEST_MODE selects the hermetic in-process simulation mode (same accepted
 * values as the server core's parser: 1/true/yes/on).
 */
export function testModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.SPEKO_TEST_MODE ?? "").trim().toLowerCase());
}

export interface ServerEndpoint {
  baseUrl: string;
  internalKey: string | undefined;
}

export function serverEndpoint(): ServerEndpoint {
  const baseUrl = (process.env.SPEKO_MCP_SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const internalKey = (process.env.MCP_INTERNAL_KEY ?? "").trim() || undefined;
  return { baseUrl, internalKey };
}
