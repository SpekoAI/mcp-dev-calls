# agentvoice

**[agentvoice](https://agentvoice.to) is an MCP server for real phone calls: your coding
agent can call you when it gets stuck, or place disclosed calls to businesses.**

This repo is the source of the [`@spekoai/mcp-calls`](https://www.npmjs.com/package/@spekoai/mcp-calls)
npm package. Calls run on [Speko](https://platform.speko.dev); every call opens with an
AI disclosure, and safety rails (business-line checks, rate caps, local DNC, after-hours
confirmation, signed dial tokens) are enforced server-side.

## Quickstart

```bash
# sign in with your browser, then configure every detected supported client
npx @spekoai/mcp-calls@latest init
```

Then tell your agent:

```
> "work on <task> and call me when you are done or stuck"
```

**[mcp/README.md](mcp/README.md) is the canonical user doc**: setup for every client,
the tool reference, the CLI, safety rails, and hermetic test mode.

## Architecture

```
Default (single process):
MCP host -> stdio MCP + embedded server core -> @spekoai/sdk -> api.speko.dev
                    key, owner/DNC state, lookup credentials, and rails live here

Optional remote mode:
MCP host -> stdio MCP -> authenticated HTTP -> Express server -> @spekoai/sdk -> api.speko.dev
                                             keys, state, lookup, and rails live here
```

- **`mcp/`** — the stdio MCP and CLI. In the default single-process install it embeds the server core and reads `SPEKO_API_KEY` from the client's MCP environment.
- **`server/`** — the reusable calling core plus optional Express wrapper. It runs lookup, owner resolution, safety rails, and `@spekoai/sdk` dialing.

The source is split so the same trusted core can run embedded or behind Express. Google lookup
stays **out of** `api.speko.dev`; it belongs to this app and runs wherever the core runs.

## Layout

```
mcp-dev-calls/
├── mcp/              # stdio MCP + CLI; embeds the core by default (mcp/README.md = user doc)
├── server/           # reusable trusted core + optional Express wrapper + safety-rail tests
├── characterization/ # golden-baseline suite driven by test:integration
├── docs/             # guides — agent-platforms.md: running on cloud agent platforms
├── scripts/          # check-version-lockstep.mjs (CI gate), mcp-e2e.mjs (integration),
│                     # place-call.mjs (one-shot call runner), inspect-call.mjs (diagnostics)
├── .env.example      # both tiers
└── package.json      # npm workspaces root
```

## Develop

```bash
npm run typecheck         # tsc --noEmit, both tiers
npm test                  # vitest, both tiers
npm run build             # tsc → dist/, both tiers
npm run test:integration  # characterization + MCP e2e + selftest
npm run dev:server        # backing API with watch
npm run dev:mcp           # MCP over stdio with watch
```

MIT © SpekoAI
