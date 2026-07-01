/**
 * Audio helpers for the voice CLI: content-type → file extension, PCM → WAV wrapping
 * (ported verbatim from scripts/english-voices.mjs so playback matches the proven path),
 * and a best-guess content-type for a local audio file.
 */

/** Parse the sample rate from a content-type like "audio/pcm;rate=24000". Defaults to 24000. */
export function pcmSampleRate(contentType: string): number {
  const m = /rate=(\d+)/i.exec(contentType);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 24000;
}

/** File extension (no dot) for a synth content-type. PCM is wrapped into a WAV container. */
export function extForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("wav")) return "wav";
  if (ct.includes("pcm")) return "wav";
  if (ct.includes("opus")) return "opus";
  if (ct.includes("ogg")) return "ogg";
  if (ct.includes("aac")) return "aac";
  if (ct.includes("flac")) return "flac";
  return "audio";
}

/** Wrap raw 16-bit mono PCM in a 44-byte WAV header so the OS can play it. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono * 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/**
 * Turn synth output into playable/writable bytes + the right container extension.
 * Raw PCM is wrapped into a WAV; everything else (mp3/wav/ogg/...) passes through.
 */
export function toPlayable(audio: Uint8Array, contentType: string): { bytes: Uint8Array; ext: string } {
  const ct = contentType.toLowerCase();
  if (ct.includes("pcm")) {
    return { bytes: pcmToWav(audio, pcmSampleRate(contentType)), ext: "wav" };
  }
  return { bytes: audio, ext: extForContentType(contentType) };
}

/** Best-guess request content-type for a local audio file, from its extension. */
export function guessAudioContentType(pathOrExt: string): string | undefined {
  const ext = pathOrExt.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    mpeg: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/opus",
    flac: "audio/flac",
    aac: "audio/aac",
    webm: "audio/webm",
  };
  return map[ext];
}
