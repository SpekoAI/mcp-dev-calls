/**
 * Zed — detect-and-instruct only, deliberately no auto-write. Zed's
 * settings.json is JSONC (users keep comments in it) and its `context_servers`
 * schema has shifted across releases; a naive JSON round-trip would destroy
 * comments, and guessing the schema risks a config error in the editor. So we
 * print the snippet and let the user paste it — the one agent where manual is
 * the safe UX.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PKG, SERVER_NAME } from "./invocation.js";
import { zedSettingsPath } from "./paths.js";
import type { AgentTarget } from "./types.js";

export const zedTarget: AgentTarget = {
  id: "zed",
  label: "Zed",
  profile: "safe-default",
  detect: (ctx) => existsSync(dirname(zedSettingsPath(ctx))),
  write(key, ctx) {
    const snippet = JSON.stringify(
      {
        context_servers: {
          [SERVER_NAME]: {
            command: {
              path: "npx",
              args: ["-y", PKG],
              env: { SPEKO_API_KEY: key, SPEKO_CLIENT_PROFILE: "safe-default" },
            },
          },
        },
      },
      null,
      2,
    );
    return {
      ok: false,
      detail: `Zed's settings.json is often commented JSONC — add this to ${zedSettingsPath(ctx)} yourself:`,
      manual: snippet,
    };
  },
};
