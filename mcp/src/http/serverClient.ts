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

interface RequestContext {
  method: "GET" | "POST";
  path: string;
}

const DIAL_PATHS = new Set(["/call", "/call-number", "/call-me"]);
const RETRY_SAFE_POST_PATHS = new Set(["/lookup"]);

function isDialMutation(context: RequestContext): boolean {
  return context.method === "POST" && DIAL_PATHS.has(context.path);
}

function isRetrySafeOperation(context: RequestContext): boolean {
  return context.method === "GET" || (context.method === "POST" && RETRY_SAFE_POST_PATHS.has(context.path));
}

function uncertainDialOutcomeGuidance(): string {
  return (
    "The outcome is unknown and a call may already have been placed. Do not retry or place another call. " +
    "If you have a call ID, inspect it with get_call; otherwise review recent calls before taking any action."
  );
}

function uncertainMutationOutcomeGuidance(context: RequestContext): string {
  if (isDialMutation(context)) return uncertainDialOutcomeGuidance();
  return (
    "The outcome is unknown and the operation may already have been applied. Do not retry until you verify " +
    "the current server state."
  );
}

function boundedInline(value: string, maxLength = 1_000): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function remoteDiagnostic(status: number): string {
  return `The Speko backing server returned HTTP ${status}.`;
}

function isKnownPreDialRejection(status: number | undefined): boolean {
  return status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 422;
}

/**
 * Apply the caller's timeout + abort signal to in-process work. The core functions don't take a
 * signal, so we can't cancel the underlying work, but we DO return control to the tool instead of
 * hanging forever — matching the guarantees the HTTP backend gives via fetch(). Honors an already
 * aborted signal, a timeout, and an abort mid-flight.
 */
