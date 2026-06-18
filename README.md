# Speko Calls — "AI calls for devs" MCP demo

**Find a business and place a real, _disclosed_ phone call to it — straight from your coding agent.**

> _"call Sakura Sushi and ask if they have a table for 4 at 8pm"_
> → `"Hi, this is an AI assistant calling on behalf of Amirlan…"`
> → `OUTCOME: table for 4 at 8pm, booked under Amirlan` — back in your terminal.

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
# 1. install (npm workspaces: installs both tiers)
npm install

# 2. configure
cp .env.example .env       # then fill in SPEKO_API_KEY + SPEKO_DIAL_TOKEN_SECRET
                           # (leave SPEKO_DEMO=1 to dial one consented target without Google/Twilio)

# 3. build both tiers
npm run build

# 4. start the backing server (holds the keys + rails)
npm run dev:server         # → http://127.0.0.1:8787

# 5. add the MCP to Claude Code (in another shell)
claude mcp add speko-calls -- node "$(pwd)/mcp/dist/index.js"
```

Then, in Claude Code:

```
> check_call_readiness
> "call Sakura Sushi and ask if they have a table for 4 at 8pm — my name is Amirlan"
```

`lookup_business` mints a dial token → `make_call` places the disclosed call and streams progress
while it rings → the `OUTCOME:` line lands back in your terminal.

---

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business(name, location?)` | Resolve a business → dialable candidates + a signed `dial_token` per callable one. The only path that can authorize `make_call`. |
| `make_call(dial_token, objective, caller_name, context?)` | Place the disclosed, objective-scoped call. Waits for completion, streams progress, returns the `OUTCOME` line + transcript. |
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
│   │   ├── routes.ts         # POST /lookup · POST /call · GET /readiness
│   │   ├── lookup/           # Google Places + Twilio + demo fallback
│   │   ├── safety/           # dial tokens · objective screen · disclosure prompt
│   │   ├── speko/            # @spekoai/sdk wrapper
│   │   └── calls/            # make_call orchestration · readiness
│   └── test/                 # unit tests for the safety-critical logic
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
