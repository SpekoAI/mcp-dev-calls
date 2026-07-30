import { describe, expect, it } from "vitest";
import { resolveOutTarget } from "../src/cli/_shared/artifact.js";

function norm(res: ReturnType<typeof resolveOutTarget>) {
  return res.path ? { ...res, path: res.path.replace(/\\/g, "/") } : res;
}

describe("resolveOutTarget", () => {
  it("uses an explicit file path as-is", () => {
    expect(norm(resolveOutTarget({ out: "clip.mp3", isTTY: true, ext: "mp3", id: "abc", cwd: "/tmp" }))).toEqual({
      mode: "file",
      path: "clip.mp3",
    });
  });

  it("auto-names inside an explicit directory", () => {
    expect(
      norm(resolveOutTarget({ out: "/out", outIsDir: true, isTTY: true, ext: "mp3", id: "abc", cwd: "/x" })),
    ).toEqual({ mode: "file", path: "/out/abc.mp3" });
    expect(norm(resolveOutTarget({ out: "outdir/", isTTY: true, ext: "wav", id: "id1", cwd: "/x" }))).toEqual({
      mode: "file",
      path: "outdir/id1.wav",
    });
  });

  it("streams to stdout when piped (no TTY, no -o)", () => {
    expect(norm(resolveOutTarget({ isTTY: false, ext: "mp3", id: "abc", cwd: "/tmp" }))).toEqual({ mode: "stdout" });
  });

  it("auto-names in cwd interactively, honoring SPEKO_OUTPUT_DIR", () => {
    expect(norm(resolveOutTarget({ isTTY: true, ext: "wav", id: "zz", cwd: "/home" }))).toEqual({
      mode: "file",
      path: "/home/zz.wav",
    });
    expect(norm(resolveOutTarget({ isTTY: true, outputDir: "/aud", ext: "mp3", id: "i", cwd: "/home" }))).toEqual({
      mode: "file",
      path: "/aud/i.mp3",
    });
  });
});
