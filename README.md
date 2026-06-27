# Speko Calls — "AI calls for devs" MCP demo

**Find a business and place a real, _disclosed_ phone call to it — straight from your coding agent.**

> _"call Sakura Sushi and ask if they have a table for 4 at 8pm"_
> → `"Hi, this is an AI assistant calling on behalf of John…"`
> → `OUTCOME: table for 4 at 8pm, booked under John` — back in your terminal.

This repo is a **demo**. It shows how a developer can wire a Claude Code MCP to Speko's
calling platform: get an API key from [platform.speko.dev](https://platform.speko.dev),
bring your own business-lookup (Google Places), and let Speko place the call.

---

## What it showcases

1. **Get a key, make a call.** `SPEKO_API_KEY` from [platform.speko.dev](https://platform.speko.dev) → real outbound calls via the official [`@spekoai/sdk`](https://www.npmjs.com/package/@spekoai/sdk).
2. **Bring-your-own lookup.** The Google business lookup lives **in this demo's own server**, *not* baked into `api.speko.dev`. Speko's API stays focused on calling; discovery is the app's concern.
3. **Safety as the product.** A non-removable AI disclosure, business-lines-only carrier checks, a transactional-objective screen, quiet hours, and signed dial tokens — all enforced **server-side**, where they can't be patched around.
4. **Two clean tiers.** A thin, secret-free MCP ([`mcp-framework`](https://mcp-framework.com)) over a backing API that holds the keys.

---

## Architecture

```
┌─────────────┐   MCP (stdio)    ┌──────────────────────┐   HTTP (+SPEKO_API_KEY)   ┌──────────────────┐
│ Claude Code │ ───────────────▶ │  mcp/   (no secrets) │ ────────────────────────▶ │  api.speko.dev   │
│  (you)      │  lookup/make/    │  mcp-framework tools │   via @spekoai/sdk        │  dial · poll ·   │
└─────────────┘  readiness       └──────────┬───────────┘                           │  transcript      │
                                            │ HTTP                                  └──────────────────┘
                                            ▼
                                 ┌──────────────────────────────────────────┐
                                 │  server/  (the backing API — holds keys)  │
                                 │  • Google Places business lookup          │
                                 │  • Twilio carrier line-type check         │
                                 │  • signed HMAC dial tokens                │
                                 │  • disclosure + objective + quiet-hours   │
                                 └──────────────────────────────────────────┘
```

- **`mcp/`** — the MCP server Claude Code talks to. Built on **mcp-framework**. Holds **no secrets**; every tool just calls `server/` over HTTP.
- **`server/`** — a small Express API. Holds `SPEKO_API_KEY`, the Google Places / Twilio keys, and the dial-token secret. Runs the lookup, enforces every safety rail, and dials through `@spekoai/sdk`.

Why split it? Two reasons: secrets and rails **must** live somewhere trusted (you can't ship keys in an `npx` package), and per the demo's design the Google lookup stays **out of** `api.speko.dev` — it belongs to the app.

---

## Quickstart

```bash
# one command: sign in with your browser (no key to copy/paste), then it writes the MCP
# into your Claude Code / Claude Desktop config and installs the companion skill.
npx @spekoai/mcp-calls@latest init
```

`init` signs you in via your browser and fetches your key automatically — nothing to paste.
Already have a key, or on a headless box? `--token sk_...` or `--paste` skips the browser, and
`npx @spekoai/mcp-calls login` re-authenticates later. The package runs **single-process** —
your key calls `api.speko.dev` directly (no separate server to boot).

Then, in your agent:

```
> "call Sakura Sushi and ask if they have a table for 4 at 8pm — my name is John"
```

<details><summary>Manual / CI setup (skip the wizard)</summary>

```bash
# Claude Code
claude mcp add speko-calls --scope user --env SPEKO_API_KEY=sk_... -- npx -y @spekoai/mcp-calls
```

```jsonc
// Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "speko-calls": {
  "command": "npx", "args": ["-y", "@spekoai/mcp-calls"],
  "env": { "SPEKO_API_KEY": "sk_..." }
} } }
```

To route through a hosted/remote backing server instead of running in-process, set
`SPEKO_MCP_SERVER_URL` (then `SPEKO_API_KEY` lives on that server, not in your client).
</details>

`lookup_business` mints a dial token → `make_call` places the disclosed call and streams progress
while it rings → the `OUTCOME:` line lands back in your terminal.

> **Telephony note:** real calls require the Speko deployment's outbound SIP trunk / caller-ID to be
> configured. If `make_call` returns `not_connected` (the AI agent starts but the phone never rings),
> run `check_call_readiness` — the demo reports this honestly rather than faking a result.

---

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business(name, location?, phone_number?)` | Resolve a business → dialable candidates + a signed `dial_token` per callable one (the only path that can authorize `make_call`). Pass `phone_number` (E.164 — e.g. found via the agent's web search) to skip the directory lookup; still carrier-verified as a business line. |
| `make_call(dial_token, objective, caller_name, context?)` | Place the disclosed, objective-scoped call. Waits for completion, streams progress, returns the `OUTCOME` line + transcript. Reports `connected`/`answered` honestly — a call the platform never actually puts on the wire (no telephony leg) comes back as `not_connected`, never a fake success. |
| `call_number(phone_number, objective, caller_name)` | Disclosed PERSONAL call to a specific number (e.g. a friend) — mobiles allowed. On by default (set `SPEKO_ALLOW_DIRECT_DIAL=0` to restrict to business lines). |
| `get_call(call_id)` | Read-only: re-check an existing call's status, `OUTCOME`, and transcript. Never dials. |
| `check_call_readiness()` | Read-only preflight — auth, credit balance, outbound caller-ID. Never dials. |
| `call_me(message, mode)` | _v2 — deferred until the platform exposes a verified personal phone._ |

## Safety rails (enforced in `server/`)

Built to the only defensible TCPA lane (FCC 24-17): **business lines only** (carrier line-type
check), a **hard-coded, non-overridable AI disclosure** opening line, a **transactional-objective
screen** (selling / promotion / surveys / fundraising / campaigning refused), **quiet hours**
(08:00–21:00 destination-local, fail-closed on unknown offset), **signed account-bound dial tokens**
(HMAC-SHA256, 15-min TTL), and nonce-delimited prompt blocks against injection. These run server-side
because an open npm package can be patched around.

---

## Layout

```
mcp-dev-calls/
├── mcp/              # the MCP server (mcp-framework, no secrets)
│   ├── src/
│   │   ├── index.ts          # MCPServer bootstrap (stdio)
│   │   ├── tools/            # LookupBusiness · MakeCall · CheckCallReadiness · CallMe
│   │   └── http/             # client to the backing server
│   └── server.json           # MCP registry metadata
├── server/           # the backing API (Express; holds keys + rails)
│   ├── src/
│   │   ├── index.ts          # HTTP bootstrap
│   │   ├── routes.ts         # POST /lookup · POST /call · GET /readiness · GET /call/:id
│   │   ├── lookup/           # Google Places + Twilio + demo fallback
│   │   ├── safety/           # dial tokens · objective screen · disclosure prompt
│   │   ├── speko/            # @spekoai/sdk wrapper (+ raw session read)
│   │   └── calls/            # make_call · readiness · get_call · connection assessment
│   └── test/                 # unit tests for the safety-critical logic
├── scripts/          # place-call.mjs (one-shot demo runner) · inspect-call.mjs (diagnostics)
├── .env.example      # both tiers
└── package.json      # npm workspaces root
```

## Develop

```bash
npm run typecheck     # tsc --noEmit, both tiers
npm test              # vitest (server safety rails)
npm run build         # tsc → dist/, both tiers
npm run dev:server    # backing API with watch
npm run dev:mcp       # MCP over stdio with watch
```

MIT © SpekoAI
