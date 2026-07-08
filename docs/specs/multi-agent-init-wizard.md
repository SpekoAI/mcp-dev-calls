# Multi-agent `init` wizard — design + parity guarantee

**Status:** implemented (adapters, selection, tests, docs — feat/multi-agent-init; `speko doctor`
+ dry-run E2E harness from §6 remain follow-ups)  ·  **Date:** 2026-07-08  ·  **Owner:** Amir (DX)
**Scope:** extend `npx @spekoai/mcp-calls init` to detect every MCP-capable coding agent on the
machine and register the server into each one's config — *without* changing the current Claude
Code / Claude Desktop behavior, and with a strategy to guarantee it behaves the same everywhere.

---

## 1. Goal + the mental-model fix

One command detects the coding agents the user has installed and wires the Speko Calls MCP into
each. **It is not "download the server per agent."** There is one npm package; every agent's
config just points at the same `npx -y @spekoai/mcp-calls` stdio command, and npx fetches/caches
it once. So the wizard's job is: **detect installed agents → write each agent's config in its own
schema → verify.** No per-agent binaries.

## 2. Current state (what we keep, untouched)

`mcp/src/cli/init.ts` today: Claude Code (`claude mcp add`, idempotent remove→add) + Claude
Desktop (safe read-merge-backup-write). `--client code|desktop|both`. **Zero external deps**
(Node builtins only). Installs the companion **Skill** to `~/.claude/skills` (Claude-only). Writes
`{command:"npx",args:["-y","@spekoai/mcp-calls"],env:{SPEKO_API_KEY}}`. We also ship
`mcp/server.json` (MCP **registry** manifest) → registry-aware clients can install with no
file-editing at all.

## 3. Agent config matrix (verified current, 2026-07; re-verify paths at build time — they drift)

| agent | config path | root key | format | CLI helper |
|---|---|---|---|---|
| Claude Code | `claude mcp add` / `~/.claude.json` / `.mcp.json` | `mcpServers` | JSON | ✅ (done) |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | JSON | (done) |
| Cursor | `~/.cursor/mcp.json` · `.cursor/mcp.json` | `mcpServers` | JSON | — |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | JSON | — |
| Gemini CLI | `~/.gemini/settings.json` · `.gemini/` | `mcpServers` | JSON | ✅ `gemini mcp add` |
| VS Code (Copilot) | `.vscode/mcp.json` · settings `"mcp"` | **`servers`** + `type:"stdio"` | JSON | ✅ `code --add-mcp` |
| Codex CLI | `~/.codex/config.toml` · `.codex/` (trusted only) | **`[mcp_servers.<name>]`** | **TOML** | ✅ `codex mcp add` |
| Zed | `~/.config/zed/settings.json` | **`context_servers`** (nested `command:{path,args,env}`) | JSON | — |
| Cline | VS Code `globalStorage/saoudrizwan.claude-dev/.../cline_mcp_settings.json` | `mcpServers` (+`disabled`/`autoApprove`) | JSON | `cline config mcp` |

Three schema families: standard `mcpServers` JSON (Cursor/Windsurf/Gemini/Cline — reuse the
Desktop merge), VS Code `servers`+`type`, Zed `context_servers` (nested), Codex TOML.
`.codex/config.toml` already exists in this repo → Codex is a confirmed target.

## 4. Architecture — additive adapter registry

```ts
interface AgentTarget {
  id: string; label: string;
  detect(): boolean;            // config dir / CLI present?
  write(key: string): { ok: boolean; detail: string };  // idempotent merge in that agent's schema
  manualHint(key: string): string;                       // fallback line if write fails
  restartHint(): string;        // per-agent "reload to pick it up"
}
```

- **Keep `configureClaudeCode` / `configureClaudeDesktop` exactly as-is** (proven, launched) —
  just enroll them as two adapters. New adapters are isolated → zero risk to the Claude path.
- Loop: `detect all → show what was found → write each in its own try/catch` (one failure never
  aborts the rest) → per-agent summary.
- **Prefer CLI helpers** where they exist (`codex mcp add`, `gemini mcp add`, `code --add-mcp`) —
  they get format + precedence right; same pattern we already trust for `claude mcp add`.
  File-merge only where there's no CLI.
- `--client` extends: `all` (new default = detect+write everything found) + comma list
  (`cursor,codex`); keep `code|desktop|both` for back-compat.
- Safeguards (already done for Desktop): read-merge-write, back up first, never clobber other
  servers, validate before write, `--print-config`/dry-run, fully re-runnable.
- **Zero-dep constraint:** Codex TOML is trivial — hand-roll the emitter or shell to `codex mcp
  add`; do not pull a TOML dependency.

**Phasing:** Phase 1 = standard-`mcpServers` set (Cursor, Windsurf, Gemini) + VS Code via
`code --add-mcp` (most of the market, low divergence). Phase 2 = special cases (Codex TOML, Zed
nested, Cline globalStorage).

## 5. "Same behavior?" — the four layers

| layer | same everywhere? | why |
|---|---|---|
| Protocol / the 6 tools | ✅ identical | one stdio server; same tools/list, schemas, env passing; stdout-reserved invariant (`router.ts`) |
| Config format | ⚠️ per-adapter | 4 formats; solvable, it's the bulk of the work |
| Agent guidance (Skill) | ❌ Claude-only | `SKILL.md` → `~/.claude/skills` only; others have no "skills" |
| Model reasoning driving the flow | ⚠️ varies | `make_call` is multi-step + safety-sensitive; weaker agents may fumble sequencing |

