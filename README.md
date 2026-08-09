# Speko Calls — "AI calls for devs" MCP demo

**Place real, disclosed calls from your coding agent, including owner calls when the agent needs a decision.**

> _"call Sakura Sushi and ask if they have a table for 4 at 8pm"_
> → `"Hi, I'm John's AI assistant…"`
> → `OUTCOME: table for 4 at 8pm, booked under John` — back in your terminal.

This repo is a **demo**. It shows how a developer can wire a Claude Code MCP to Speko's
calling platform: get an API key from [platform.speko.dev](https://platform.speko.dev),
bring your own business-lookup (Google Places), and let Speko place the call.

---

## What it showcases

1. **Get a key, make a call.** `SPEKO_API_KEY` from [platform.speko.dev](https://platform.speko.dev) → real outbound calls via the official [`@spekoai/sdk`](https://www.npmjs.com/package/@spekoai/sdk).
2. **Bring-your-own lookup.** The Google business lookup lives **in this demo's own server**, *not* baked into `api.speko.dev`. Speko's API stays focused on calling; discovery is the app's concern.
3. **Safety as the product.** A non-removable AI disclosure, business-line checks where required, no-sell/harassment/impersonation screens, rate caps, local DNC, after-hours confirmation, and signed dial tokens run in the local server component. They protect normal installs and confused agents; platform auth, credits, and key revocation remain the independent remote boundary.
4. **Owner remote control.** A local voice-OTP binds one NANP owner phone to `call_me`, with strict read-back confirmation and `get_call` recovery.

---

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

---

## Quickstart

```bash
# one command: sign in with your browser, then configure every detected supported
# client (Claude Code/Desktop, Cursor, Windsurf, VS Code, Gemini, Codex, Cline).
# Zed receives a paste-ready manual snippet.
npx @spekoai/mcp-calls@latest init
```

`init` signs you in via your browser, then writes your key and client timeout profile into every detected supported client.
Already have a key, or on a headless box? `--token sk_...` supplies it directly and `--paste` skips browser opening, while
`npx @spekoai/mcp-calls login` re-authenticates later. The package runs **single-process** —
your key calls `api.speko.dev` directly (no separate server to boot).

After a successful connection, the optional final step places one real voice-OTP call; `call_me`
is enabled only if the OTP succeeds. You can run `speko me verify` later. Verification is
NANP-only in 0.7.0.

`npx -y @spekoai/mcp-calls selftest` verifies any install offline — a hermetic simulation with no key and no real calls.

For headless or ephemeral installs (cloud coding-agent sandboxes), verify once on a machine with
a terminal, run `speko me export`, and set the printed blob as `SPEKO_OWNER_PROFILE` in the
sandbox environment (store it like an API key — a secrets manager, not a repo file). The backend
seeds its owner state from it at startup; an existing owner state always wins over the env value.
The blob is credential-equivalent for ringing that one number and adds no new trust boundary.

Then, in your agent:

```
> "call Sakura Sushi and ask if they have a table for 4 at 8pm — my name is John"
```

<details><summary>Manual / CI setup (skip the wizard)</summary>

```bash
# Claude Code
claude mcp add speko-calls --scope user --env SPEKO_API_KEY=sk_... --env SPEKO_CLIENT_PROFILE=claude-code -- npx -y @spekoai/mcp-calls
```

```jsonc
// Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "speko-calls": {
  "command": "npx", "args": ["-y", "@spekoai/mcp-calls"],
  "env": { "SPEKO_API_KEY": "sk_...", "SPEKO_CLIENT_PROFILE": "safe-default" }
} } }
```

To route through a hosted/remote backing server instead of running in-process, set
`SPEKO_MCP_SERVER_URL`; this always selects remote mode. Put `SPEKO_API_KEY`, lookup credentials,
`SPEKO_DIAL_TOKEN_SECRET`, safety settings, and state directories on that server. The MCP client
sends only an allowlisted client timeout profile and, when configured, `MCP_INTERNAL_KEY`.
`speko me` and `speko dnc` modify only the host where they run, so run them on the backing-server
host with `SPEKO_MCP_SERVER_URL` unset. Other account/audio CLI commands still call Speko directly
and require a local API key. Non-loopback server binding requires `MCP_INTERNAL_KEY`. The default
wizard install is in-process.
</details>

`lookup_business` mints a dial token → `make_call` places the disclosed call and streams progress
while it rings → the `OUTCOME:` line lands back in your terminal.

The wizard installs no Google or Twilio credentials. Name search requires Google Places, and every
real `lookup_business` dial token requires Twilio carrier credentials. `call_number` needs neither.

> **Telephony note:** real calls require the Speko deployment's outbound SIP trunk / caller-ID to be
> configured. If `make_call` returns `not_connected` (the AI agent starts but the phone never rings),
> run `check_call_readiness` — the demo reports this honestly rather than faking a result.

---

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business(name, location?, phone_number?, utc_offset_minutes?)` | Resolve a business → dialable candidates + a signed `dial_token` per callable one (the only path that can authorize `make_call`). Pass `phone_number` (E.164 — e.g. found via the agent's web search) to skip the directory search; it is still carrier-verified as a business line. |
| `make_call(dial_token, objective, caller_name, context?, behavior?, greet_first?, after_hours_confirmation?, max_duration_seconds?, wait?)` | Place the disclosed, objective-scoped call. Waits for completion, streams progress, returns the `OUTCOME` line + transcript. Reports `connected`/`answered` honestly — a call the platform never actually puts on the wire comes back as `not_connected`. `wait:false` returns a call ID to poll with `get_call`. |
| `call_number(phone_number, objective, caller_name, recipient_name?, context?, behavior?, greet_first?, utc_offset_minutes?, after_hours_confirmation?, max_duration_seconds?, wait?)` | Disclosed personal or business call to a specific number — mobiles allowed. On by default (set `SPEKO_ALLOW_DIRECT_DIAL=0` to restrict to business lines). `wait:false` returns a call ID to poll with `get_call`. |
| `call_me(message, mode?, context?, after_hours_confirmation?, max_duration_seconds?, wait?)` | Call this install's verified owner without accepting a destination. `notify` is one-way; `converse` returns a strict read-back-confirmed owner reply as untrusted transcript data. `wait:false` returns a call ID to poll with `get_call`. |
| `get_call(call_id)` | Read-only: re-check an existing call, including a call ID returned by `call_me`. Never dials. |
| `check_call_readiness()` | Read-only preflight — auth, credit balance, outbound caller-ID, owner verification, and client profile. Never dials. |

## CLI

The same binary is a terminal CLI (`npx @spekoai/mcp-calls <command>`, or `speko <command>` once installed):

```
speko init | setup | login     onboarding & auth
speko status                   health check: key, backend, credits, call readiness (alias: whoami)
speko me verify|status|export  verify, inspect, or export the local call_me owner
speko dnc list|add|remove|check  manage the local do-not-call list
speko audio speak "<text>"     text-to-speech (TTS)
speko audio transcribe <f|->   speech-to-text (STT)
speko voices [--provider <p>]  list available voices (alias: models)
speko usage                    account usage this period (sessions, minutes, spend, balance)
speko credits [--ledger]       prepaid balance (+ recent credit movements)
speko call report <id>         a finished call's outcome, cost + cost breakdown
speko call events <id>         timeline / speech diagram of the call
speko call transcript <id>     the call transcript, one line per turn
speko call recording <id>      the call's audio recording URL
```

`speko status` is the "is this thing set up?" doctor: exit 0 means ready to place calls.
`status`/`whoami`, `audio speak|transcribe`, `voices`/`models`, `usage`, `credits`, and `call *`
accept `--json` for machine-readable output.

## Safety rails (enforced in `server/`)

Built around consent and server-side enforcement: a **hard-coded, non-overridable AI disclosure**,
business-line verification on `lookup_business`, **no-sell/no-spam + harassment + impersonation
screens**, per-number rate caps, a local do-not-call list (`speko dnc`), an **after-hours
confirmation gate** (08:00–21:00 destination-local; late or unknown-timezone calls need explicit
human confirmation), **signed account-bound dial tokens** (HMAC-SHA256, 15-min TTL), and
nonce-delimited prompt blocks against injection. These run in the local server component and are
designed to constrain well-behaved installs; a machine owner can modify an open npm package.

The local owner profile is a setup and consent artifact, not a privileged trust boundary. Every
`call_me` still uses the ordinary 3/hour and 8/day caps, DNC, content screens, and the 08:00-21:00
destination-local gate. It never consults `SPEKO_TRUSTED_NUMBERS`; late calls require the human's
own words in `after_hours_confirmation`. A host-local, cross-process lease blocks a second live
owner call. One invocation places at most one call, and an ambiguous dial failure is never retried.

---

## Layout

```
mcp-dev-calls/
├── mcp/              # stdio MCP + CLI; embeds the core by default
│   ├── src/
│   │   ├── index.ts          # MCPServer bootstrap (stdio)
│   │   ├── tools/            # LookupBusiness · MakeCall · CheckCallReadiness · CallMe
│   │   └── http/             # client to the backing server
│   └── server.json           # MCP registry metadata
├── server/           # reusable trusted core + optional Express wrapper
│   ├── src/
│   │   ├── index.ts          # HTTP bootstrap
│   │   ├── routes.ts         # /lookup · /call · /call-number · /call-me · /readiness · /call/:id
│   │   ├── lookup/           # Google Places + Twilio + demo fallback
│   │   ├── safety/           # dial tokens · objective screen · disclosure prompt
│   │   ├── speko/            # @spekoai/sdk wrapper (+ raw session read)
│   │   ├── owner/            # private local owner profile + voice-OTP state
│   │   └── calls/            # make_call · call_me · readiness · get_call · connection assessment
│   └── test/                 # unit tests for the safety-critical logic
├── docs/             # guides — agent-platforms.md: running on cloud agent platforms
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
