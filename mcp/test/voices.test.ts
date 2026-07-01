import { describe, expect, it } from "vitest";
import type { Speko } from "@spekoai/sdk";
import { runVoices } from "../src/cli/voices.js";

interface Captured {
  params?: Record<string, unknown>;
}

function fakeSpeko(): { speko: Speko; calls: Captured } {
  const calls: Captured = {};
  const speko = {
    voices: {
      list: async (params: Record<string, unknown>) => {
        calls.params = params;
        return {
          voices: [{ vendor: "cartesia", id: "sonic-1", name: "Sonic" }],
          providers: [
            { key: "cartesia", name: "Cartesia", models: ["sonic-2"], voicesFetchedLive: false },
            { key: "elevenlabs", name: "ElevenLabs", models: ["eleven_turbo_v2_5"], voicesFetchedLive: true },
          ],
        };
      },
    },
  } as unknown as Speko;
  return { speko, calls };
}

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => void out.push(s) }, stderr: (l: string) => void err.push(l) };
}

describe("runVoices", () => {
  it("renders providers + voices and forwards --provider", async () => {
    const { speko, calls } = fakeSpeko();
    const c = cap();
    const code = await runVoices(["--provider", "cartesia"], { speko, stdout: c.stdout, stderr: c.stderr });
    expect(code).toBe(0);
    expect(calls.params).toEqual({ provider: "cartesia" });
    const text = c.out.join("");
    expect(text).toMatch(/cartesia/);
    expect(text).toMatch(/Sonic/);
    expect(text).toMatch(/account-scoped/); // the ElevenLabs note
  });

  it("emits JSON with --json", async () => {
    const { speko } = fakeSpeko();
    const c = cap();
    await runVoices(["--json"], { speko, stdout: c.stdout, stderr: c.stderr });
    const json = JSON.parse(c.out.join("").trim());
    expect(json.voices[0].id).toBe("sonic-1");
  });
});