**The load-bearing point:** capability parity is *structural*, because there is **one server
binary**. You do not test N servers — you test **1 server + N thin config-writers**. The only
things that can differ per agent are (a) was the config written correctly, (b) did the agent
successfully spawn the one server, (c) how well the model drives it, (d) is guidance present.
(a)/(b)/(d) are fully automatable; (c) is model-inherent and **backstopped by server-side safety**
(disclosure baked into the opener, dial-token HMAC, DNC, rate caps, after-hours gate) — so a
weaker agent can produce a clumsy UX but **never an unsafe/undisclosed call**.

## 6. Conformance & parity strategy (how we guarantee "works the same")

**Anti-drift single source of truth.** Define the logical server invocation once —
`{ command:"npx", args:["-y","@spekoai/mcp-calls"], env:{SPEKO_API_KEY} }` — and the tool set once.
Every adapter *derives* its file from this constant; none hand-writes command/args. A test asserts
every adapter emits the same logical (command,args,env) triple, differing only in syntax. This
makes it impossible to give one agent different args or a different tool surface.

**Test pyramid:**

1. **Adapter unit tests (CI, deterministic) — per agent:**
   - writes into a fixture config → assert exact resulting file (correct schema: `mcpServers` vs
     `servers`+`type` vs `context_servers` vs TOML table).
   - **idempotency:** write twice → identical result (no dupes).
   - **merge safety:** pre-existing unrelated servers/keys preserved; backup created.
   - **malformed input:** invalid JSON/TOML left untouched, clear error, non-zero.
   - **detect():** true only when that agent's marker exists; false otherwise.

2. **Handshake smoke test (CI) — reused across all spawn configs:** take each adapter's written
   `(command,args,env)`, spawn it, assert MCP `initialize` + `tools/list` returns the **same 6
   tools with identical input schemas** (snapshot/golden). Because it's one binary this is
   inherently equal — the test proves each spawn *style* actually boots it (catches env/stdin
   issues like Gemini's env sanitization).

3. **Tool-contract snapshot (CI):** freeze the 6 tool names + input schemas. Any change fails
   until the snapshot is updated → all agents change together, never one-off.

4. **`speko doctor` / `speko init --check` (on-demand, ships to users):** for every *detected*
   agent, verify config present + valid + points at the current command; optionally do a live
   `initialize` handshake and a `check_call_readiness` (auth/env passing). This is the answer to
   "is it working the same everywhere right now?" — runnable any time, not just at build.

5. **Live dry-run E2E conformance harness (scriptable CLI agents only):** add a `SPEKO_DRY_RUN`
   that returns a canned `OUTCOME` with no real call/charge. Drive Claude Code, Codex CLI, Gemini
   CLI with the same transcript ("call <fixture> and ask X") and assert: (i) `lookup_business`
   then `make_call` in order, (ii) disclosure present, (iii) `OUTCOME` surfaced. GUI agents
   (Cursor/Windsurf/VS Code/Cline/Zed) can't be driven headlessly → **manual QA checklist** per
   release.

6. **Guidance parity:** port `SKILL.md` content into each agent's convention (`AGENTS.md` /
   `.cursor/rules` / Codex project doc); test the artifact is installed. Model behavior itself
   isn't CI-testable — the harness (5) is the proxy.

7. **Support matrix doc:** per agent, publish {tested client version, parity level}: **Full**
   (config + guidance + E2E), **Config-only** (config + handshake, manual behavior), **Manual**
   (documented steps). Sets honest expectations for the "works with every agent" claim.

## 7. Parity threats & defenses (the failure modes to design against)

| threat | symptom (per-agent) | defense |
|---|---|---|
| Gemini env sanitization redacts `SPEKO_API_KEY` | auth fails only on Gemini | `mcp.allowed`/`$VAR` handling; doctor env check (6.4) |
| npx cold-start > client init timeout | "server failed to start" on first run only | per-agent timeout knob (Codex `startup_timeout_sec`, `MCP_TIMEOUT`); lighter cold-start |
| Cline needs the VS Code extension, not just VS Code | writes config that never loads | detect `saoudrizwan.claude-dev` globalStorage, not VS Code |
| Codex project config loads only for *trusted* projects | pin ignored | target global `~/.codex/config.toml` |
| client negotiates older MCP protocol | subtle tool behavior diff | declare min protocol; test against supported client versions |
| large tool results truncated differently | transcript render varies | keep results compact (known concern) |
| `call_me` throws; no Skill on non-Claude to explain | worse trap surface | hide `call_me` until v2 (already recommended) |
| version drift (`npx` unpinned = latest) | parity by construction, but a bad publish breaks all agents at once | keep unpinned for parity; rely on release gating + doctor |

## 8. Open questions

- Default UX: auto-write all detected (doctrine: minimal work) vs list-and-confirm (less intrusive)?
- Guidance: install AGENTS.md-style rules per agent (more setup) vs rely on rich tool descriptions?
- Secret sprawl: key now in N plaintext configs — acceptable, or offer a keychain/`SPEKO_MCP_SERVER_URL` hosted path?

## 9. Launch-copy guidance

Claim **capability + safety parity**, not identical model behavior:
> "Works with every MCP-capable coding agent — Claude Code/Desktop, Cursor, Windsurf, VS Code,
> Codex, Gemini, Cline, Zed. Same tools, same server-enforced safety everywhere."

Do **not** claim identical behavior on every model; the guided experience is richest on Claude
today and AGENTS.md closes the gap.

---

_See also: `AGENTS.md` (cross-agent guide), `mcp/server.json` (registry manifest),
`mcp/src/cli/init.ts` (current wizard)._
