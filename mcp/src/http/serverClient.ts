/**
 * HTTP client to the demo backing server. Every error message it throws already
 * carries an actionable `; next_step=...` (either composed here for connectivity
 * problems, or relayed verbatim from the server's error envelope), so the tool
 * layer can simply rethrow and let the coding agent self-correct.
 */
import { loadEnv, serverEndpoint } from "../lib/env.js";

export class DemoServerError extends Error {
  override name = "DemoServerError";
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ServerClient {
  private readonly baseUrl: string;
  private readonly internalKey: string | undefined;

  constructor(opts: { baseUrl: string; internalKey?: string }) {
    this.baseUrl = opts.baseUrl;
    this.internalKey = opts.internalKey;
  }

  post(path: string, body: unknown, opts: RequestOptions = {}): Promise<unknown> {
    return this.request("POST", path, body, opts);
  }

  get(path: string, opts: RequestOptions = {}): Promise<unknown> {
    return this.request("GET", path, undefined, opts);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.internalKey) headers["x-internal-key"] = this.internalKey;

    const timeoutMs = opts.timeoutMs ?? 30_000;
    const signal = combineSignals(opts.signal, AbortSignal.timeout(timeoutMs));

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") {
        throw new DemoServerError(
          `The Speko demo server did not respond within ${Math.round(timeoutMs / 1000)}s; ` +
            "next_step=The call may still be running server-side — wait a moment and check again, " +
            "and make sure the demo server is still up.",
        );
      }
      throw new DemoServerError(
        `Could not reach the Speko demo server at ${this.baseUrl}: ${err.message}; ` +
          "next_step=Start it with 'npm run dev:server' from the repo root (or set SPEKO_MCP_SERVER_URL), then retry.",
      );
    }

    const text = await resp.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 500) };
      }
    }

    if (!resp.ok) {
      const rec = data as Record<string, unknown>;
      const msg = typeof rec.error === "string" ? rec.error : `The Speko demo server returned ${resp.status}.`;
      throw new DemoServerError(msg);
    }
    return data;
  }
}

let cached: ServerClient | undefined;

export function getServerClient(): ServerClient {
  if (!cached) {
    loadEnv();
    const endpoint = serverEndpoint();
    cached = new ServerClient({ baseUrl: endpoint.baseUrl, internalKey: endpoint.internalKey });
  }
  return cached;
}
