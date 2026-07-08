/**
 * `npx @spekoai/mcp-calls init` — the one-command onboarding wizard.
 *
 * Flow: consent → get a Speko API key (flag / env / browser OAuth / masked paste)
 * → verify it against api.speko.dev → write the MCP into EVERY detected coding
 * agent's config (Claude Code/Desktop via the proven writers below; Cursor,
 * Windsurf, VS Code, Gemini CLI, Codex CLI, Cline via cli/targets adapters; Zed
 * gets a printed snippet) → install the companion Agent Skill for Claude →
 * print next steps. `--client all|both|<a,b,…>` narrows or forces the set.
 *
 * Zero extra deps (Node readline / child_process / fs). Runs only when the bin is
 * invoked with `init|setup|login`; the default no-arg invocation stays the stdio server.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLogin, NoOrgError } from "./login.js";
import { ALL_TARGETS, TARGET_LABELS, realCtx, resolveSelection } from "./targets/index.js";
import { PKG, SERVER_NAME, serverEntry } from "./targets/invocation.js";
import { codexTomlBlock } from "./targets/codex.js";

const API_BASE = (process.env.SPEKOAI_API_URL || "https://api.speko.dev").replace(/\/+$/, "");
const DASHBOARD = "https://platform.speko.dev";

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Flags {
  token?: string;
  client?: string; // all (default) | both | comma list of: code,desktop,cursor,windsurf,vscode,gemini,codex,cline,zed
  scope: string; // user | project | local
  yes: boolean;
  printConfig: boolean;
  paste: boolean; // force manual key entry, skip browser login
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { scope: "user", yes: false, printConfig: false, paste: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") f.token = argv[++i];
    else if (a === "--client") f.client = argv[++i];
    else if (a === "--scope") f.scope = argv[++i] ?? "user";
    else if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--print-config") f.printConfig = true;
    else if (a === "--paste" || a === "--manual") f.paste = true;
  }
  return f;
}

function ask(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(query, (a) => { rl.close(); res(a.trim()); }));
}

/** Masked secret entry. Raw-mode echo of '*'; falls back to a plain line on non-TTY. */
function askSecret(query: string): Promise<string> {
  return new Promise((resolve_, reject) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      rl.question("", (a) => { rl.close(); resolve_(a.trim()); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const done = (cancel: boolean) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (cancel) reject(new Error("cancelled")); else resolve_(buf.trim());
    };
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") done(false);
      else if (ch === "\u0003") done(true);
      else if (ch === "\u007f" || ch === "\b") { if (buf) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } }
      else { buf += ch; process.stdout.write("*"); }
    };
    stdin.on("data", onData);
  });
}

function openBrowser(url: string): void {
  try {
    const p = platform();
    const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
    const args = p === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* fall back to the printed URL */
  }
}

async function verifyKey(key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${API_BASE}/v1/organization`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return { ok: true, detail: "" };
    if (r.status === 401 || r.status === 403) return { ok: false, detail: "key rejected (401/403) — check you copied the whole key" };
    return { ok: false, detail: `unexpected HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

function claudeCliPresent(): boolean {
  try {
    return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function desktopConfigPath(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Add to Claude Code via its CLI. Returns true on success; prints the manual command otherwise. */
function configureClaudeCode(key: string, scope: string): boolean {
  const envArgs = ["--env", `SPEKO_API_KEY=${key}`];
  const manual = `claude mcp add ${SERVER_NAME} --scope ${scope} --env SPEKO_API_KEY=<your-key> -- npx -y ${PKG}`;
  if (!claudeCliPresent()) {
    console.log(c.yellow("  • Claude Code CLI not found on PATH. Run this yourself once installed:"));
    console.log("    " + c.cyan(manual));
    return false;
  }
  // Idempotent: drop any existing entry first, then add.
  spawnSync("claude", ["mcp", "remove", SERVER_NAME, "--scope", scope], { stdio: "ignore" });
  const r = spawnSync(
    "claude",
    ["mcp", "add", SERVER_NAME, "--scope", scope, ...envArgs, "--", "npx", "-y", PKG],
    { stdio: "inherit" },
  );
  if (r.status === 0) {
    console.log(c.green(`  ✓ Added to Claude Code (scope: ${scope}).`));
    return true;
  }
  console.log(c.yellow("  • Couldn't add automatically. Run this yourself:"));
  console.log("    " + c.cyan(manual));
  return false;
}

/** Safe read-merge-write of Claude Desktop's JSON (backs up first; never blind-appends). */
function configureClaudeDesktop(key: string): boolean {
  const path = desktopConfigPath();
  try {
    let cfg: Record<string, unknown> = {};
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      try {
        cfg = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        console.log(c.red(`  ✗ ${path} is not valid JSON — leaving it untouched. Fix it, then re-run.`));
        return false;
      }
      writeFileSync(`${path}.speko-backup`, raw);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}) as Record<string, unknown>;
    servers[SERVER_NAME] = serverEntry(key);
    cfg.mcpServers = servers;
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    console.log(c.green(`  ✓ Updated Claude Desktop config (${path}).`));
    console.log(c.dim("    Fully quit (Cmd/Ctrl+Q) and reopen Claude Desktop for it to load."));
    return true;
  } catch (e) {
    console.log(c.red(`  ✗ Couldn't write Claude Desktop config: ${(e as Error).message}`));
    return false;
  }
}

/** Copy the bundled SKILL.md into ~/.claude/skills/speko-calls so the agent gets the playbook. */
function installSkill(): boolean {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // The package ships skills/ as a sibling of dist/. From the bundled dist/index.js the
    // skill is one level up; the two-levels-up path covers a non-bundled dev (dist/cli) layout.
    const src = [
      resolve(here, "..", "skills", SERVER_NAME, "SKILL.md"),
      resolve(here, "..", "..", "skills", SERVER_NAME, "SKILL.md"),
    ].find((p) => existsSync(p));
    if (!src) {
      console.log(c.yellow("  • Bundled skill not found in package; skipping skill install."));
      return false;
    }
    const destDir = join(homedir(), ".claude", "skills", SERVER_NAME);
    const skillsRootExisted = existsSync(join(homedir(), ".claude", "skills"));
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, join(destDir, "SKILL.md"));
    console.log(c.green(`  ✓ Installed the ${SERVER_NAME} skill → ${destDir}`));
    if (!skillsRootExisted) {
      console.log(c.dim("    (New skills directory — restart Claude Code once so it picks the skill up.)"));
    }
    return true;
  } catch (e) {
    console.log(c.yellow(`  • Couldn't install the skill: ${(e as Error).message}`));
    return false;
  }
}