function withOpts<T>(opts: RequestOptions, context: RequestContext, work: () => Promise<T>): Promise<T> {
  const { timeoutMs, signal } = opts;
  if (signal?.aborted) {
    return Promise.reject(
      new DemoServerError("The request was aborted before it started; next_step=Retry only if the operation is still needed."),
    );
  }
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
      const nextStep = isRetrySafeOperation(context)
        ? "The request was aborted. Retry only if the operation is still needed."
        : uncertainMutationOutcomeGuidance(context);
      reject(new DemoServerError(`The request was aborted; next_step=${nextStep}`));
    };
    if (typeof timeoutMs === "number") {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new DemoServerError(
            `The in-process backend did not finish within ${Math.round(timeoutMs / 1000)}s; ` +
              `next_step=${
                isRetrySafeOperation(context)
                  ? "The operation may still be running. Check its status before retrying."
                  : uncertainMutationOutcomeGuidance(context)
              }`,
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

/** Derive recovery guidance locally so remote response prose cannot instruct the agent. */
function nextStepForHttpStatus(status: number, context: RequestContext): string {
  if (status === 401 || status === 403) {
    return (
      "Verify that MCP_INTERNAL_KEY matches the configured remote server and SPEKO_MCP_SERVER_URL points to it. " +
      "Alternatively, unset SPEKO_MCP_SERVER_URL and authenticate single-process mode with SPEKO_API_KEY."
    );
  }
  if (status === 402) return "Add credits at https://platform.speko.dev - calls are billed per minute.";
  if (!isRetrySafeOperation(context) && (status === 408 || status === 429 || status >= 500)) {
    return uncertainMutationOutcomeGuidance(context);
  }
  if (status === 429) return "Rate limited - wait a minute, then retry the safe operation.";
  if (status >= 500) return "The backing server hit a transient error - wait a moment and retry the safe operation.";
  if (status === 400 || status === 404 || status === 422) {
    return isDialMutation(context)
      ? "The request was rejected before a call was placed. Check the fields and readiness guidance before retrying."
      : "The request was rejected. Check the fields and readiness guidance before retrying.";
  }
  if (!isRetrySafeOperation(context)) {
    return "Review the server diagnostic and verify current state before deciding whether to retry.";
  }
  return "Check the request and retry; run check_call_readiness if calls keep failing.";
}

/** Turn a thrown core error into a safe `; next_step=` shape. */
function normalizeError(e: unknown, context: RequestContext): Error {
  const err = e as { message?: string; nextStep?: string; statusCode?: number };
  if (!isRetrySafeOperation(context) && !isKnownPreDialRejection(err?.statusCode)) {
    return new DemoServerError(
      `The in-process ${context.method} ${context.path} operation failed after it may have started; ` +
        `next_step=${uncertainMutationOutcomeGuidance(context)}`,
    );
  }
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
    return withOpts(opts, { method: "POST", path }, () => this.dispatchPost(path, body));
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
      if (path === "/call-me") {
        return await core.callMe(
          {
            message: String(b.message ?? ""),
            mode: b.mode === "notify" ? "notify" : "converse",
            context: (b.context as string | undefined) ?? null,
            afterHoursConfirmation:
              typeof b.after_hours_confirmation === "string" ? b.after_hours_confirmation : null,
            maxDurationSeconds: typeof b.max_duration_seconds === "number" ? b.max_duration_seconds : undefined,
            wait: typeof b.wait === "boolean" ? b.wait : true,
          },
          { client: ctx.client, cfg: ctx.cfg, bearerHash: ctx.bearerHash },
        );
      }
      throw new DemoServerError(`Unknown backend path: POST ${path}`);
    } catch (e) {
      throw normalizeError(e, { method: "POST", path });
    }
  }

  async get(path: string, opts: RequestOptions = {}): Promise<unknown> {
    return withOpts(opts, { method: "GET", path }, () => this.dispatchGet(path));
  }

  private async dispatchGet(path: string): Promise<unknown> {
    const { core, ctx } = await this.init();
    try {
      if (path === "/readiness") return await core.checkReadiness(ctx.client, ctx.cfg);
      if (path.startsWith("/call/")) {
        return await core.describeCall(
          decodeURIComponent(path.slice("/call/".length)),
          ctx.client,
          ctx.cfg.dashboardBaseUrl,
        );
      }
      throw new DemoServerError(`Unknown backend path: GET ${path}`);
    } catch (e) {
      throw normalizeError(e, { method: "GET", path });
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

  private async request(method: "GET" | "POST", path: string, body: unknown, opts: RequestOptions): Promise<unknown> {
    const context = { method, path } satisfies RequestContext;
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
      if (!isRetrySafeOperation(context)) {
        const reason = err.name === "TimeoutError" ? "timed out" : opts.signal?.aborted ? "was aborted" : "failed";
        throw new DemoServerError(
          `The ${method} ${path} request ${reason} after it may have reached the server; ` +
            `next_step=${uncertainMutationOutcomeGuidance(context)}`,
        );
      }
      if (opts.signal?.aborted) {
        throw new DemoServerError(
          "The request was aborted; next_step=Retry the safe operation only if it is still needed.",
        );
      }
      if (err.name === "TimeoutError") {
        throw new DemoServerError(
          `The Speko backing server did not respond within ${Math.round(timeoutMs / 1000)}s; ` +
            "next_step=Wait a moment, verify that the backing server is reachable, then retry the safe operation.",
        );
      }
      throw new DemoServerError(
        `Could not reach the Speko backing server at ${this.baseUrl}: ${err.message}; ` +
          "next_step=Verify SPEKO_MCP_SERVER_URL, MCP_INTERNAL_KEY, and server reachability. " +
          "To use single-process mode instead, unset SPEKO_MCP_SERVER_URL and configure SPEKO_API_KEY.",
      );
    }

    if (!resp.ok) {
      try {
        await resp.body?.cancel();
      } catch {
        // The local recovery guidance must still be returned if cleanup fails.
      }
      const nextStep = nextStepForHttpStatus(resp.status, context);
      throw new DemoServerError(`${remoteDiagnostic(resp.status)}; next_step=${nextStep}`);
    }

    let text: string;
    try {
      text = await resp.text();
    } catch (e) {
      const err = e as Error;
      if (!isRetrySafeOperation(context)) {
        throw new DemoServerError(
          `The ${method} ${path} response could not be read after the request reached the server: ${boundedInline(err.message)}; ` +
            `next_step=${uncertainMutationOutcomeGuidance(context)}`,
        );
      }
      throw new DemoServerError(
        `Could not read the Speko backing server response: ${boundedInline(err.message)}; ` +
          "next_step=Retry the safe operation after verifying that the backing server is reachable.",
      );
    }
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 500) };
      }
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
