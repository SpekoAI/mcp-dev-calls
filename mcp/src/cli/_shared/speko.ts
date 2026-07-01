/**
 * Speko SDK client factory for the voice CLI. Reuses the same key-resolution rules as the
 * in-process backend and the repo scripts. The CLI is a plain CONSUMER of @spekoai/sdk —
 * it constructs its own client (the call backend has no synth/transcribe path).
 */
import { Speko } from "@spekoai/sdk";
import { loadEnv } from "../../lib/env.js";

export class MissingKeyError extends Error {
  override name = "MissingKeyError";
}

/** Resolve + Bearer-strip the Speko API key from the environment. */
export function resolveApiKey(): string {
  const raw = (process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "").trim();
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}

/**
 * Construct a Speko client. Loads the repo/.env first (so `SPEKO_API_KEY` in a project
 * .env works exactly like the calling tools), then throws a MissingKeyError with an
 * actionable hint if no key is configured.
 */
export function makeSpeko(): Speko {
  loadEnv();
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new MissingKeyError(
      "SPEKO_API_KEY is not set. Get one at https://platform.speko.dev, then run " +
        "`npx @spekoai/mcp-calls login` (or export SPEKO_API_KEY=sk_...).",
    );
  }
  return new Speko({ apiKey });
}
