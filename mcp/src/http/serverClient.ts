/**
 * Backend for the MCP tools. Two interchangeable implementations behind one `post`/`get`
 * surface (so the tools never change):
 *
 *  • InProcessBackend — single-process mode. When a SPEKO_API_KEY is present (and no
 *    explicit remote server is configured), the MCP runs the backing logic IN-PROCESS
 *    via @spekoai/mcp-calls-demo-server/core: no localhost server to boot, no extra hop.
 *    This is what makes `npx @spekoai/mcp-calls` + a key work on its own.
 *  • ServerClient (RemoteBackend) — HTTP to a backing server at SPEKO_MCP_SERVER_URL
 *    (a hosted Speko endpoint, or a local dev server). Used when SPEKO_MCP_SERVER_URL is
 *    set, or when there is no key to run in-process.
 *
 * Every error already carries an actionable `; next_step=...` so the tool layer can
 * rethrow and let the coding agent self-correct.
 */
import { randomBytes } from "node:crypto";
import type * as Core from "@spekoai/mcp-calls-demo-server/core";
import { loadEnv, serverEndpoint } from "../lib/env.js";

export class DemoServerError extends Error {
  override name = "DemoServerError";
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The single surface the tools depend on. */
export interface Backend {
  post(path: string, body: unknown, opts?: RequestOptions): Promise<unknown>;
  get(path: string, opts?: RequestOptions): Promise<unknown>;
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

/**
 * Apply the caller's timeout + abort signal to in-process work. The core functions don't take a
 * signal, so we can't cancel the underlying work, but we DO return control to the tool instead of
 * hanging forever — matching the guarantees the HTTP backend gives via fetch(). Honors an already
 * aborted signal, a timeout, and an abort mid-flight.
 */
function withOpts<T>(opts: RequestOptions, work: () => Promise<T>): Promise<T> {
  const { timeoutMs, signal } = opts;
  if (signal?.aborted) return Promise.reject(new DemoServerError("The request was aborted before it started."));
  const base = work();
  if (timeoutMs == null && !signal) return base;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DemoServerError("The request was aborted."));
    };
    if (typeof timeoutMs === "number") {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new DemoServerError(
            `The in-process backend did not finish within ${Math.round(timeoutMs / 1000)}s; ` +
              "next_step=The call may still be running server-side — check it with get_call.",
          ),
        );
      }, timeoutMs);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    base.then(
      (v) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e as Error);
      },
    );
  });
}

/** Turn a thrown core error into the `; next_step=` shape the HTTP path also produces. */
function normalizeError(e: unknown): Error {
  const err = e as { message?: string; nextStep?: string };
  if (err && typeof err.message === "string") {
    if (typeof err.nextStep === "string" && err.nextStep && !err.message.includes("next_step=")) {
      return new DemoServerError(`${err.message}; next_step=${err.nextStep}`);
    }
    return e instanceof Error ? e : new DemoServerError(err.message);
  }
  return e instanceof Error ? e : new DemoServerError(String(e));
}

/**
 * Single-process backend: builds one context (config + SDK client + dial-token binding)
 * and dispatches the same paths the Express router serves, calling the core directly.
 */
export class InProcessBackend implements Backend {
  private ready: Promise<{ core: typeof Core; ctx: Core.ServerContext }> | undefined;

  private init(): Promise<{ core: typeof Core; ctx: Core.ServerContext }> {
    if (!this.ready) {
      this.ready = (async () => {
        // For a single process that both mints AND verifies dial tokens, a per-process
        // random secret is sufficient and removes a config step from onboarding.
        if (!(process.env.SPEKO_DIAL_TOKEN_SECRET ?? "").trim()) {
          process.env.SPEKO_DIAL_TOKEN_SECRET = randomBytes(32).toString("hex");
        }
        const core = (await import("@spekoai/mcp-calls-demo-server/core")) as typeof Core;
        const cfg = core.loadConfig();
        return { core, ctx: core.buildContext(cfg) };
      })();
    }
    return this.ready;
  }

  async post(path: string, body: unknown, opts: RequestOptions = {}): Promise<unknown> {
    return withOpts(opts, () => this.dispatchPost(path, body));
  }

