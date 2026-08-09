# Running on cloud agent platforms

How to run `@spekoai/mcp-calls` inside a headless cloud agent sandbox: no TTY, an
ephemeral filesystem, secrets injected as environment variables, and MCP tool-call
timeouts you may not control. Everything here applies to any platform that can spawn
a stdio MCP server; one worked configuration example uses a specific platform's format.

## First hour runbook

Three steps, in order. Each isolates a different failure class.

**1. Prove the install and the tool surface, offline.**

No API key, no network, no real call. `SPEKO_TEST_MODE=1` runs every tool as a
deterministic in-process simulation (see "Hermetic CI" below). Spawn the server piped
and drive it with raw JSON-RPC; the process exits when stdin closes:

<!-- TODO: swap in selftest when merged -->

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | SPEKO_TEST_MODE=1 npx -y @spekoai/mcp-calls@<version>
```

Expected: a `tools/list` result naming all 6 tools (`lookup_business`, `make_call`,
`call_number`, `check_call_readiness`, `get_call`, `call_me`) - proof the package
installs, spawns, and speaks MCP in your sandbox before any credential exists.

**2. Prove the key and the account, with one command.**

```bash
SPEKO_API_KEY=sk_... npx -y @spekoai/mcp-calls@<version> status --json
```

Exit 0 means ready to place calls (auth ok, credits sufficient, a way to dial out);
exit 1 prints what is missing, with next steps. Gate sandbox readiness on this exit
code. `init` is an interactive onboarding wizard for workstations - it is not the gate.

**3. Place one real call, to yourself.**

With owner state configured (see "The owner call" below), ask the agent to use
`call_me` so the first real dial rings the integrating engineer's own phone - not a
business, not a stranger. Run `check_call_readiness` first; it reports
`call_me.available`. If the attempt is rejected - the after-hours gate asks for
`after_hours_confirmation`, or a second attempt while the first owner call is live
returns `owner_busy` without dialing - that is the system working: the rails reject
rather than mis-dial. Follow the rejection's `next_step` instead of routing around it.

## Configuration

The generic stdio shape most MCP hosts accept:

```json
{
  "command": "npx",
  "args": ["-y", "@spekoai/mcp-calls@<version>"],
  "env": {
    "SPEKO_API_KEY": "<from your platform's secret store>",
    "SPEKO_CLIENT_PROFILE": "safe-default",
    "SPEKO_OWNER_PROFILE": "<optional secret - see the owner section>",
    "SPEKO_TOOLS": "<optional comma list - see shrinking the surface>"
  }
}
```

`SPEKO_CLIENT_PROFILE=safe-default` is the right profile when you do not know the
host's timeout behavior: it forces `call_me` to return immediately with a `call_id`
instead of blocking (poll with `get_call`).

Worked example - Hoplite's `.hoplite/settings.json`, where `mcpServers` is an ARRAY of
`{name, enabled, config}` entries and `stdio` servers run inside the sandbox with `env`
values stored as platform secrets. Schemas change; check your platform's current docs
before copying:

```json
{
  "mcpServers": [
    {
      "name": "speko-calls",
      "enabled": true,
      "config": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@spekoai/mcp-calls@<version>"],
        "env": {
          "SPEKO_API_KEY": "sk_...",
          "SPEKO_CLIENT_PROFILE": "safe-default"
        }
      }
    }
  ]
}
```

## Auth in sandboxes

API-key environment auth is the lane. `speko login` and the `init` wizard sign in
through a browser; a remote sandbox has no browser to complete the redirect, and
sign-ups or sign-ins from datacenter egress may additionally be blocked by anti-abuse
controls. Create the key on your workstation (at
[platform.speko.dev](https://platform.speko.dev) or via `speko login`), store it in the
platform's secret store, and inject it as `SPEKO_API_KEY`. In the sandbox you skip
`init` entirely - the env block above is the whole setup.

Never commit a key. In MCP-server mode the MCP layer skips `.env` discovery from the
working directory (an untrusted user repo); `SPEKO_ALLOW_DOTENV=1` opts back in, and
`SPEKO_NO_DOTENV=1` disables that layer's `.env` discovery in every mode. Whenever a
`.env` is loaded, its absolute path is printed to stderr. Do not treat `.env` exclusion
as a security boundary, though: the embedded call core still auto-loads a repo-style
`.env` for its own server-side settings (values already set in the environment always
win). Supply configuration only through the environment, and keep `.env` files out of
repos the agent works on.

## The owner call (call_me) headless

Verify once on a machine with a terminal: `speko me verify` places one real, disclosed
call to your phone and asks for its six-digit code (NANP numbers only in 0.7.0). Then
`speko me export` prints a single-line `spkow1.` blob on stdout (the warning goes to
stderr, so `> blob.txt` captures only the blob). Store the blob as the secret env var
`SPEKO_OWNER_PROFILE` in the sandbox - it is credential-equivalent for ringing that one
number, so treat it exactly like an API key. At startup the backend seeds owner state
from it only into an empty owner-state directory; existing owner state always wins, and
an invalid blob fails closed (`call_me` stays unavailable, nothing is written). Every
owner call still runs the ordinary rails: DNC, the 3/hour and 8/day per-number caps,
content screens, quiet hours, and the single-live-call lease.

## Timeouts: run calls in poll mode

A real phone call takes minutes. Many platforms cap an MCP tool call at 30-120 seconds,
and some do not publish the cap. `make_call` and `call_number` block by default until
the call finishes; in a sandbox:

- Pass `wait: false` on `make_call`, `call_number`, and `call_me`. The tool returns at
  once with a `call_id`; poll `get_call(call_id)` until the status is final. `get_call`
  is read-only and never dials.
- If a blocking call times out at the platform layer, the phone call may still be live.
  Never re-dial. Recover with `get_call` (or `speko call report <id>`), and treat any
  ambiguous failure as possibly dialed.
- A built-in replay guard rejects a same-number, same-objective re-dial within its TTL
  (the dial-token TTL, 15 minutes) and names the original `call_id` in the rejection.
  It is per-process and best-effort: a platform-side retry that respawns the sandbox is
  a fresh process the guard cannot see. Turn off automatic tool-call retries and
  thread re-runs for real-mode calling.

## Install / cold start

- Pin an exact version. `@latest` in a sandbox config means an unreviewed upgrade can
  land mid-pilot.
- `npx -y` downloads the package from the npm registry on first run in every fresh
  sandbox - a slower cold start and a registry dependency in your call path. For
  production sandboxes, bake it into the base image
  (`npm install -g @spekoai/mcp-calls@<version>` at image build time) and set
  `"command": "speko"` with no args in the MCP config.
- Node >= 20 is required.

## Multiple sandboxes, one key

The safety rails in this package run in-process and keep state on the local filesystem
(default `~/.speko/calls`): per-number rate caps (3/hour, 8/day by default), the local
do-not-call list, the owner-call lease, and the replay guard. N parallel sandboxes
multiply each of them by N - ten sandboxes can place 30 calls per hour to one number,
and the owner can be rung concurrently from different sandboxes, because the lease is
per filesystem. Only platform auth, credits, and key revocation are enforced remotely
per account. Account-level, server-side enforcement of the abuse rails is planned;
until then, size the numbers above per sandbox and keep owner-call pilots
low-concurrency.

Advanced users can centralize the state instead: run the Express server (`server/`) on
one host holding `SPEKO_API_KEY`, lookup credentials, `SPEKO_DIAL_TOKEN_SECRET`, and
the state directories, and point every sandbox at it with `SPEKO_MCP_SERVER_URL` plus
`MCP_INTERNAL_KEY` (required for non-loopback binding). Sandboxes then hold no Speko
key, and the caps, DNC list, and lease are enforced once, on the server host.

## Hermetic CI

`SPEKO_TEST_MODE=1` runs every tool as a deterministic in-process simulation: no key,
no network, no telephony. Every result carries `test_mode: true`, simulated transcripts
and outcomes are labeled `[SIMULATED]`, and all safety rails still run for real (signed
dial tokens, rate caps, DNC, the after-hours gate).

- Magic numbers: `+15005550001` connected and answered with an `OUTCOME` line;
  `+15005550002` not connected (no answer); `+15005550003` connected but nobody
  responded; any other number behaves like `+15005550001`. `call_me` works against a
  pre-seeded fixture owner (`+1 500 555 0100`).
- Refusal invariant: test mode refuses to start tools if a live-looking `SPEKO_API_KEY`
  (`sk_*` that is not `sk_test_*`) or `SPEKO_MCP_SERVER_URL` is configured. One process
  can simulate calls or place real ones, never both.
- `SPEKO_FAKE_NOW=<ISO-8601>` moves test mode's frozen clock (14:00 destination-local
  by default) so the after-hours gate is testable. It is never read outside test mode.

Copy-paste CI job (GitHub Actions shown; any CI works):

```yaml
  voice-tools-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      # sk_test_ci is a placeholder that satisfies the CLI's key check;
      # test mode refuses real keys, and no network call is made.
      - name: hermetic readiness gate
        run: SPEKO_TEST_MODE=1 SPEKO_API_KEY=sk_test_ci npx -y @spekoai/mcp-calls@<version> status --json
      - name: hermetic tool exercise over stdio
        run: |
          printf '%s\n' \
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
            '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
            '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
            '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"call_number","arguments":{"phone_number":"+15005550001","objective":"confirm the store is open","caller_name":"CI"}}}' \
            | SPEKO_TEST_MODE=1 npx -y @spekoai/mcp-calls@<version> | grep -q SIMULATED
```

## Shrinking the surface

On platforms that do not approval-gate MCP tool calls, `SPEKO_TOOLS` registers only the
listed tools in MCP-server mode - for a pilot, this removes the open-ended dialing
tools from the model's reach entirely:

```
SPEKO_TOOLS=call_me,get_call,check_call_readiness
```

Unset or empty registers all 6 tools. Unknown names are ignored with a stderr warning;
if nothing valid remains, the server registers zero tools (fail closed) rather than
silently re-arming the full dialing surface against an explicit restriction.
