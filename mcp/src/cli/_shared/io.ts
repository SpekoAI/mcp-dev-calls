/**
 * Tiny stdin/stdout helpers for the voice CLI. Kept separate so handlers can inject
 * fakes in tests and so the byte-clean pipe contract lives in one place.
 */
import { randomBytes } from "node:crypto";

/** Read ALL bytes from a stream (piped audio for `transcribe`). */
export function readStreamBytes(stream: NodeJS.ReadableStream = process.stdin): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer | string) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Read all of stdin as UTF-8 text (piped text for `speak`). */
export async function readStdinText(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return Buffer.from(await readStreamBytes(stream)).toString("utf-8");
}

/** Read all of stdin as raw bytes (piped audio for `transcribe`). */
export function readStdinBytes(stream: NodeJS.ReadableStream = process.stdin): Promise<Uint8Array> {
  return readStreamBytes(stream);
}

/** Short, filesystem-safe artifact id (8 hex chars). */
export function randomId(): string {
  return randomBytes(4).toString("hex");
}
