import { spawn } from "node:child_process";

/** Run a CLI invocation of a bundle; capture code/stdout/stderr with a hard timeout. */
export function runCli(bundlePath, argv, { env = {}, cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundlePath, ...argv], {
      cwd,
      env: { ...baseEnv(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ code: "TIMEOUT", stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

/** Minimal, isolated env: no inherited SPEKO_*, no repo .env pickup (cwd is set by caller). */
export function baseEnv() {
  const keep = ["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "LC_ALL"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  // .env discovery is also BUNDLE-relative, so an isolated cwd alone doesn't stop a
  // developer's repo-root .env from leaking into probes. 0.4.9 ignores this knob;
  // current bundles honor it — probe output is identical on a clean machine either way.
  env.SPEKO_NO_DOTENV = "1";
  return env;
}
