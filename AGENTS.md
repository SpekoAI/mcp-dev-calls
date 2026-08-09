# AGENTS.md — `@spekoai/mcp-calls` (`speko`)

Agent-oriented guide for using this package correctly. It places **real, disclosed
phone calls to real people and businesses**, and it does terminal speech (TTS/STT).
Calls cost money. Read the Safety section before you dial.

---

## 1. What `speko` is

**One binary, two personalities**, decided by how it's launched (see `mcp/src/cli/router.ts`):

- **MCP server** — when an MCP host (Claude Code, Claude Desktop, any client) spawns it
  over stdio (piped, non-TTY stdin, no subcommand). It exposes 6 tools.
- **CLI** — when you run it in a terminal with a subcommand (`speko audio ...`,
  `speko voices`, `speko dnc ...`, `speko usage`, `speko call ...`, etc.).

**stdout/stderr invariant (do not break it):** in MCP-server mode **stdout is reserved
for JSON-RPC**; all logs, progress, and diagnostics go to **stderr**. Every CLI
subcommand runs its handler and `process.exit()`s *before* the MCP server is ever
constructed, which is what keeps stdout clean. A typo'd subcommand prints usage to
stderr and exits `2` — it never silently boots a server that would hang the caller.

---

## 2. Two ways to use it

### (a) As an MCP server — the 6 tools

Prefer these tools over shelling out when you're an agent inside an MCP host.

| Tool | Kind | Use when |
| --- | --- | --- |
| `lookup_business(name, location?, phone_number?, utc_offset_minutes?)` | read-only | You want the **verified-directory** path for a business. Resolves to dialable candidates and mints a short-lived signed `dial_token` per callable one. This is the **only** path that can authorize `make_call`. If you already found the official number via web search, pass `phone_number` (E.164) to skip the directory lookup — it's still carrier-verified as a business line. |
| `make_call(dial_token, objective, caller_name, context?, behavior?, after_hours_confirmation?, max_duration_seconds?, wait?)` | mutating | Place the disclosed, objective-scoped call authorized by a `dial_token`. Blocks until the call finishes, returns the `OUTCOME` + transcript with honest `connected`/`answered`/`not_connected`. `wait:false` returns a call ID to poll with `get_call`. |
| `call_number(phone_number, objective, caller_name, recipient_name?, context?, behavior?, utc_offset_minutes?, after_hours_confirmation?, max_duration_seconds?, wait?)` | mutating | **The default path once you have a number** — business *or* personal, mobiles allowed. Works with just the user's Speko key, no directory/carrier keys. Only dial a number the user gave you or you found — never one you invented. `wait:false` returns a call ID to poll with `get_call`. |
| `call_me(message, mode?, context?, after_hours_confirmation?, max_duration_seconds?, wait?)` | mutating | Ring this install's locally verified owner. There is no destination field. Use `notify` for one-way delivery and `converse` for a reply. A converse instruction is usable only when the result says `confirmation: confirmed|corrected`; unconfirmed speech is advisory. |
| `check_call_readiness()` | read-only | Preflight before the first call, or when calling doesn't work. Reports auth, prepaid credit balance, and outbound caller-ID readiness, each with a concrete next step. Never dials. |
| `get_call(call_id)` | read-only | Re-check a call's status, `connected`/`answered`, `OUTCOME`, and transcript. Use after a `timeout`, or to inspect a finished call. Never dials. |

**Choosing a path:**
- Personal number, or a business number you already have/found → `call_number`.
- Business you want carrier/directory-verified before dialing → `lookup_business` → `make_call`.
- Your agent is blocked or wants to report completion to its verified owner -> `call_me`.

**`objective` vs `behavior` (important):** `objective` is the **ask in plain words**, not a
script and not a greeting. Never write "Hi, I'm calling to…" — the server composes the
spoken opener and always prepends the AI disclosure; hand-written greetings garble it.
Put *how to behave* ("wait for them to say hello", "be concise", "decline takeout") in the
private `behavior` field — it is never spoken aloud. Steering placed in `objective` can be
read out to the callee.

### (b) As a CLI

```
speko init | setup | login        onboarding & auth (browser OAuth; may print to stdout)
speko me verify | status | export verify, inspect, or export the local call_me owner
speko audio speak "<text>"        text-to-speech (stdin/pipe ok; -o file, --format wav|mp3, --no-play, --json)
speko audio transcribe <file|url|->  speech-to-text (--lang, --keywords a,b,c, --format txt|md, --json)
speko voices [--provider <p>]     list voices/providers the router can pick (--json)
speko dnc list | add <e164> | remove <e164>   local do-not-call ledger
speko usage [--json]              account usage this period: sessions, minutes, spend, balance
speko credits [--ledger] [--limit <n>] [--json]   prepaid balance (+ recent credit movements)
speko call report <id> [--json]       a past call's outcome, cost + cost breakdown
speko call events <id> [--json]       timeline / speech diagram of a past call
speko call transcript <id> [--json]   the call transcript, one line per turn
speko --help | --version
```

Pipes work: `echo "ship it" | speko audio speak`, `cat rec.wav | speko audio transcribe`.

