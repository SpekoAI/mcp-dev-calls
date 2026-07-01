/**
 * Best-effort, cross-platform audio playback using OS players only (no native addon —
 * a `.node` binary wouldn't survive the single-file tsup bundle). Never throws; if no
 * player is on PATH it returns false so the caller can just report the saved file.
 */
import { spawn, spawnSync } from "node:child_process";

export interface Player {
  cmd: string;
  args: (file: string) => string[];
}

/** Pick an available player for the platform, or null. Pure given `has`. */
export function pickPlayer(platform: NodeJS.Platform, has: (bin: string) => boolean): Player | null {
  const ffplay: Player = { cmd: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] };
  if (platform === "darwin") {
    if (has("afplay")) return { cmd: "afplay", args: (f) => [f] };
    if (has("ffplay")) return ffplay;
    return null;
  }
  if (platform === "win32") {
    if (has("ffplay")) return ffplay;
    if (has("powershell")) {
      // Double single-quotes so a legitimate apostrophe path (e.g. C:\Users\O'Brien\x.wav)
      // can't break the PowerShell string literal.
      return {
        cmd: "powershell",
        args: (f) => ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${f.replace(/'/g, "''")}').PlaySync();`],
      };
    }
    return null;
  }
  // linux + others
  const candidates: Array<[string, (f: string) => string[]]> = [
    ["ffplay", ffplay.args],
    ["mpv", (f) => ["--no-video", "--really-quiet", f]],
    ["aplay", (f) => [f]],
    ["paplay", (f) => [f]],
    ["mpg123", (f) => ["-q", f]],
  ];
  for (const [bin, mk] of candidates) {
    if (has(bin)) return { cmd: bin, args: mk };
  }
  return null;
}

/** True if `bin` is resolvable on PATH. */
export function onPath(bin: string): boolean {
  const probe =
    process.platform === "win32" ? spawnSync("where", [bin]) : spawnSync("which", [bin]);
  return probe.status === 0;
}

export interface PlayDeps {
  platform?: NodeJS.Platform;
  has?: (bin: string) => boolean;
}

/** Play an audio file best-effort. Returns true if a player was launched, false if none found. Never throws. */
export async function playFile(path: string, deps: PlayDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const has = deps.has ?? onPath;
  const player = pickPlayer(platform, has);
  if (!player) return false;
  await new Promise<void>((resolve) => {
    try {
      const p = spawn(player.cmd, player.args(path), { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
  return true;
}
