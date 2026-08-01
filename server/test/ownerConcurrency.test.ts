import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface WorkerResult {
  accepted: boolean;
  error: string | null;
}

const workerFile = fileURLToPath(new URL("./fixtures/ownerStateWorker.ts", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function waitForLine(child: ChildProcessWithoutNullStreams, predicate: (line: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`owner-state worker exited before its result (code ${code ?? "signal"})`));
    };
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function runContenders(mode: "lease" | "otp", count: number): Promise<WorkerResult[]> {
  const dir = mkdtempSync(join(tmpdir(), `speko-owner-${mode}-`));
  tempDirs.push(dir);
  const children = Array.from({ length: count }, (_, index) =>
    spawn(process.execPath, ["--import", "tsx", workerFile, mode, dir, String(index)], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );

  try {
    await Promise.all(children.map((child) => waitForLine(child, (line) => line === "ready")));
    const results = children.map((child) => waitForLine(child, (line) => line.startsWith("{")));
    for (const child of children) child.stdin.end("go\n");
    return (await Promise.all(results)).map((line) => JSON.parse(line) as WorkerResult);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}

describe("owner state cross-process serialization", () => {
  it(
    "accepts exactly one owner-call lease under simultaneous contention",
    async () => {
      const results = await runContenders("lease", 8);
      expect(results.filter((result) => result.accepted)).toHaveLength(1);
      expect(results.filter((result) => result.error)).toHaveLength(0);
    },
    30_000,
  );

  it(
    "accepts exactly three OTP call reservations under simultaneous contention",
    async () => {
      const results = await runContenders("otp", 8);
      expect(results.filter((result) => result.accepted)).toHaveLength(3);
      expect(results.filter((result) => result.error)).toHaveLength(5);
      expect(results.filter((result) => result.error).every((result) => /3 in 24 hours/i.test(result.error ?? ""))).toBe(true);
    },
    30_000,
  );
});
