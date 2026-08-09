import type { AppConfig } from "../config.js";
import { serverBearerHash } from "../config.js";
import { seedOwnerProfileFromEnv } from "../owner/portable.js";
import { SpekoClient } from "../speko/client.js";

/** Per-process server context: config + the single SDK client + dial-token binding. */
export interface ServerContext {
  cfg: AppConfig;
  client: SpekoClient;
  bearerHash: string;
}

export function buildContext(cfg: AppConfig): ServerContext {
  try {
    // Materialize portable owner state (SPEKO_OWNER_PROFILE) before anything reads owner.json.
    seedOwnerProfileFromEnv({ dir: cfg.ownerStateDir });
  } catch (error) {
    // Fail closed for call_me only: nothing was written and the rest of the server stays usable.
    process.stderr.write(`${(error as Error).message}\n`);
  }
  return { cfg, client: new SpekoClient(cfg), bearerHash: serverBearerHash(cfg) };
}