/** Manual config for every supported agent — used by --print-config and the zero-detected fallback. */
function printManualConfigs(key: string, scope: string): void {
  console.log("\n  Claude Code:");
  console.log("    " + c.cyan(`claude mcp add ${SERVER_NAME} --scope ${scope} --env SPEKO_API_KEY=${key} -- npx -y ${PKG}`));
  console.log("\n  Claude Desktop / Cursor / Windsurf / Gemini CLI / Cline (mcpServers entry):");
  console.log("    " + c.cyan(JSON.stringify({ [SERVER_NAME]: serverEntry(key) })));
  console.log("\n  VS Code (user mcp.json or .vscode/mcp.json — note the `servers` root key):");
  console.log("    " + c.cyan(JSON.stringify({ servers: { [SERVER_NAME]: { type: "stdio", ...serverEntry(key) } } })));
  console.log("\n  Codex CLI (~/.codex/config.toml):");
  console.log(c.cyan(codexTomlBlock(key).replace(/^/gm, "    ")));
  console.log("\n  Zed (settings.json → context_servers):");
  console.log(
    "    " +
      c.cyan(
        JSON.stringify({ context_servers: { [SERVER_NAME]: { command: { path: "npx", args: ["-y", PKG], env: { SPEKO_API_KEY: key } } } } }),
      ),
  );
  console.log("");
}

