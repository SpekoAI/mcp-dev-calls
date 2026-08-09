import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSecretLineNonTTY, runInit } from "../src/cli/init.js";

/**
 * Non-TTY hardening for `speko init`: the documented `echo $KEY | speko init --paste`
 * must keep working, an empty line / EOF must FAIL (exit 1, never the old silent exit 0),
 * and a held-open empty stdin must never hang (a hung wizard inside a cloud sandbox
 * burns the host's whole idle timeout).
 */

describe("readSecretLineNonTTY", () => {
  it("reads the first piped line (echo $KEY | init --paste)", async () => {
    await expect(readSecretLineNonTTY(Readable.from(["sk_test_abc123\n"]))).resolves.toBe("sk_test_abc123");
  });

  it("trims surrounding whitespace", async () => {
    await expect(readSecretLineNonTTY(Readable.from(["  sk_test_abc123  \n"]))).resolves.toBe("sk_test_abc123");
  });

  it("resolves empty on an empty piped line", async () => {
    await expect(readSecretLineNonTTY(Readable.from(["\n"]))).resolves.toBe("");
  });

  it("resolves empty on immediate EOF (closed stdin, no line at all)", async () => {
    await expect(readSecretLineNonTTY(Readable.from([]))).resolves.toBe("");
  });

  it("never hangs on a held-open silent stdin: times out to empty", async () => {
    const heldOpen = new Readable({ read() {} }); // never pushes, never ends
    await expect(readSecretLineNonTTY(heldOpen, 50)).resolves.toBe("");
  });
});

describe("runInit exit codes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const silence = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true); // "Verifying key…" progress dots
  };

  it("exits 1 when the paste path yields no key (the verified-live echo \"\" bug)", async () => {
    silence();
    const code = await runInit(["--paste", "--yes"], "init", { readSecret: async () => "" });
    expect(code).toBe(1);
  });

  it("exits 0 when the paste path yields a key that verifies", async () => {
    silence();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 })),
    );
    const code = await runInit(["--paste", "--yes", "--print-config"], "init", {
      readSecret: async () => "sk_test_good_key",
    });
    expect(code).toBe(0);
  });

  it("exits 1 when the key fails verification (init --token WRONG)", async () => {
    silence();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 })),
    );
    const code = await runInit(["--token", "sk_wrong_key", "--yes"], "init");
    expect(code).toBe(1);
  });

  it("exits 1 when --client selects nothing valid", async () => {
    silence();
    const code = await runInit(["--client", "bogus-agent", "--token", "sk_any"], "init");
    expect(code).toBe(1);
  });
});
