import { describe, expect, it } from "vitest";
import { resolveOutTarget } from "../src/cli/_shared/artifact.js";

describe("resolveOutTarget", () => {
  it("uses an explicit file path as-is", () => {
    expect(resolveOutTarget({ out: "clip.mp3", isTTY: true, ext: "mp3", id: "abc", cwd: "/tmp" })).toEqual({
      mode: "file",
      path: "clip.mp3",
    });
  });

  it("auto-names inside an explicit directory", () => {
    expect(
      resolveOutTarget({ out: "/out", outIsDir: true, isTTY: true, ext: "mp3", id: "abc", cwd: "/x" }),
    ).toEqual({ mode: "file", path: "/out/abc.mp3" });
    expect(resolveOutTarget({ out: "outdir/", isTTY: true, ext: "wav", id: "id1", cwd: "/x" })).toEqual({
      mode: "file",
      path: "outdir/id1.wav",
    });
  });

  it("streams to stdout when piped (no TTY, no -o)", () => {
    expect(resolveOutTarget({ isTTY: false, ext: "mp3", id: "abc", cwd: "/tmp" })).toEqual({ mode: "stdout" });
  });

  it("auto-names in cwd interactively, honoring SPEKO_OUTPUT_DIR", () => {
    expect(resolveOutTarget({ isTTY: true, ext: "wav", id: "zz", cwd: "/home" })).toEqual({
      mode: "file",
      path: "/home/zz.wav",
    });
    expect(resolveOutTarget({ isTTY: true, outputDir: "/aud", ext: "mp3", id: "i", cwd: "/home" })).toEqual({
      mode: "file",
      path: "/aud/i.mp3",
    });
  });
});
