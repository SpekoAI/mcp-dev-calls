import { describe, expect, it } from "vitest";
import { onPath, pickPlayer, playFile } from "../src/cli/_shared/play.js";

const withBins =
  (...bins: string[]) =>
  (b: string) =>
    bins.includes(b);

describe("pickPlayer", () => {
  it("prefers afplay on macOS", () => {
    expect(pickPlayer("darwin", withBins("afplay", "ffplay"))?.cmd).toBe("afplay");
  });
  it("falls back to ffplay on macOS", () => {
    expect(pickPlayer("darwin", withBins("ffplay"))?.cmd).toBe("ffplay");
  });
  it("returns null when no player on macOS", () => {
    expect(pickPlayer("darwin", withBins())).toBeNull();
  });
  it("uses available linux players, null when none", () => {
    expect(pickPlayer("linux", withBins("aplay"))?.cmd).toBe("aplay");
    expect(pickPlayer("linux", withBins("paplay"))?.cmd).toBe("paplay");
    expect(pickPlayer("linux", withBins())).toBeNull();
  });
  it("uses powershell on windows when ffplay is absent", () => {
    expect(pickPlayer("win32", withBins("powershell"))?.cmd).toBe("powershell");
  });
  it("builds args as a function of the file path", () => {
    const p = pickPlayer("darwin", withBins("afplay"));
    expect(p?.args("/tmp/x.wav")).toEqual(["/tmp/x.wav"]);
  });

  it("doubles single quotes in the Windows powershell path (no PS string break)", () => {
    const p = pickPlayer("win32", withBins("powershell"));
    expect(p?.args("C:\\Users\\O'Brien\\a.wav").join(" ")).toContain("O''Brien");
  });
});

describe("playFile / onPath", () => {
  it("returns false without spawning when no player is on PATH", async () => {
    expect(await playFile("/tmp/x.wav", { platform: "darwin", has: () => false })).toBe(false);
  });

  it("never throws even when the chosen player is absent (spawn error is swallowed)", async () => {
    await expect(playFile("/tmp/x.wav", { platform: "linux", has: (b) => b === "aplay" })).resolves.toBe(true);
  });

  it("onPath returns false for a guaranteed-absent binary", () => {
    expect(onPath("definitely-not-a-real-binary-xyz-123")).toBe(false);
  });
});