export async function runInit(argv: string[], mode: "init" | "setup" | "login" = "init"): Promise<void> {
  const f = parseFlags(argv);
  const quick = mode === "login"; // `login` = focused re-auth: skip intro + demo prompts
  console.log(c.bold(quick ? "\n  Speko Calls — sign in\n" : "\n  Speko Calls — setup\n"));
  if (!quick) {
    console.log("  This MCP places " + c.bold("real, disclosed") + " outbound phone calls to " + c.bold("businesses") + ",");
    console.log("  straight from your coding agent. Every call opens with an AI disclosure;");
    console.log(
      "  business lines only for make_call; abuse guardrails: no-sell/harassment/impersonation screens, " +
        "per-number rate caps, local do-not-call list (speko dnc), after-hours calls need your explicit confirmation.\n",
    );
  }

  // 1) Detect coding agents FIRST, so the user sees what will be configured
  //    before their browser opens. --client all|both|<comma list> narrows or
  //    forces (forced = write even if undetected).
  const ctx = realCtx();
  const detectedIds = [
    ...(claudeCliPresent() ? ["code"] : []),
    ...(existsSync(desktopConfigPath()) || existsSync(dirname(desktopConfigPath())) ? ["desktop"] : []),
    ...ALL_TARGETS.filter((t) => t.detect(ctx)).map((t) => t.id),
  ];
  const sel = resolveSelection(f.client, detectedIds);
  for (const bad of sel.invalid) {
    console.log(c.yellow(`  • Unknown --client '${bad}'. Valid: ${Object.keys(TARGET_LABELS).join(", ")}.`));
  }
  if (sel.invalid.length > 0 && sel.ids.length === 0) {
    console.log(c.red("\n  Nothing to configure — no valid --client values.\n"));
    return;
  }
  if (sel.ids.length > 0) {
    console.log("  Found: " + c.bold(sel.ids.map((id) => TARGET_LABELS[id]).join(", ")));
  } else if (!f.printConfig) {
    console.log(c.yellow("  • No coding agents detected — after sign-in you'll get manual config for every agent."));
  }

  // 2) Get a key: flag > env > browser login (default) > manual paste (fallback).
  let key = (f.token ?? process.env.SPEKO_API_KEY ?? "").trim();
  if (!key && !f.paste) {
    console.log("\n  Sign in to connect — this opens your browser. " + c.dim("No key to copy or paste."));
    try {
      key = await browserLogin((m) => console.log(c.dim("  " + m)));
      console.log(c.green("  ✓ Signed in — fetched your API key automatically."));
    } catch (e) {
      if (e instanceof NoOrgError) {
        // Signed in fine, but the workspace still wasn't ready after the wait. Pasting
        // a key can't help (there isn't one yet) — so guide, don't dead-end.
        console.log(c.yellow(`\n  • Your Speko workspace isn't set up yet.`));
        console.log(`  Finish creating it at ${c.cyan(DASHBOARD)}, then re-run ${c.cyan("npx @spekoai/mcp-calls init")}.\n`);
        return;
      }
      console.log(c.yellow(`  • Browser sign-in didn't complete (${(e as Error).message}).`));
      console.log("  Falling back to manual key entry. " + c.dim("(Use --paste to skip the browser next time.)"));
    }
  }
  if (!key) {
    console.log(`\n  Opening ${c.cyan(DASHBOARD)} — sign in and create an API key (starts with "sk_").`);
    console.log(c.dim(`  (If it doesn't open: visit ${DASHBOARD} and copy your key.)\n`));
    if (!f.yes) await ask("  Press Enter to open your browser… ");
    openBrowser(DASHBOARD);
    key = await askSecret("  Paste your Speko API key: ");
  }
  if (!key) {
    console.log(c.red("\n  No key provided. Re-run when you have one.\n"));
    return;
  }
  if (!/^(Bearer\s+)?sk_/.test(key)) {
    console.log(c.yellow("  • That doesn't look like an sk_… key, but I'll verify it anyway."));
  }
  key = key.replace(/^Bearer\s+/, "");

  // 3) Verify.
  process.stdout.write("\n  Verifying key… ");
  const v = await verifyKey(key);
  if (!v.ok) {
    console.log(c.red(`failed (${v.detail}).`));
    console.log("  Double-check the key at " + c.cyan(DASHBOARD) + " and re-run.\n");
    return;
  }
  console.log(c.green("ok ✓"));

  if (f.printConfig) {
    printManualConfigs(key, f.scope);
    return;
  }

  // 4) Write config + guidance into each — one agent failing never stops the rest.
  console.log("");
  if (sel.ids.length === 0) {
    console.log(c.yellow("  • No coding agents detected — manual setup below (or force one with --client <name>):"));
    printManualConfigs(key, f.scope);
    return;
  }
  for (const id of sel.ids) {
    if (id === "code") {
      configureClaudeCode(key, f.scope);
      continue;
    }
    if (id === "desktop") {
      configureClaudeDesktop(key);
      continue;
    }
    const t = ALL_TARGETS.find((x) => x.id === id);
    if (!t) continue;
    try {
      const r = t.write(key, ctx);
      if (r.ok) {
        console.log(c.green(`  ✓ ${t.label}`) + c.dim(` — ${r.detail}`));
        if (t.installGuidance) {
          const g = t.installGuidance(ctx);
          console.log(g.ok ? c.dim(`    ✓ calling guide → ${g.detail}`) : c.yellow(`    • guide skipped: ${g.detail}`));
        }
        if (r.restartHint) console.log(c.dim(`    ${r.restartHint}`));
      } else {
        console.log(c.yellow(`  • ${t.label}: ${r.detail}`));
      }
      if (r.manual) console.log(c.cyan(r.manual.replace(/^/gm, "    ")));
    } catch (e) {
      console.log(c.yellow(`  • ${t.label}: ${(e as Error).message}`));
    }
  }
  const notSelected = Object.keys(TARGET_LABELS).filter((id) => !sel.ids.includes(id));
  if (!sel.forced && notSelected.length > 0) {
    console.log(c.dim(`  Not found (skipped): ${notSelected.map((id) => TARGET_LABELS[id]).join(", ")} — force with --client <name>.`));
  }

  // 5) The full Claude skill (other agents got the calling card in their own rules convention above).
  if (sel.ids.includes("code") || sel.ids.includes("desktop")) installSkill();

  // 6) Next steps.
  console.log(c.bold("\n  ✅ Done.\n"));
  console.log("  Try it: open your agent and say");
  console.log("    " + c.cyan('"call <a business> and ask if they have a table for 4 at 8pm — my name is <you>"'));
  console.log(c.dim("\n  First run downloads the package — if the agent reports an MCP startup timeout,"));
  console.log(c.dim("  set MCP_TIMEOUT=60000 and retry. Re-run this wizard anytime to reconfigure.\n"));
}
