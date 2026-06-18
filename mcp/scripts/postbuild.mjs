// Make the bundled entry npx/bin runnable: ensure a shebang and the executable bit.
// tsc emits plain ESM, so we add the shebang here rather than depend on mcp-build.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (existsSync(entry)) {
  const src = readFileSync(entry, "utf8");
  if (!src.startsWith("#!")) {
    writeFileSync(entry, `#!/usr/bin/env node\n${src}`);
  }
  chmodSync(entry, 0o755);
  process.stdout.write("postbuild: dist/index.js is executable with a shebang\n");
} else {
  process.stderr.write("postbuild: dist/index.js not found — did tsc run?\n");
  process.exit(1);
}