  private async dispatchPost(path: string, body: unknown): Promise<unknown> {
    const { core, ctx } = await this.init();
    const b = (body ?? {}) as Record<string, unknown>;
    try {
      if (path === "/lookup") {
        return await core.lookupBusiness(
          {
            name: String(b.name ?? ""),
            location: (b.location as string | undefined) ?? null,
            phoneNumber: (b.phone_number as string | undefined) ?? null,
            utcOffsetMinutes: typeof b.utc_offset_minutes === "number" ? b.utc_offset_minutes : null,
          },
          { cfg: ctx.cfg, bearerHash: ctx.bearerHash },
        );
      }
      if (path === "/call") {
        return await core.makeCall(
          {
            dialToken: String(b.dial_token ?? ""),
            objective: String(b.objective ?? ""),
            callerName: String(b.caller_name ?? ""),
            context: (b.context as string | undefined) ?? null,
            behavior: (b.behavior as string | undefined) ?? null,
            greetFirst: typeof b.greet_first === "boolean" ? b.greet_first : null,
            afterHoursConfirmation: typeof b.after_hours_confirmation === "string" ? b.after_hours_confirmation : null,
            maxDurationSeconds: typeof b.max_duration_seconds === "number" ? b.max_duration_seconds : undefined,
          },
          { client: ctx.client, cfg: ctx.cfg, bearerHash: ctx.bearerHash },
        );
      }
      if (path === "/call-number") {
        return await core.callNumber(
          {
            phoneNumber: String(b.phone_number ?? ""),
            objective: String(b.objective ?? ""),
            callerName: String(b.caller_name ?? ""),
            context: (b.context as string | undefined) ?? null,
            behavior: (b.behavior as string | undefined) ?? null,
            greetFirst: typeof b.greet_first === "boolean" ? b.greet_first : null,
            afterHoursConfirmation: typeof b.after_hours_confirmation === "string" ? b.after_hours_confirmation : null,
            recipientName: (b.recipient_name as string | undefined) ?? null,
            utcOffsetMinutes: typeof b.utc_offset_minutes === "number" ? b.utc_offset_minutes : undefined,
            maxDurationSeconds: typeof b.max_duration_seconds === "number" ? b.max_duration_seconds : undefined,
          },
          { client: ctx.client, cfg: ctx.cfg, bearerHash: ctx.bearerHash },
        );
      }
      throw new DemoServerError(`Unknown backend path: POST ${path}`);
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async get(path: string, opts: RequestOptions = {}): Promise<unknown> {
    return withOpts(opts, () => this.dispatchGet(path));
  }

  private async dispatchGet(path: string): Promise<unknown> {
    const { core, ctx } = await this.init();
    try {
      if (path === "/readiness") return await core.checkReadiness(ctx.client);
      if (path.startsWith("/call/")) {
        return await core.describeCall(
          decodeURIComponent(path.slice("/call/".length)),
          ctx.client,
          ctx.cfg.dashboardBaseUrl,
        );
      }
      throw new DemoServerError(`Unknown backend path: GET ${path}`);
    } catch (e) {
      throw normalizeError(e);
    }
  }
}

/** Remote backend: HTTP to a backing server (hosted Speko endpoint or local dev server). */
export class ServerClient implements Backend {
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

  private async request(method: string, path: string, body: unknown, opts: RequestOptions): Promise<unknown> {
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
          `The Speko backing server did not respond within ${Math.round(timeoutMs / 1000)}s; ` +
            "next_step=The call may still be running server-side — wait a moment and check again, " +
            "and make sure the backing server is reachable.",
        );
      }
      throw new DemoServerError(
        `Could not reach the Speko backing server at ${this.baseUrl}: ${err.message}; ` +
          "next_step=Run 'npx @spekoai/mcp-calls init' to (re)configure, or set SPEKO_API_KEY for single-process mode.",
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
      let msg = typeof rec.error === "string" ? rec.error : `The Speko backing server returned ${resp.status}.`;

      const nextStep =
        typeof rec.next_step === "string"
          ? rec.next_step
          : typeof rec.nextStep === "string"
            ? rec.nextStep
            : null;

      if (nextStep && !msg.includes("next_step=")) {
        msg = `${msg}; next_step=${nextStep}`;
      } else if (!msg.includes("next_step=")) {
        if (resp.status === 401 || resp.status === 403) {
          msg = `${msg}; next_step=Re-run 'npx @spekoai/mcp-calls login' or check SPEKO_API_KEY in your MCP config.`;
        } else if (resp.status === 402) {
          msg = `${msg}; next_step=Your Speko prepaid credit balance is depleted. Top up at https://platform.speko.dev.`;
        } else if (resp.status === 429) {
          msg = `${msg}; next_step=Rate cap reached. Wait a short moment before retrying.`;
        } else if (resp.status >= 500) {
          msg = `${msg}; next_step=The backing server encountered an internal error. Retry in a few seconds.`;
        }
      }

      throw new DemoServerError(msg);
    }
    return data;
  }
}

let cached: Backend | undefined;

/**
 * Pick the backend: single-process (InProcessBackend) when a SPEKO_API_KEY is present and
 * no explicit remote server is set; otherwise HTTP (ServerClient) to SPEKO_MCP_SERVER_URL.
 */
export function getServerClient(): Backend {
  if (cached) return cached;
  loadEnv();
  const explicitRemote = (process.env.SPEKO_MCP_SERVER_URL ?? "").trim();
  const apiKey = (process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "").trim();

  if (apiKey && !explicitRemote) {
    cached = new InProcessBackend();
  } else {
    const endpoint = serverEndpoint();
    cached = new ServerClient({ baseUrl: endpoint.baseUrl, internalKey: endpoint.internalKey });
  }
  return cached;
}