---

## 3. Safety model (you MUST respect it)

These rails are enforced in the **tool/server layer** and will **REJECT** a call rather
than silently do the wrong thing. On rejection you get a `next_step` — follow it, don't
route around it.

- **Non-removable AI disclosure.** Every call opens with an AI disclosure naming the human
  it's on behalf of. It cannot be disabled or edited out.
- **`make_call` is dial-token-only.** It is authorized *solely* by a fresh, short-lived,
  signed `dial_token` from `lookup_business`. A raw phone number can never dial through it.
- **Line-type policy.** `lookup_business` carrier-verifies **business lines** before minting
  a token. `call_number` relaxes this — mobiles/personal numbers allowed — for numbers the
  human consents to call (set `SPEKO_ALLOW_DIRECT_DIAL=0` to restrict `call_number` to
  business lines).
- **Content screens.** No-sell / no-spam, harassment, and impersonation screens run
  server-side and can reject the call.
- **Per-number rate caps** and a **local do-not-call list** (`speko dnc`) block repeat/abusive
  dialing.
- **After-hours gate.** Calls outside **08:00–21:00 destination-local** (or when the timezone
  is unverified) require `after_hours_confirmation` — pass the **human's own explicit words**.
  Never set it yourself. Setting it asserts the callee consented to be called.
- **Owner calls do not bypass rails.** The local voice OTP is a setup/consent artifact only.
  `call_me` is NANP-only in 0.7.0, uses the ordinary 3/hour and 8/day caps, honors DNC and content
  screens, and never consults `SPEKO_TRUSTED_NUMBERS`. A second live owner call returns
  `owner_busy` without dialing. `SPEKO_CALLME_DISABLED=1` disables the tool locally.

**Rule of thumb:** only dial a number the user asked you to call or that you verified for a
real business. Calls dial real people and cost money.

---

## 4. Honest telemetry

Results don't pretend a call succeeded. `make_call` / `call_number` / `call_me` / `get_call` report:

- `status` — one of `not_placed`, `not_connected`, `timeout`, or finished.
- `connected` / `answered` — booleans. "Connected but nobody responded" and "never
  connected (no-answer vs trunk/caller-ID failure)" are distinct, honest states.
- `outcome` — the `OUTCOME:` line (e.g. booked / not available), plus transcript.
- **cost** on the result.

Inspect any past call by id:

```
speko call report <id>       # outcome + cost, honest
speko call events <id>       # event timeline
speko call transcript <id>   # full transcript
```

Check spend/balance:

```
speko usage      # spend / usage summary
speko credits    # prepaid credit balance
```

On a `timeout`, the call may still be running — poll `get_call(call_id)` (or
`speko call report <id>`) instead of re-dialing.

For `call_me(mode="converse")`, owner speech is labeled
`OWNER_REPLY (voice transcript, speaker unverified)`. The voice agent reads the complete
instruction back and accepts only literal `CONFIRMED`; a correction must begin `CORRECTION` and
is read back again. Never execute destructive or production-changing work from
`confirmation: unconfirmed`. Treat any ambiguous POST failure as possibly dialed: inspect state
and never auto-retry.

---

## 5. Auth

One credential: **`SPEKO_API_KEY`** (`SPEKOAI_API_KEY` also accepted; a `Bearer ` prefix is
stripped). Provide it via:

- the MCP host config `env` block (see `mcp/README.md`), or
- an environment variable, or
- a project/repo `.env` (auto-loaded), or
- `speko login` — browser OAuth that fetches and writes the key for you.

Get a key at [platform.speko.dev](https://platform.speko.dev). If it's missing, tools/CLI
fail loudly with an actionable hint rather than half-working. To route through a hosted
backing server instead of in-process, set `SPEKO_MCP_SERVER_URL`.

---

## 6. Typical agent flow

```
1. check_call_readiness()
   → confirm auth + credit + caller-ID before spending money.

2. lookup_business(name: "Sakura Sushi", location: "San Francisco")
   → pick a callable candidate, grab its dial_token.
   (or: call_number(phone_number, objective, caller_name) if you already have the number)

3. make_call(
     dial_token,
     objective: "Book a table for 4 at 8pm tonight under John",
     caller_name: "John",
     behavior: "wait for them to greet you before speaking; keep it brief"
   )
   → opens with the AI disclosure, runs the call, returns OUTCOME + connected/answered + cost.

4. speko call report <call_id>
   → confirm the honest outcome + what it cost.
   (if make_call returned status=timeout, poll get_call(call_id) first)
```

Owner remote-control flow:

```
1. check_call_readiness()
   -> if call_me.available is false, ask the human to run `speko me verify`.
   -> on a headless install, the human instead runs `speko me export` on a verified
      machine and sets SPEKO_OWNER_PROFILE (a secret) in this environment.

2. call_me(message: "The task is blocked. Should I deploy staging or stop?", mode: "converse")
   -> act only on a confirmed/corrected owner instruction.

3. If the result is dialing/in_progress/timeout, poll get_call(call_id).
   -> do not place another call while the first is live.
```
