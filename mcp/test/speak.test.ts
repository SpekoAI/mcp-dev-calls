import { describe, expect, it } from "vitest";
import type { Speko } from "@spekoai/sdk";
import { runSpeak } from "../src/cli/audio/speak.js";

interface Captured {
  text?: string;
  opts?: Record<string, unknown>;
}

function fakeSpeko(over: { audio?: Uint8Array; contentType?: string } = {}): { speko: Speko; calls: Captured } {
  const calls: Captured = {};
  const speko = {
    synthesize: async (text: string, opts: Record<string, unknown>) => {
      calls.text = text;
      calls.opts = opts;
      return {
        audio: over.audio ?? new Uint8Array([1, 2, 3]),
        contentType: over.contentType ?? "audio/mpeg",
        provider: "elevenlabs",
        model: "eleven_turbo_v2_5",
        failoverCount: 0,
        scoresRunId: null,
      };
    },
  } as unknown as Speko;
  return { speko, calls };
}

function cap() {
  const out: Array<Uint8Array | string> = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (c: Uint8Array | string) => void out.push(c) },
    stderr: (l: string) => void err.push(l),
  };
}

describe("runSpeak", () => {
  it("maps flags → synthesize options and streams raw bytes to stdout when piped", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runSpeak(
      ["hello there", "--lang", "es", "--optimize-for", "balanced", "--voice", "V1", "--model", "m1", "--speed", "1.1", "--provider", "elevenlabs"],
      { speko, stdout: c.stdout, stderr: c.stderr, isTTY: false, stdinIsTTY: true },
    );
    expect(code).toBe(0);
    expect(calls.text).toBe("hello there");
    expect(calls.opts).toMatchObject({
      language: "es",
      optimizeFor: "balanced",
      voice: "V1",
      model: "m1",
      speed: 1.1,
      constraints: { allowedProviders: { tts: ["elevenlabs"] } },
    });
    expect(c.out).toHaveLength(1);
    expect(Buffer.from(c.out[0] as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    expect(c.err.join("\n")).toMatch(/via elevenlabs:eleven_turbo_v2_5 · failover 0/);
  });

  it("wraps PCM into a WAV on the stdout pipe", async () => {
    const { speko } = fakeSpeko({ contentType: "audio/pcm;rate=24000", audio: new Uint8Array([0, 0, 0, 0]) });
    const c = cap();
    await runSpeak(["hi"], { speko, stdout: c.stdout, stderr: c.stderr, isTTY: false, stdinIsTTY: true });
    const bytes = c.out[0] as Uint8Array;
    expect(bytes.length).toBe(48);
    expect(Buffer.from(bytes).toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("reads text from stdin when no positional and stdin is piped", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    await runSpeak([], {
      speko,
      stdout: c.stdout,
      stderr: c.stderr,
      isTTY: false,
      stdinIsTTY: false,
      readStdin: async () => "piped text\n",
    });
    expect(calls.text).toBe("piped text");
  });

  it("writes a predictable artifact and plays it interactively", async () => {
    const { speko } = fakeSpeko();
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const played: string[] = [];
    const c = cap();
    const code = await runSpeak(["hey"], {
      speko,
      stdout: c.stdout,
      stderr: c.stderr,
      isTTY: true,
      stdinIsTTY: true,
      id: "abcd1234",
      cwd: "/tmp/x",
      writeFile: (p, b) => void writes.push({ path: p, bytes: b }),
      play: async (p) => (played.push(p), true),
    });
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(/abcd1234\.mp3$/);
    expect(played[0]).toMatch(/abcd1234\.mp3$/);
    expect(c.err.join("\n")).toMatch(/✓ .*abcd1234\.mp3/);
  });

  it("emits JSON metadata with --json (file still written)", async () => {
    const { speko } = fakeSpeko();
    const writes: string[] = [];
    const c = cap();
    await runSpeak(["hi", "--json"], {
      speko,
      stdout: c.stdout,
      stderr: c.stderr,
      isTTY: true,
      stdinIsTTY: true,
      id: "id7",
      cwd: "/tmp",
      writeFile: (p) => void writes.push(p),
      play: async () => true,
    });
    expect(writes).toHaveLength(1);
    const json = JSON.parse((c.out[0] as string).trim());
    expect(json).toMatchObject({ provider: "elevenlabs", model: "eleven_turbo_v2_5" });
    expect(json.file).toMatch(/id7\.mp3$/);
  });

  it("rejects a bad --optimize-for (exit 2)", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runSpeak(["hi", "--optimize-for", "turbo"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(2);
    expect(c.err.join("\n")).toMatch(/optimize-for/);
  });

  it("errors when there is no text and stdin is a TTY (exit 2)", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    const code = await runSpeak([], { speko, stdout: c.stdout, stderr: c.stderr, stdinIsTTY: true });
    expect(code).toBe(2);
  });

  it("reports '(no audio player on PATH ...)' when playback returns false", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    await runSpeak(["hey"], {
      speko,
      stdout: c.stdout,
      stderr: c.stderr,
      isTTY: true,
      stdinIsTTY: true,
      id: "noplayer",
      cwd: "/tmp",
      writeFile: () => {},
      play: async () => false,
    });
    expect(c.err.join("\n")).toMatch(/no audio player on PATH/);
  });
});
