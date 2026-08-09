import type { AppConfig } from "../config.js";
import { serverBearerHash } from "../config.js";
import { seedOwnerProfileFromEnv } from "../owner/portable.js";
import { FakeSpekoClient, seedTestModeOwner } from "../speko/fakeClient.js";
import { SpekoClient } from "../speko/client.js";

/** Per-process server context: config + the single SDK client + dial-token binding. */
export interface ServerContext {
  cfg: AppConfig;
  client: SpekoClient;
  bearerHash: string;
  /**
   * Test mode only: a compressed sleep injected into the call paths so simulated calls
   * finalize in milliseconds instead of real poll intervals. Real mode: undefined — the
   * call paths keep their default real-time sleep.
   */
  sleep?: (ms: number) => Promise<void>;
}

export function buildContext(cfg: AppConfig): ServerContext {
  if (cfg.testMode) {
    // Hermetic test mode: THE construction point for platform clients swaps in the fake, so a
    // real SpekoClient (and any network path) is structurally unreachable in this process. The
    // fixture owner wins here; SPEKO_OWNER_PROFILE seeding is a real-mode affordance.
    seedTestModeOwner(cfg);
    return {
      cfg,
      client: new FakeSpekoClient() as unknown as SpekoClient,
      bearerHash: serverBearerHash(cfg),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25))),
    };
  }
  try {
    // Materialize portable owner state (SPEKO_OWNER_PROFILE) before anything reads owner.json.
    seedOwnerProfileFromEnv({ dir: cfg.ownerStateDir });
  } catch (error) {
    // Fail closed for call_me only: nothing was written and the rest of the server stays usable.
    process.stderr.write(`${(error as Error).message}\n`);
  }
  return { cfg, client: new SpekoClient(cfg), bearerHash: serverBearerHash(cfg) };
}
