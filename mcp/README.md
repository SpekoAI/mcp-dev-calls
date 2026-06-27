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

The wizard signs you in **with your browser** (OAuth — no key to copy or paste), fetches your
key automatically, writes the MCP into your client config (Claude Code or Claude Desktop), and
installs a companion skill. Then just ask your agent to call a business.

Already have a key, or on a headless box? `--token sk_...` or `--paste` skips the browser.
Re-authenticate anytime with `npx @spekoai/mcp-calls login`.

It runs **single-process**: give it your `SPEKO_API_KEY` and it calls `api.speko.dev`
directly — no separate server to run.

<details><summary>Manual / CI setup</summary>

```bash
# Claude Code
claude mcp add speko-calls --scope user --env SPEKO_API_KEY=sk_... -- npx -y @spekoai/mcp-calls
```
```jsonc
// Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "speko-calls": {
  "command": "npx", "args": ["-y", "@spekoai/mcp-calls"], "env": { "SPEKO_API_KEY": "sk_..." }
} } }
```
Get a key at [platform.speko.dev](https://platform.speko.dev). To route through a hosted
backing server instead of running in-process, set `SPEKO_MCP_SERVER_URL`.
</details>

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business(name, location?, phone_number?)` | Resolve a business → dialable candidates + a signed `dial_token` per callable one (the only path that can authorize a call). Pass `phone_number` (E.164 — e.g. found via the agent's web search) to skip the directory lookup; still carrier-verified as a business line. |
| `make_call(dial_token, objective, caller_name, context?)` | Place the disclosed, objective-scoped call; wait for it to finish; return the `OUTCOME` + transcript. Honest `connected`/`answered`/`not_connected`. |
| `call_number(phone_number, objective, caller_name)` | Disclosed PERSONAL call to a specific number (e.g. a friend) — mobiles allowed. On by default (set `SPEKO_ALLOW_DIRECT_DIAL=0` to restrict to business lines). |
| `get_call(call_id)` | Read-only: re-check a call's status, `OUTCOME`, and transcript. Never dials. |
| `check_call_readiness()` | Read-only preflight: auth, credit balance, outbound caller-ID. Never dials. |

## Safety

Every call opens with a **non-removable AI disclosure**. **Business lines only** (carrier
line-type check). **Transactional objectives only** — selling, promotion, surveys,
fundraising, and campaigning are refused. **Quiet hours** 08:00–21:00 in the destination's
local time. `make_call` is authorized only by a fresh, single-use, signed `dial_token` from
`lookup_business` — a raw phone number can never dial.

## Links

- Dashboard / API keys — [platform.speko.dev](https://platform.speko.dev)
- Source & issues — [github.com/SpekoAI/mcp-dev-calls](https://github.com/SpekoAI/mcp-dev-calls)

MIT © SpekoAI
