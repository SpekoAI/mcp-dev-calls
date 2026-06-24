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

function main(): void {
  const cfg = loadConfigOrExit();
  const app = buildApp(buildContext(cfg));
  app.listen(cfg.port, cfg.host, () => {
    log(`listening on http://${cfg.host}:${cfg.port}  (demo mode: ${cfg.demo.enabled ? "ON" : "off"})`);
    if (!cfg.demo.enabled && !cfg.googlePlacesApiKey) {
      log("note: demo off and no GOOGLE_PLACES_API_KEY → lookup_business will refuse until one is configured.");
    }
  });
}

main();
