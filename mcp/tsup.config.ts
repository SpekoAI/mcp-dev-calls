import { defineConfig } from "tsup";

/**
 * Bundle the MCP into ONE self-contained dist/index.js. The backing core
 * (lookup / rails / dial logic from @spekoai/mcp-calls-demo-server/core) is INLINED so
 * the published package needs no second package and never drags in Express. Only the
 * genuinely-shared runtime deps stay external (declared in package.json dependencies).
 *
 * Because everything is bundled, mcp-framework's filesystem tool discovery won't find
 * the tools — index.ts registers them explicitly via server.addTool().
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  // Keep these as real runtime deps; bundle everything else (our code + the core).
  external: ["mcp-framework", "@modelcontextprotocol/sdk", "@spekoai/sdk", "zod"],
});
