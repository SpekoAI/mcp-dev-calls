import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runSpeak, runTranscribe } = vi.hoisted(() => ({
  runSpeak: vi.fn(async () => 0),
  runTranscribe: vi.fn(async () => 0),
}));
vi.mock("../src/cli/audio/speak.js", () => ({ runSpeak }));
vi.mock("../src/cli/audio/transcribe.js", () => ({ runTranscribe }));

const { runAudio } = await import("../src/cli/audio/index.js");

describe("runAudio subrouter", () => {
  beforeEach(() => {
    runSpeak.mockClear();
    runTranscribe.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("delegates 'speak' with the sliced argv", async () => {
    await runAudio(["speak", "hi", "--json"]);
    expect(runSpeak).toHaveBeenCalledWith(["hi", "--json"]);
  });

  it("delegates 'transcribe' with the sliced argv", async () => {
    await runAudio(["transcribe", "f.wav"]);
    expect(runTranscribe).toHaveBeenCalledWith(["f.wav"]);
  });

  it("unknown subcommand → exit 2 with a message on stderr", async () => {
    const code = await runAudio(["bogus"]);
    expect(code).toBe(2);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/unknown subcommand 'bogus'/));
  });

  it("locks the exit-code asymmetry: bare `audio` → 1, help → 0", async () => {
    expect(await runAudio([])).toBe(1);
    expect(await runAudio(["--help"])).toBe(0);
    expect(await runAudio(["-h"])).toBe(0);
  });
});
