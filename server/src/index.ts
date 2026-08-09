/**
 * Demo backing server bootstrap. Listens on 127.0.0.1 by default and exposes
 * POST /lookup, POST /call, GET /readiness, GET /healthz for the MCP tier.
 */
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { ConfigError, loadConfig } from "./config.js";
import { buildContext } from "./http/context.js";

function log(msg: string): void {
  process.stdout.write(`[speko-demo-server] ${msg}\n`);
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[speko-demo-server] config error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

function main(): void {
  const cfg = loadConfigOrExit();
  // Hermetic test mode is single-process (in-process MCP) ONLY. Serving simulated results over
  // HTTP would let a remote real-mode client mistake fake calls for real ones, so refuse to boot.
  if (cfg.testMode) {
    process.stderr.write(
      "[speko-demo-server] SPEKO_TEST_MODE is an in-process simulation mode; the HTTP server refuses " +
        "to start under it so simulated results can never be served to a remote client as real. " +
        "Unset SPEKO_TEST_MODE to run the server.\n",
    );
    process.exit(1);
  }
  // The endpoints place real, credit-debiting calls. Binding a routable interface without the
  // shared-secret gate would expose unauthenticated call placement, so refuse it. (The default
  // is 127.0.0.1, and the npx single-process path never opens this server at all.)
  if (!LOOPBACK_HOSTS.has(cfg.host) && !cfg.internalKey) {
    process.stderr.write(
      `[speko-demo-server] refusing to bind non-loopback host '${cfg.host}' without MCP_INTERNAL_KEY — ` +
        "that would expose unauthenticated call placement. Set MCP_INTERNAL_KEY, or bind HOST=127.0.0.1.\n",
    );
    process.exit(1);
  }
  const app = buildApp(buildContext(cfg));
  app.listen(cfg.port, cfg.host, () => {
    log(`listening on http://${cfg.host}:${cfg.port}  (demo mode: ${cfg.demo.enabled ? "ON" : "off"})`);
    if (!cfg.demo.enabled && !cfg.googlePlacesApiKey) {
      log("note: demo off and no GOOGLE_PLACES_API_KEY → lookup_business will refuse until one is configured.");
    }
  });
}

main();
