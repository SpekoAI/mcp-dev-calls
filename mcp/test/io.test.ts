import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdinBytes, readStdinText, readStreamBytes } from "../src/cli/_shared/io.js";

describe("stdin io", () => {
  it("concatenates multi-chunk bytes exactly", async () => {
    const s = Readable.from([Buffer.from([0, 1, 2]), Buffer.from([3, 4])]);
    expect(Buffer.from(await readStdinBytes(s))).toEqual(Buffer.from([0, 1, 2, 3, 4]));
  });

  it("decodes multibyte UTF-8 split across a chunk boundary (decode-after-concat)", async () => {
    const str = "héllo — 世界";
    const bytes = Buffer.from(str, "utf-8");
    const mid = 3; // deliberately mid-codepoint
    const s = Readable.from([bytes.subarray(0, mid), bytes.subarray(mid)]);
    expect(await readStdinText(s)).toBe(str);
  });

  it("coerces string chunks to bytes", async () => {
    const s = Readable.from(["ab", "cd"]);
    expect(await readStdinText(s)).toBe("abcd");
  });

  it("rejects when the stream errors", async () => {
    const s = new Readable({
      read() {
        this.destroy(new Error("boom"));
      },
    });
    await expect(readStreamBytes(s)).rejects.toThrow("boom");
  });
});
