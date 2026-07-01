import { describe, expect, it } from "vitest";
import type { Speko } from "@spekoai/sdk";
import { runTranscribe } from "../src/cli/audio/transcribe.js";

interface Captured {
  bytes?: Uint8Array;
  opts?: Record<string, unknown>;
}

function fakeSpeko(text = "hello world"): { speko: Speko; calls: Captured } {
  const calls: Captured = {};
  const speko = {
    transcribe: async (bytes: Uint8Array, opts: Record<string, unknown>) => {
      calls.bytes = bytes;
      calls.opts = opts;
      return { text, provider: "deepgram", model: "nova-3", confidence: 0.98, failoverCount: 0, scoresRunId: null };
    },
  } as unknown as Speko;
  return { speko, calls };
}

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => void out.push(s) }, stderr: (l: string) => void err.push(l) };
}

describe("runTranscribe", () => {
  it("transcribes a file, prints text to stdout, guesses content-type from the extension", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runTranscribe(
      ["rec.wav", "--lang", "en", "--keywords", "Speko, LiveKit", "--provider", "deepgram"],
      { speko, stdout: c.stdout, stderr: c.stderr, isTTY: false, stdinIsTTY: true, readFile: () => new Uint8Array([9, 9, 9]) },
    );
    expect(code).toBe(0);
    expect(calls.opts).toMatchObject({
      language: "en",
      contentType: "audio/wav",
      keywords: ["Speko", "LiveKit"],
      constraints: { allowedProviders: { stt: ["deepgram"] } },
    });
    expect(c.out.join("")).toBe("hello world\n");
    expect(c.err.join("\n")).toMatch(/via deepgram:nova-3 · conf 0\.98/);
  });

  it("reads audio from stdin when no positional is given", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    await runTranscribe([], {
      speko,
      stdout: c.stdout,
      stderr: c.stderr,
      isTTY: false,
      stdinIsTTY: false,
      readStdin: async () => new Uint8Array([1, 2]),
    });
    expect(Buffer.from(calls.bytes as Uint8Array)).toEqual(Buffer.from([1, 2]));
    expect(c.out.join("")).toBe("hello world\n");
  });

  it("emits JSON with --json", async () => {
    const { speko } = fakeSpeko("hi there");
    const c = cap();
    await runTranscribe(["r.wav", "--json"], { speko, stdout: c.stdout, stderr: c.stderr, readFile: () => new Uint8Array([1]) });
    const json = JSON.parse(c.out.join("").trim());
    expect(json).toMatchObject({ text: "hi there", provider: "deepgram", confidence: 0.98 });
  });

  it("writes a file with -o and still prints the transcript", async () => {
    const { speko } = fakeSpeko();
    const writes: Array<{ path: string; text: string }> = [];
    const c = cap();
    await runTranscribe(["r.wav", "-o", "out.txt"], {
      speko,
      stdout: c.stdout,
      stderr: c.stderr,
      isTTY: true,
      readFile: () => new Uint8Array([1]),
      writeFile: (p, t) => void writes.push({ path: p, text: t }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe("hello world");
    expect(c.out.join("")).toBe("hello world\n");
  });

  it("errors when there is no input and stdin is a TTY (exit 2)", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runTranscribe([], { speko, stdout: c.stdout, stderr: c.stderr, stdinIsTTY: true });
    expect(code).toBe(2);
  });
});
