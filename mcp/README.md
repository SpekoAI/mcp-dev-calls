# @spekoai/mcp-calls

**Place real, disclosed phone calls to businesses, or let your coding agent call you when it needs a decision.**

> _"call Sakura Sushi and ask if they have a table for 4 at 8pm — my name is John"_
> → the agent dials, opens with _"Hi, this is an AI assistant calling on behalf of John…"_,
> and the `OUTCOME:` (booked / not available) lands back in your terminal.

A [Model Context Protocol](https://modelcontextprotocol.io) server for Claude Code, Claude
Desktop, and any MCP client. Powered by [Speko](https://speko.ai).

## Setup — one command

```bash
npx @spekoai/mcp-calls@latest init
```

The wizard finds every detected supported coding client, signs you in with your browser,
and configures each one — Claude Code, Claude Desktop,
Cursor, Windsurf, VS Code, Gemini CLI, Codex CLI, Cline (Zed gets a paste-ready snippet).
It installs guidance for Claude, Codex, Gemini, Windsurf, Cline, and VS Code; Cursor and Zed get
configuration only. After a successful connection, the optional final step attempts NANP owner
verification for `call_me`; it is enabled only after the OTP succeeds.

Already have a key, or on a headless box? `--token sk_...` supplies it directly and `--paste`
skips browser opening. `--client cursor,codex` forces that explicit list; `all`, the default,
configures all detected clients.
Re-authenticate anytime with `npx @spekoai/mcp-calls login`.

It runs **single-process**: give it your `SPEKO_API_KEY` and it calls `api.speko.dev`
directly — no separate server to run.

<details><summary>Manual / CI setup (any MCP client)</summary>

```bash
# Claude Code
claude mcp add speko-calls --scope user --env SPEKO_API_KEY=sk_... --env SPEKO_CLIENT_PROFILE=claude-code -- npx -y @spekoai/mcp-calls
```

```jsonc
// Example: Cursor. Use its matching profile; Desktop/VS Code/Zed use safe-default.
{ "mcpServers": { "speko-calls": {
  "command": "npx", "args": ["-y", "@spekoai/mcp-calls"],
  "env": { "SPEKO_API_KEY": "sk_...", "SPEKO_CLIENT_PROFILE": "cursor" }
} } }
```

For Cline, use `SPEKO_CLIENT_PROFILE=cline` and add `"timeout": 2700` to the server entry.

```jsonc
// VS Code — .vscode/mcp.json or user mcp.json (note the `servers` root key)
{ "servers": { "speko-calls": {
  "type": "stdio", "command": "npx", "args": ["-y", "@spekoai/mcp-calls"],
  "env": { "SPEKO_API_KEY": "sk_...", "SPEKO_CLIENT_PROFILE": "safe-default" }
} } }
```

```toml
# Codex CLI — ~/.codex/config.toml (or: codex mcp add speko-calls --env SPEKO_API_KEY=sk_... --env SPEKO_CLIENT_PROFILE=codex -- npx -y @spekoai/mcp-calls)
[mcp_servers.speko-calls]
command = "npx"
args = ["-y", "@spekoai/mcp-calls"]
tool_timeout_sec = 2700
[mcp_servers.speko-calls.env]
SPEKO_API_KEY = "sk_..."
SPEKO_CLIENT_PROFILE = "codex"
```

`npx @spekoai/mcp-calls init --print-config` prints all of these with a
`YOUR_SPEKO_API_KEY` placeholder. Replace it only inside your private client config; the wizard
never writes the real key to terminal output.
Get a key at [platform.speko.dev](https://platform.speko.dev). `SPEKO_MCP_SERVER_URL` always
selects remote mode. Put `SPEKO_API_KEY`, lookup credentials, `SPEKO_DIAL_TOKEN_SECRET`, safety
settings, and state directories on that server. The MCP sends its allowlisted client profile and,
when configured, `MCP_INTERNAL_KEY`. Run `speko me` and `speko dnc` on the backing-server host
with `SPEKO_MCP_SERVER_URL` unset; they modify only local host state. Other account/audio CLI
commands still require a local API key. Non-loopback server binding requires `MCP_INTERNAL_KEY`.
The default wizard install is in-process.
</details>

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business(name, location?, phone_number?, utc_offset_minutes?)` | Resolve a business → dialable candidates + a signed `dial_token` per callable one. Pass `phone_number` to skip directory search; it is still carrier-verified as a business line. |
| `make_call(dial_token, objective, caller_name, context?, behavior?, greet_first?, after_hours_confirmation?, max_duration_seconds?)` | Place the disclosed, objective-scoped call; wait for it to finish; return the `OUTCOME` + transcript. Honest `connected`/`answered`/`not_connected`. |
| `call_number(phone_number, objective, caller_name, recipient_name?, context?, behavior?, greet_first?, utc_offset_minutes?, after_hours_confirmation?, max_duration_seconds?)` | Disclosed call to a number you have or found from an official source. Business or personal; mobiles allowed. |
| `call_me(message, mode?, context?, after_hours_confirmation?, max_duration_seconds?, wait?)` | Call this install's locally verified owner; there is no destination input. `notify` delivers a message. `converse` returns the owner's read-back-confirmed reply as explicitly untrusted transcript data. `wait:false` returns a call ID for `get_call` polling. |
| `get_call(call_id)` | Read-only: re-check a call, including a call ID returned by `call_me`. Never dials. |
| `check_call_readiness()` | Read-only preflight: auth, credit balance, outbound caller-ID, owner verification, and client profile. Never dials. |

The wizard installs no Google or Twilio credentials. Name search requires Google Places, and every
real `lookup_business` dial token requires Twilio carrier credentials. `call_number` needs neither.

## Safety

Every call opens with a **non-removable AI disclosure**. `lookup_business` carrier-verifies
business lines before minting a `dial_token`; `call_number` is for numbers the human has consent
to call. Server guardrails include no-sell/no-spam + harassment + impersonation screens,
per-number rate caps, a local do-not-call list (`speko dnc`), and an after-hours confirmation
gate for late or unknown-timezone calls. `make_call` is authorized only by a fresh, short-lived,
signed `dial_token` from `lookup_business` — a raw phone number can never dial.

`call_me` is NANP-only in 0.7.0 and requires `speko me verify`. The local voice OTP is a setup
and consent artifact, not a privileged trust boundary: owner calls still honor DNC, the ordinary
3/hour and 8/day per-number caps, content screens, and the 08:00-21:00 destination-local gate.
`SPEKO_TRUSTED_NUMBERS` never exempts `call_me`; late calls require the human's own words in
`after_hours_confirmation`. A host-local, cross-process lease makes a second live owner call
return `owner_busy` without dialing.

## Hermetic test mode

`SPEKO_TEST_MODE=1` runs every tool as a deterministic in-process simulation — no API key, no
network, no telephony — so any agent platform can exercise all 6 tools offline. Every result
carries `test_mode: true` and simulated transcripts/outcomes are labeled `[SIMULATED]`; all
safety rails still run for real.

- `lookup_business` resolves any name to one candidate — "Test Bistro" at `+15005550001` — with
  a real signed `dial_token`.
- Magic numbers: `+15005550001` connected + answered (with an OUTCOME line); `+15005550002`
  `not_connected` (no answer); `+15005550003` connected but nobody responded; any other number
  behaves like `+15005550001`.
- `call_me` works out of the box against a pre-seeded fixture owner ("Test Owner",
  `+1 500 555 0100`); converse mode returns a deterministic confirmed read-back.
- `SPEKO_FAKE_NOW=<ISO timestamp>` overrides test mode's frozen mid-day clock so the after-hours
  gate can be tested. It is ignored entirely outside test mode.
- Refusal invariant: test mode refuses to start tools if a live-looking `SPEKO_API_KEY` (`sk_*`
  that is not `sk_test_*`) or `SPEKO_MCP_SERVER_URL` is configured — one process can simulate
  calls or place real ones, never both.

## CLI

Beyond the MCP server, `speko` is also a terminal CLI — run it with a subcommand:

```bash
speko audio speak "<text>"        # text-to-speech (stdin/pipe ok; -o file, --format wav|mp3)
speko me verify | status          # verify or inspect the local call_me owner
speko audio transcribe <file|->   # speech-to-text
speko voices [--provider <p>]     # list the voices the router can pick
speko usage                       # account usage this period: sessions, minutes, spend, balance
speko credits [--ledger]          # prepaid balance (+ recent credit movements)
speko call report <id>            # a finished call's outcome, cost + cost breakdown
speko call events <id>            # timeline / "speech diagram" of the call
speko call transcript <id>        # the transcript, one line per turn
speko dnc list | add <e164> | remove <e164>   # local do-not-call ledger
```

`status`/`whoami`, `audio speak|transcribe`, `voices`/`models`, `usage`, `credits`, and `call *`
accept `--json`. `speko` in a terminal prints this list; piped (no subcommand) it runs as the MCP
server. See [AGENTS.md](https://github.com/SpekoAI/mcp-dev-calls/blob/main/AGENTS.md)
for the full agent-oriented guide.

## Links

- Dashboard / API keys — [platform.speko.dev](https://platform.speko.dev)
- Source & issues — [github.com/SpekoAI/mcp-dev-calls](https://github.com/SpekoAI/mcp-dev-calls)

MIT © SpekoAI
