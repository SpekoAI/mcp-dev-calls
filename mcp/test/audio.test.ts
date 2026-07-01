import { describe, expect, it } from "vitest";
import {
  extForContentType,
  guessAudioContentType,
  pcmSampleRate,
  pcmToWav,
  toPlayable,
} from "../src/cli/_shared/audio.js";

describe("audio helpers", () => {
  it("extForContentType maps common content types", () => {
    expect(extForContentType("audio/mpeg")).toBe("mp3");
    expect(extForContentType("audio/pcm;rate=24000")).toBe("wav");
    expect(extForContentType("audio/wav")).toBe("wav");
    expect(extForContentType("audio/ogg")).toBe("ogg");
    expect(extForContentType("application/x-weird")).toBe("audio");
  });

  it("pcmSampleRate parses rate with a 24000 default", () => {
    expect(pcmSampleRate("audio/pcm;rate=16000")).toBe(16000);
    expect(pcmSampleRate("audio/pcm")).toBe(24000);
    expect(pcmSampleRate("audio/mpeg")).toBe(24000);
  });

  it("pcmToWav prepends a valid 44-byte RIFF/WAVE header", () => {
    const wav = pcmToWav(new Uint8Array(100), 24000);
    expect(wav.length).toBe(144);
    const b = Buffer.from(wav);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.toString("ascii", 8, 12)).toBe("WAVE");
    expect(b.readUInt32LE(24)).toBe(24000);
    expect(b.readUInt32LE(40)).toBe(100);
  });

  it("toPlayable wraps pcm to wav, passes mp3 through unchanged", () => {
    const w = toPlayable(new Uint8Array([0, 0, 0, 0]), "audio/pcm;rate=24000");
    expect(w.ext).toBe("wav");
    expect(w.bytes.length).toBe(48);
    expect(Buffer.from(w.bytes).toString("ascii", 0, 4)).toBe("RIFF");

    const m = toPlayable(new Uint8Array([1, 2, 3]), "audio/mpeg");
    expect(m.ext).toBe("mp3");
    expect(Buffer.from(m.bytes)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("guessAudioContentType from a filename extension", () => {
    expect(guessAudioContentType("rec.wav")).toBe("audio/wav");
    expect(guessAudioContentType("/a/b/x.mp3")).toBe("audio/mpeg");
    expect(guessAudioContentType("y.flac")).toBe("audio/flac");
    expect(guessAudioContentType("noext")).toBeUndefined();
  });
});
