import type { AppConfig } from "../config.js";
import { serverBearerHash } from "../config.js";
import { SpekoClient } from "../speko/client.js";

/** Per-process server context: config + the single SDK client + dial-token binding. */
export interface ServerContext {
  cfg: AppConfig;
  client: SpekoClient;
  bearerHash: string;
}

export function buildContext(cfg: AppConfig): ServerContext {
  return { cfg, client: new SpekoClient(cfg), bearerHash: serverBearerHash(cfg) };
}
