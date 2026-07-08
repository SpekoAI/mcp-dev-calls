# @spekoai/mcp-calls

**Place real, _disclosed_ phone calls to businesses — straight from your coding agent.**

> _"call Sakura Sushi and ask if they have a table for 4 at 8pm — my name is John"_
> → the agent dials, opens with _"Hi, this is an AI assistant calling on behalf of John…"_,
> and the `OUTCOME:` (booked / not available) lands back in your terminal.

A [Model Context Protocol](https://modelcontextprotocol.io) server for Claude Code, Claude
Desktop, and any MCP client. Powered by [Speko](https://speko.ai).

## Setup — one command

```bash
npx @spekoai/mcp-calls@latest init
```

The wizard finds **every coding agent on your machine**, signs you in **with your browser**
(OAuth — no key to copy or paste), and configures each one — Claude Code, Claude Desktop,
Cursor, Windsurf, VS Code, Gemini CLI, Codex CLI, Cline (Zed gets a paste-ready snippet).
Each agent also gets the calling guide in its own rules convention (Claude skill, Codex/Gemini/
Windsurf rules files, Cline rules, VS Code instructions). Then just ask your agent to call a
business. Same tools, same server-enforced safety rails, whichever agent you use.

Already have a key, or on a headless box? `--token sk_...` or `--paste` skips the browser.
`--client cursor,codex` (or `all`, the default) picks which agents to configure.
Re-authenticate anytime with `npx @spekoai/mcp-calls login`.

It runs **single-process**: give it your `SPEKO_API_KEY` and it calls `api.speko.dev`
directly — no separate server to run.

<details><summary>Manual / CI setup (any MCP client)</summary>

```bash
# Claude Code
claude mcp add speko-calls --scope user --env SPEKO_API_KEY=sk_... -- npx -y @spekoai/mcp-calls
```
```jsonc
// Claude Desktop / Cursor / Windsurf / Gemini CLI / Cline — the standard mcpServers shape
{ "mcpServers": { "speko-calls": {
  "command": "npx", "args": ["-y", "@spekoai/mcp-calls"], "env": { "SPEKO_API_KEY": "sk_..." }
} } }
```
```jsonc
// VS Code — .vscode/mcp.json or user mcp.json (note the `servers` root key)
{ "servers": { "speko-calls": {
  "type": "stdio", "command": "npx", "args": ["-y", "@spekoai/mcp-calls"], "env": { "SPEKO_API_KEY": "sk_..." }
} } }
```
```toml
# Codex CLI — ~/.codex/config.toml (or: codex mcp add speko-calls --env SPEKO_API_KEY=sk_... -- npx -y @spekoai/mcp-calls)
[mcp_servers.speko-calls]
command = "npx"
args = ["-y", "@spekoai/mcp-calls"]
[mcp_servers.speko-calls.env]
SPEKO_API_KEY = "sk_..."
```
`npx @spekoai/mcp-calls init --print-config` prints all of these with your key filled in.
Get a key at [platform.speko.dev](https://platform.speko.dev). To route through a hosted
backing server instead of running in-process, set `SPEKO_MCP_SERVER_URL`.
</details>

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business(name, location?, phone_number?)` | Resolve a business → dialable candidates + a signed `dial_token` per callable one (the only path that can authorize a call). Pass `phone_number` (E.164 — e.g. found via the agent's web search) to skip the directory lookup; still carrier-verified as a business line. |
| `make_call(dial_token, objective, caller_name, context?)` | Place the disclosed, objective-scoped call; wait for it to finish; return the `OUTCOME` + transcript. Honest `connected`/`answered`/`not_connected`. |
| `call_number(phone_number, objective, caller_name)` | Disclosed call to a number you have or found via web search (business or personal) — the default path once you have the number. Mobiles allowed. On by default (`SPEKO_ALLOW_DIRECT_DIAL=0` restricts to business lines). |
| `get_call(call_id)` | Read-only: re-check a call's status, `OUTCOME`, and transcript. Never dials. |
| `check_call_readiness()` | Read-only preflight: auth, credit balance, outbound caller-ID. Never dials. |

## Safety

Every call opens with a **non-removable AI disclosure**. `lookup_business` carrier-verifies
business lines before minting a `dial_token`; `call_number` is for numbers the human has consent
to call. Server guardrails include no-sell/no-spam + harassment + impersonation screens,
per-number rate caps, a local do-not-call list (`speko dnc`), and an after-hours confirmation
gate for late or unknown-timezone calls. `make_call` is authorized only by a fresh, short-lived,
signed `dial_token` from `lookup_business` — a raw phone number can never dial.

## CLI

Beyond the MCP server, `speko` is also a terminal CLI — run it with a subcommand:

```bash
speko audio speak "<text>"        # text-to-speech (stdin/pipe ok; -o file, --format wav|mp3)
speko audio transcribe <file|->   # speech-to-text
speko voices [--provider <p>]     # list the voices the router can pick
speko usage                       # account usage this period: sessions, minutes, spend, balance
speko credits [--ledger]          # prepaid balance (+ recent credit movements)
speko call report <id>            # a finished call's outcome, cost + cost breakdown
speko call events <id>            # timeline / "speech diagram" of the call
speko call transcript <id>        # the transcript, one line per turn
speko dnc list | add <e164> | remove <e164>   # local do-not-call ledger
```

All commands accept `--json`. `speko` in a terminal prints this list; piped (no subcommand) it
runs as the MCP server. See [AGENTS.md](https://github.com/SpekoAI/mcp-dev-calls/blob/main/AGENTS.md)
for the full agent-oriented guide.

## Links

- Dashboard / API keys — [platform.speko.dev](https://platform.speko.dev)
- Source & issues — [github.com/SpekoAI/mcp-dev-calls](https://github.com/SpekoAI/mcp-dev-calls)

MIT © SpekoAI
