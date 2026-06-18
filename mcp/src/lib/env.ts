/**
 * The MCP tier holds NO Speko credentials. It only needs to know where the demo
 * backing server is. SPEKO_MCP_SERVER_URL (and an optional shared MCP_INTERNAL_KEY)
 * can come from the MCP host config or the repo-root .env.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(): void {
  const load = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (!load) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
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
      }
      return;
    }
  }
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
