# Roadmap — speko (@spekoai/mcp-calls)

> The durable plan, so context survives sessions. Deep versions:
> `docs/research/voice-dx-2026-07-02.md` (Bek's 5 asks, feature-by-feature) and
> `docs/research/agent-voice-toolkit-blueprint-2026-07-02.md` (agent-first blueprint,
> AX report card, full surface design, competitive wedge).

## North star

**The voice toolkit a coding agent can be trusted with.** One binary (`speko`): speech
(TTS/STT), real disclosed phone calls, and voice-agent infra — with safety rails enforced
in the tool layer and honest in-band telemetry (`via provider:model · failover N · $cost ·
bal $x`) on every result. The wedge vs ElevenLabs/Vapi/Deepgram MCPs: *they let agents
spend money and dial humans blind; speko reports what happened, what it cost, and refuses
the calls that shouldn't happen.*

**Positioning law:** Speko's hosted MCP (mcp.speko.dev) already has ~55 ops tools. This
npm package stays lean: **calls + rails + filesystem** (e.g. `kb sync` shipping local docs
into an agent's brain — impossible for hosted MCPs). Full platform CRUD → CLI commands,
not MCP tools. Human-only by design (never MCP): voice-clone creation, number purchase,
realtime.

## Shipped

- **0.4.5** — 10 QA fixes (honest outcomes, disclosure hardening, serialize guard) + review hardening. SPE-148..157 ✅
- **0.4.6** — voice CLI: `audio speak` / `audio transcribe` / `voices` (stdin, pipes, artifacts, `--json`, auto-routing printout). SPE-166 ✅
- **0.4.7** — bin renamed `speko-calls`→`speko`; bare `speko` in a TTY shows the command list (piped = MCP server, unchanged).
- **0.4.8** — **hangup detection**: poll loop watches the session's `endedAt`. *(merged; publish pending.)*
  **Premise corrected (Jul 2 live measurement, 5/5 calls):** these dials go via LiveKit SIP, so the Telnyx `call.hangup` webhook never fires and `endedAt` lands WITH `room_finished` (~0.5s apart) — the check stays as cheap redundancy, not an early signal. The real early phone-leg-death signal is the source-closed `egress_ended` fast-path (poll-hardening branch, 11.5-21.3s earlier); agent-initiated hangups surface as `call.end_tool.completed`.
- **0.4.9** — **the agent hangs up + the opener is never mangled + the terminal never lies.** (1) Agent-initiated hangup, client-side only: dials ride a persisted `speko-mcp-dial` agent row with `endCall:{enabled:true}` (the worker then registers its `end_call` tool); the row is re-verified and repaired on EVERY dial (voice pinned null so the platform's auto-picked voice can't cross-vendor-mismatch our TTS pin = silent-audio class; auto-attached `search_knowledge_base` tool stripped; endCall re-enabled if toggled off) and the prompt's rule set switches to "put your goodbye INTO end_call" only when the verified agent actually rode the dial — fail-open keeps the legacy agentless path. (2) Greeting builder rework: no more first-sentence splice ("asked me to hi."); imperative-gated graft with declarative rejection, narrowed disclosure/directive screens, abbreviation-safe splitting, safe relayed fallback, disclosure invariant on every path. (3) Poll hardening: `endedAt` checked every iteration, conservative wall-clock `egress_ended` fast-path (frozen-transcript-gated), report-grace waits for a substantive outcome, wall-clock elapsed. 175+49 tests (was 109+49). Built by parallel subagents, cross-family reviewed (4 Claude lenses + Codex gpt-5.5 xhigh), all P0/P1 findings fixed with regression proofs.

## The "call doesn't end" split (Bek 2026-07-02)

- **Callee/human hangs up, terminal stuck "in call…"** → OUR bug → fixed by the source-closed
  `egress_ended` fast-path (poll-hardening branch); 0.4.8's `endedAt` polling turned out to be
  redundant with `room_finished` (see the corrected 0.4.8 bullet) and is kept as a backstop.
- **Agent never hangs up after its goodbye** → **FIXED CLIENT-SIDE in 0.4.9.** The original
  "no client-reachable end primitive" framing was refuted: the worker HAS a working `end_call`
  tool (`apps/worker-ts/src/agent.ts:1773` buildEndCallTool), gated only on `endCall:{enabled:true}`
  riding the pipeline config — which an agent row provides (`services/call-config.ts:122`). 0.4.9
  dials via a persisted, per-dial-verified `speko-mcp-dial` agent row, so the tool registers and the
  prompt tells the model to hang up through it. **Re-scoped platform asks (SPE-160):** (1) `endCall`
  passthrough on `phoneSessionSchema` (retires the agent-row workaround); (2) `POST /v1/calls/:id/end`
  first-class end route (copy `services/builtin-tools.ts:254-372`); (3) max-duration backstop on the
  API outbound path (copy `demo-phone.ts:369-383`); (4) worker `deleteRoom` on participant
  disconnect (cuts the 12-21s drain; Tier-2). The old "hang up the Telnyx leg via callControlId" ask
  was impossible as written — outbound legs are LiveKit SIP participants; `deleteRoom` is the kill.

## v0.5 — next (this repo only, no platform/SDK changes)

P0 bugs found by the AX audit (blueprint §3):
1. ~~**stdout protocol pollution**~~ — **shipped** in #32 (`f9deb5a`): `[dial]`/`[result]` now
   `console.error`, never the JSON-RPC stdout.
2. ~~**Typo'd subcommand + piped stdin boots the MCP server**~~ — **shipped** in v0.5.1 (#37 M2):
   unknown command → usage on stderr + exit 2; server only on empty argv.
3. **Dial retry = double-dial risk**: in-process replay guard (cache dial fingerprint for TTL,
   reject dupes → `next_step=get_call`); delete the false "single-use" claim in `mcp/README.md`.

**Shipped 0.5.4** — read-only inspection CLI (0.5.3 was Bek's greet-first #36; the version
collided, reconciled to 0.5.4): `speko usage` / `speko credits [--ledger]` /
`speko call report|events|transcript <id>` (real cost via `usage.get()`/`credits`/`calls.report()`;
events = the "speech diagram" timeline) + **AGENTS.md** (root; README now documents the CLI too).
Only raw account numbers shown — the marked-up `$` display stays gated (open decision #1).

Then: `--play` force flag (agent hooks) · `transcript: none|compact|full` on call tools (default
compact — full transcripts flood agent context 3-5x) · `outputSchemaShape` on all 6 MCP tools
(mcp-framework 0.2.22 supports it) · cost in MCP `get_call` · `speko hook install` · exit-code contract.

## v0.6 — SDK bump (platform APIs exist today)

Agents CLI (list/create/attach-number + `agents test` text-sim, no dial) · `kb upload` / `kb sync <dir>`
· numbers search/list/doctor (buy = CLI-only, cost echo) · callbacks list/cancel · clone **read**
path (`voices --mine`, `--voice <cloneName>`) · `firstByteMs` (stop dropping the header) ·
`speko recommend` (decisionTrace) · words[] typing for the stream route.

## v0.7 — small platform asks (apps/server; ~ Abat's area)

`POST /v1/calls/:id/end` + dial-path max-duration (see above — **top priority, Bek's complaint**)
· serialize per-model `capabilities` in `/v1/voices` (~1 line; unlocks tag preflight) ·
`X-Speko-Cost-Micro-Usd` + request id on synthesize/transcribe (blocked on the pricing/markup
display decision) · forward `words[]` in batch transcribe · verified-owner-phone field → un-stub
`call_me` · flag: hosted `sessions.phone.create` bypasses all safety rails.

## v1.0 — platform design (name it, don't start it)

Clone consent attestation + call-path clone policy (FCC 24-17: cloned voice on outbound calls =
TCPA liability — blocked or self-voice-only) · failover-aware clone resolution in synthesize ·
Idempotency-Key on dial endpoints (Stripe semantics) · `TtsConfig.instructions` plumbing ·
persist worker EOU/TTFT/TTFB legs (latency diagram) · budget caps (`--max-cost-usd`) ·
eval harness (5-10 realistic agent tasks).

## Open decisions (owners)

1. Pricing display + 7% managed markup visibility → **Bek/product** (gates all cost surfacing)
2. `POST /v1/calls/:id/end` + dial max-duration → **platform/Abat** (gates "agent hangs up")
3. call_me verified-owner-phone field → **platform** (gates the escalation lane)
4. MCP mutation posture: agent/number creation human-gated vs Vapi-style parity → **Bek**
5. Clone consent gating before any clone exposure → **Bek + platform**
6. Tag contract on failover (strip/translate/exclude vs client-side gating) → **platform**
7. transcript=compact default: OK as behavior change? → **Amir w/ Bek sign-off**

## Linear map

SPE-148..157/165/166 done (0.4.5-0.4.7) · SPE-158 B2-fix (Murad/Saidbek) · SPE-159 D-INF1 room
isolation (open; #903 was the self-call bridge, NOT this) · **SPE-160 A1/A3 teardown (platform —
sharpened asks above)** · SPE-161 C3 endpointer · SPE-162 B3 read-back · SPE-163 B4 · SPE-164
D-INF2 provisioning.
