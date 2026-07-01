# THE AGENT VOICE TOOLKIT — blueprint

**For:** Amir (DX owner) · **Re:** Bek's thread D0B75JCGTFW/1782868419.553829 · **Builds on:** `docs/research/voice-dx-2026-07-02.md` (integrated, not repeated) · **Status:** research-only, no code changed, no credits spent. Verified vs inferred marked throughout.

---

## 1. NORTH STAR

Speko becomes **the voice toolkit a coding agent can be trusted with**: one binary (`speko`) that gives any agent multi-provider speech, real phone calls, and voice-agent infrastructure — with enforced safety rails (AI disclosure, quiet hours, dial tokens, consent-gated cloning), honest in-band economics (`via cartesia:sonic-3 · failover 0 · $0.0012 · bal $4.98` on every result), and token-frugal JSON contracts designed for a model, not a human. Every competitor has one piece — ElevenLabs the nouns, Vapi the CLI+calls+cost, Deepgram the one-bin pattern, Retell the compliance *guidance* — nobody has the combination, and the two pieces hardest to copy (enforced rails, benchmark-ranked failover with a data asset behind it) are already ours. The wedge sentence: **other MCPs let an agent spend money and dial humans blind; speko is the one that tells the agent what happened, what it cost, and refuses the calls that shouldn't happen.**

---

## 2. TOP AGENT USE CASES (ranked by agent value × frequency)

| # | Use case | Serves it | Missing today | Evidence |
|---|----------|-----------|---------------|----------|
| **1. Voice-infra-as-code** (the revenue lane): deploy script provisions a phone receptionist — agent CRUD, docs→KB, buy a number, attach | `speko agents create/attach-number`, `speko kb sync`, `speko numbers search/buy` | **Everything** — SDK fully types the loop (agents.d.ts:23-84, phone-numbers.d.ts:26-62, knowledge-bases.d.ts:26-59), zero CLI/MCP surface. Category is table stakes: Vapi CLI+MCP, Retell 45-tool MCP, ElevenLabs MCP, even a Vapi Terraform provider | verified (agent-use-cases UC3 + sdk-full-surface) |
| **2. Agent-native call QA in CI**: create agent → call it → assert on transcript JSON + cost | `speko call test <agent\|number> --script --json`; `speko agents test <id> "msg"` (text-mode sim via `listChatTools`+`complete`, no dial) | test command, dial idempotency keys (CI retry = double-dial, verified: dialToken.ts:101-141 has no replay state), transcript-assertion helper. Coval/Hamming prove the funded category; ElevenLabs ships `simulate_conversation` | verified (UC4; agents.d.ts:77-83) |
| **3. Voice as agent status output** (highest frequency, top-of-funnel): Claude Code Stop hook speaks "build done" | `speko audio speak` from a hook + `speko hook install` | `--play` force flag — playback is TTY-gated (speak.ts:163), so every hook silently writes a file and never plays. 4+ GitHub projects + 5+ blog posts reinvent this pattern with `say`/OpenAI TTS | verified (UC1; prior report bonus) |
| **4. Phone escalation** `call_me` (highest differentiation, retention hook): agent calls YOU when blocked | `call_me` MCP tool | **It's an intentionally inert stub that always throws** (CallMeTool.ts:32-38) — blocked on one platform field (verified owner phone). Demand proven: HumanLayer built a YC company on "agents contact humans" with no phone channel; Omnara/Happy/Anthropic Remote Control | verified (UC2, corrects the "shipped" framing) |
| **5. Call-the-business errands** (shipping today, our demo): lookup → disclosed call → outcome | `lookup_business` → `make_call`, `call_number`, `get_call` | Cost missing from results (we TRAIL Vapi's 8-component `costBreakdown`/Retell's `call_cost` — table stakes); full raw transcript floods context ~3-5x (summary.ts:84,101); SIP-level debug (`call events`) unexposed | verified (competitor lane wedge-correction; our-ax-audit P1) |
| **6. Call transcripts → tickets**: agent calls customer, files the Linear ticket from per-turn transcript | `speko call transcript <id> --json` | command itself (SDK-typed, T0-4); word timestamps dropped at batch route; diarization unverified | verified data / inferred workflow (UC7) |
| **7. Demo-video voiceover** (mid-tier, distribution-led) | `speak --json` + Remotion example in the skill | voice pinning on failover (narrator must never swap mid-project — B2 bug class), scene batching, `words[]` for captions. ElevenLabs wins here via *skills distribution*, not API | verified (UC5) |
| **Anti-goals** | Live mic dictation (Claude Code native `/voice` shipped 3/2026, Wispr owns the layer); Talon-style command grammars; realtime S2S maturity race vs OpenAI GA; music/sfx | — | verified (UC6/UC8, competitor lane rec 9) |

---

## 3. THE AGENT-NATIVE CHECKLIST — honest report card

Rubric AX-01..24 (Anthropic tool-writing + code-execution posts, MCP 2025-11-25, clig.dev, gh CLI, Stripe, AGENTS.md). Score of `@spekoai/mcp-calls` v0.4.7:

| AX | Item | Score | Evidence |
|----|------|-------|----------|
| 01 | outputSchema + structuredContent on MCP tools | **FAIL** (cheap fix) | zero `outputSchemaShape` in mcp/src/tools/*; framework 0.2.22 DOES support it (BaseTool.js:34,573,585-615 — **re-verified this session; ax-standards lane's "no framework support" claim was a wrong-path grep, disregard it**) |
| 02 | `--json` field selection + built-in `--jq` | PARTIAL | --json exists (speak.ts:47,149) but whole-blob; and **silently ignored in speak pipe mode** (speak.ts:140-158) |
| 03 | concise default / verbose on request | **FAIL** | full raw transcript (uuid/timestamps/provider/metadata per turn) in every call result, no `transcript:` param (summary.ts:84,101; GetCallTool.ts:5-9) |
| 04 | semantic identifiers over UUIDs | PARTIAL | summaries good; transcript turns carry raw uuids/metadata |
| 05 | in-band cost/latency/failover metadata | PARTIAL | `via provider:model · failover N` yes; cost + firstByteMs absent (SDK drops X-Speko-First-Byte-Ms; no cost anywhere — prior report §2.3-2.4) |
| 06 | errors = self-correction instructions | **PASS** | systematic `; next_step=` on both backends (serverClient.ts:13,95-104; server/src/lib/errors.ts:25-27) — genuinely ahead of the field |
| 07 | execution errors as isError, not protocol errors | PASS | tool-level throws surface as tool results |
| 08 | distinct documented exit codes | **FAIL** | binary 0/1 (mcp/src/index.ts:69-81); the 0/1/2 contract exists only in docs/voice-cli.md:92-94 which **isn't in the shipped package** (package.json:16); `speko audio` exits 1 where contract says 2 |
| 09 | idempotency keys on spend/dial ops | **FAIL (P0)** | none; dial tokens have NO replay tracking, 15-min TTL (dialToken.ts:101-141, constants.ts:103); shipped README falsely claims "single-use" (mcp/README.md:59) |
| 10 | behavior annotations on all tools | **PASS** | all 6 ship all four hints + title, serialized by framework (GetCallTool.ts:17-22, MakeCallTool.ts:78-84) |
| 11 | non-interactive contract (no prompt/hang/silent change) | **FAIL (P0×2)** | (a) TTY-gated play, no --play (speak.ts:163); (b) **typo'd subcommand + non-TTY stdin boots the MCP server and hangs** — live-verified (router.ts:21-29); (c) init hardcodes exit 0 on failure + askSecret can hang headless (index.ts:53, init.ts:248-264,63-70) |
| 12 | dry-run/preflight on mutating ops | PARTIAL | `check_call_readiness` is the pattern (CheckCallReadinessTool.ts:14); nothing for speak-cost/purchase |
| 13 | HITL rails enforced server-side | **PASS** | disclosure/quiet-hours/dial-tokens live in the tool layer, not host annotations — the right architecture. Caveat: hosted `sessions.phone.create` bypasses all of it (see §7 Q6) |
| 14 | AGENTS.md at root + in package | **FAIL** | find = zero hits repo-wide |
| 15 | shipped Agent Skill | PARTIAL | SKILL.md ships + installs, but calls-only — audio CLI invisible in every shipped artifact (README, SKILL.md, files[]) |
| 16 | file artifacts, intermediates out of context | **PASS** (design) / PARTIAL (transcript violates it) | artifact architecture validated by Anthropic's 98.7% number; transcript inlining is the exception |
| 17 | consolidated tool count, no 1:1 REST mirrors | PASS today, **at risk** | 6 tools right-sized; the SDK surfacing (§4) is where this gets won or lost — Twilio's 1,700-tool overflow is the documented anti-pattern (their curated benchmark: 100% vs ~92% success, 20% faster) |
| 18 | naming hygiene | PASS | snake_case, unambiguous params |
| 19 | polling contract for long ops (not MCP tasks) | PASS | get_call loop + 5s progress notifications w/ abort (MakeCallTool.ts:94-98); tasks correctly avoided (moving to extension in 2026-07-28 RC) |
| 20 | large artifacts as resource_links | FAIL | framework supports it (BaseTool.js:736-740); transcripts/recordings inlined instead |
| 21 | hook-ready (Stop/Notification) | **FAIL** | blocked by AX-11a |
| 22 | report what happened, not what was requested | PARTIAL | calls path honest (not_connected, commit 6c58d3a); speak silently degrades tags on failover (prior §2.2) |
| 23 | machine output = versioned contract | FAIL | nothing documented as stable |
| 24 | eval loop w/ realistic agent tasks | FAIL | none |
| — | **stdout protocol pollution** (unlisted, worst finding) | **FAIL (P0)** | makeCall's `console.log` [dial]/[result] lines write onto the stdio JSON-RPC channel on every in-process dial, behind a stale "separate process" comment (makeCall.ts:274,413; bundled mcp/dist/index.js:1246) |

**Net: 6 pass, 6 partial, 12 fail — but ~8 of the fails are 1-5-line fixes in this repo.** Only idempotency (needs platform participation) and server `instructions` (framework gap, MCPServer.d.ts: 0 hits, re-verified) are structural.

---

## 4. FULL SURFACE DESIGN

**Positioning rule (from sdk-full-surface, adopt as law):** the hosted Python MCP at mcp.speko.dev already exposes **55 tools** (51 dot-named ops + the same 4 rail-guarded call tools — action_tools.py:61-112, call_tools.py:82). **The local npm package does NOT become a second ops console.** Local = *calls + rails + filesystem*. Only add local surface that needs (a) the safety rails or (b) local file access. Full CRUD lives in the **CLI** (agents compose via bash, per AX-16 economics); MCP gains only task-shaped tools. 4 tool names collide with hosted (lookup_business, make_call, call_me, check_call_readiness) — pin our schemas to the hosted versions so dual-connection is harmless.

**Safety tiers** (from sdk-full-surface; write into AGENTS.md, enforce in annotations): **R** read-only · **W** reversible-write · **D** destructive (confirm) · **$** spend (cost echo + `--yes`) · **O** outward-facing (inherits disclosure/quiet-hours/dial-token rails) · **H** human-only (TTY-gated, never MCP, documented exclusion).

### End-state command tree

```
speko
├─ init [--token --yes --client --json]            # exit 0/1/2 fixed, --json summary
├─ audio speak <text> [--play --json --voice --pin --instructions*]     W$ 
│        transcribe <file|url> [--json → words[]*]                      W$
├─ voices [--json w/ capabilities*] [--mine]                            R
│        clone --name --clip --consent self|granted                     H  (TTY-only, FCC warning, never MCP)
├─ call  report <id> --json          # cost_micro_usd + breakdown       R
│        transcript <id> --json [--diagram]  # per-turn Gantt           R
│        events <id> --json          # SIP status codes, failure_cause  R  (calls.d.ts:6-16; closes the not_connected debug loop)
│        test <agent|number> --script <prompt> --json                   O$ (CI loop; requires idempotency)
├─ agents list|get|create|update|delete|attach-number|detach-number     R/W/D; attach = W+O (line goes live)
│        test <id> "<msg>"           # text sim, tools locked inline    W  (listChatTools + complete, no dial, no side effects)
├─ kb    list|upload <file>|sync <dir> --agent <name>                   W  (uploadDocument+pollDocumentReady; hosted MCP structurally can't ship bytes)
├─ numbers search|list|doctor        # setupStatus.issues + KYB state   R
│        buy                          # "$1 now + $1/mo — continue?"    $  (CLI-only; KYB attestation = H)
│        import-sip-trunk             W    · release = D, double-confirm, CLI-only
├─ callbacks list|get|cancel                                            R/W-protective (hosted MCP has ZERO callback tools — unclaimed)
│        dispatch                     O$  (only behind full rails; blocked on §7 Q7)
├─ usage · credits [ledger]                                             R
├─ recommend [--optimize-for] --json  # decisionTrace pre-flight        R
├─ hook install                       # writes Stop/Notification hook into ~/.claude/settings.json
└─ realtime chat                      H  (TTY REPL; stdio can't carry audio + open-ended spend — documented exclusion like clone)
```
`*` = needs platform (v0.7).

### End-state MCP tool list (curated, ≤12)

| Tool | Tier | Notes |
|------|------|-------|
| lookup_business, check_call_readiness, get_call | R | get_call gains cost + `transcript: none\|compact\|full` (default compact) + outputSchema |
| make_call, call_number | O$ | + idempotency, + "timeout → get_call, do NOT redial" in description |
| call_me | O | inert until platform field; keep registered-with-DEFERRED or unregister (decision Q4) |
| get_call_report *(new)* | R | cost+breakdown+webhook status; local-only name, no hosted collision |
| list_callbacks, cancel_callback *(new)* | R / W-protective | flagship "rails-differentiated ops" |
| upload_knowledge_document *(new)* | W | the one ops-write worth having locally (filesystem advantage) |
| **Never MCP:** clone creation, number buy/release, realtime, raw complete, KYB | H/$ | documented exclusions — the contrast vs ElevenLabs/Cartesia consent-free `clone_voice` IS the positioning |

### JSON contracts (the 4 agent-critical results; versioned per AX-23)

```jsonc
// speko audio speak "ship it" --json        (v0.5 fields now; cost/timing v0.7)
{ "ok": true, "file": "/…/out.mp3", "played": true,
  "provider": "cartesia", "model": "sonic-3",
  "voice": { "requested": "nova", "served": "nova", "pinned": false },
  "failover": { "count": 0, "attempts": [] },              // attempts[] on success = platform v0.7
  "expressive": { "tagsInText": false, "applied": [], "dropped": [] },  // AX-22 honesty
  "timing": { "firstByteMs": 210 },                        // v0.6: SDK stops dropping the header
  "cost": { "microUsd": 1200, "keySource": "managed", "balanceUsd": 4.98 } }  // v0.7: X-Speko-Cost-Micro-Usd

// speko audio transcribe memo.m4a --json
{ "ok": true, "text": "…", "file": "/…/memo.txt",
  "provider": "deepgram", "model": "nova-3", "confidence": 0.97,
  "failover": { "count": 0 },
  "words": [ { "text": "hello", "start": 0.12, "end": 0.31, "confidence": 0.99 } ],  // v0.7 batch route
  "cost": { "microUsd": 800, "balanceUsd": 4.97 } }

// speko call report <id> --json   ·   MCP get_call_report (structuredContent)
{ "callId": "…", "status": "completed", "connected": true, "outcome": "reservation confirmed for 7pm",
  "cost": { "microUsd": 48200, "breakdown": [
      { "provider": "telnyx", "metric": "carrier_minutes", "quantity": 2.4, "costMicroUsd": 24000, "keySource": "managed" } ] },
  "timing": { "durationMs": 143000,
    "turns": [ { "who": "agent", "text": "…", "startMs": 0, "endMs": 4200, "provider": "cartesia", "model": "sonic-3" } ] },
  "transcript": "compact",                                  // none|compact|full
  "dashboardUrl": "https://…" }

// speko usage --json   (pure SDK, unexposed today — prior §2.4)
{ "totalSessions": 12, "totalMinutes": 31.5, "totalCostUsd": 4.02,
  "balanceUsd": 45.98, "breakdown": [ { "metric": "tts_chars", "costUsd": 0.9 } ] }
```

---

## 5. UNIFIED ROADMAP (merges prior T0–T3; ordered by agent value)

### v0.5 — this week, this repo only, zero platform/SDK changes
| Item | Effort | Evidence |
|---|---|---|
| 1. **stdout fix**: makeCall.ts:274,413 console.log → console.error (protocol pollution on every dial) | S(2 lines) | our-ax-audit P0 |
| 2. **router fix**: unknown command → stderr usage + exit 2; server mode only on empty argv (typo currently hangs agent shells, live-verified) | S | router.ts:21-29 |
| 3. `--play` force flag (unlocks UC3, the #1-frequency use case) | S | speak.ts:163; prior T0-1 |
| 4. Truth patch: delete "single-use" from mcp/README.md:59; add "timeout → get_call, do NOT redial" to dial tool descriptions | S | our-ax-audit P0-2 |
| 5. **In-process dial replay guard** (cache dial_token/sha256(phone+objective) for TTL, reject dup → next_step=get_call) — bridge until platform keys | M | mirrors callInFlight pattern makeCall.ts:221-248 |
| 6. `transcript: none\|compact\|full` (default compact) on make_call/call_number/get_call + compact `[{who,text}]` shape | S | summary.ts:84,101 |
| 7. `outputSchemaShape` (CallSummary zod) on all 6 tools — framework already emits it (re-verified) | S | BaseTool.js:573-615 |
| 8. `speko usage` + `speko credits [ledger]` + `speko call report` + `speko call transcript [--diagram]` + `speko call events` (SIP debug) | S each | prior T0-2/3/4 + calls.d.ts:6-16 |
| 9. MCP get_call gains cost_micro_usd | S | prior T0-5 |
| 10. CLI hygiene: --help on leaf commands exit 0, help→stdout, `speko audio` exit 2, init returns real exit codes + --json | S | our-ax-audit P2s |
| 11. **AGENTS.md** (root + npm files[]): dial paths, timeout rule, exit-code table, --json contracts, headless init, safety tiers; CLI section into shipped README + SKILL.md | S | AX-14/15 |
| 12. `speko hook install` (Stop/Notification hook writer) | S/M | UC1 |

### v0.6 — SDK bump (platform APIs already exist)
| Item | Effort | Evidence |
|---|---|---|
| 13. `firstByteMs` (stop dropping the header) | S | prior T1-7 |
| 14. **Agents CLI**: list/create/get/update/delete/attach-number + `speko agents test` (text sim, no dial) | M | agents.d.ts:23-84,77-83 |
| 15. **`speko kb upload` + `kb sync <dir>`** + MCP upload_knowledge_document — the filesystem killer feature | M | knowledge-bases.d.ts:26-59 |
| 16. **Numbers**: search/list/doctor (setupStatus.issues) everywhere; buy = CLI-only w/ cost echo; KYB = TTY attestation | M | phone-numbers.d.ts:26-62; types:605-609 |
| 17. Callbacks: list/get/cancel CLI + MCP list/cancel (unclaimed surface) | S | callbacks.d.ts:6-11 |
| 18. `speko recommend` (decisionTrace) — pending "is it public?" (Q9) | S/M | prior T1-8 |
| 19. Clone **read path**: voices --mine, --voice <cloneName> resolution | M | prior T1-9 |
| 20. `speko call test` CI loop (requires #5 guard; platform keys later) | M | UC4 |
| 21. words[] typing for WS transcribe-stream | S | prior T1-10 |
| 22. Publish the skill + Remotion voiceover example (distribution = the ElevenLabs lesson) | S | UC5, competitor rec 3 |

### v0.7 — small surgical platform asks (owner ≈ apps/server / @abat)
| Item | Effort | Evidence |
|---|---|---|
| 23. Serialize `m.capabilities` in /v1/voices (~1 line) → tag pre-flight | S | prior T2-11 |
| 24. `X-Speko-Cost-Micro-Usd` + request id on synthesize; costUsd in transcribe done event (blocked on pricing decision Q1, not engineering) | S | prior T2-12 |
| 25. Forward SttEvent.words in batch /v1/transcribe | S | prior T2-13 |
| 26. attempts[] + applied/dropped tag status on success responses | M | prior T2-14 |
| 27. **Verified-owner-phone field → call_me v2 "notify" mode** (file the ticket w/ HumanLayer/Omnara demand evidence) | M platform | CallMeTool.ts:32-38 |
| 28. Hosted-MCP safety flags to Bek: sessions.phone.create rail bypass; create_phone_number costless description (1-line) | S(flag) | action_tools.py:789-814,936-953 |

### v1.0 — real platform design (name it, don't start it)
| Item | Effort | Evidence |
|---|---|---|
| 29. Clone consent attestation + call-path policy (blocked/self-voice-only) — **before** clone creation ships | M/L | prior T3-15; FCC 24-17 |
| 30. Clone-name resolution in synthesize via voice_clone_provision (failover-aware clones; without it cloning is decoration) | L | prior T3-16 |
| 31. **Idempotency-Key on dial endpoints** (Stripe semantics; in-repo guard only protects one process) | M | prior T3-18 |
| 32. TtsConfig.instructions plumbing (tier-2 expressiveness) | M | prior T3-17 |
| 33. Persist worker EOU/TTFT/TTFB legs → latency diagram | M | prior T3-18 |
| 34. Budget caps (`--max-cost-usd`, per-key) + call_me "converse" (human-as-tool over phone — nobody ships this) | L | prior §2.4; UC2 |
| 35. MCP server `instructions` (PR mcp-framework or raw-SDK construction) + eval harness (AX-24, 5-10 agent tasks) | M | MCPServer.d.ts (0 hits) |

---

## 6. COMPETITIVE WEDGE — why an agent dev picks speko

**1. The rails ARE the product, not a limitation.** ElevenLabs and Cartesia ship consent-free `clone_voice` over MCP; ElevenLabs' `make_outbound_call` and Vapi's `create_call` document zero disclosure/quiet-hours/DNC enforcement; Retell's own TCPA playbook admits time-of-day and DNC "fall on the operator"; an entire wrapper industry (VoiceAIWrapper) exists to sell compliance on top of Vapi/Retell. Speko enforces AI disclosure, quiet hours, dial tokens and no-spam **in the tool layer** — the only architecture MCP annotations being untrusted actually permits. Tagline the research supports: *the only voice MCP a coding agent can be trusted with.* (One asterisk before quoting publicly: verify ElevenLabs outbound-call params, §7 Q10.)

**2. Honest in-band economics + routing where the whole field is blind.** Every competitor's cost surface is aggregate-only (`check_subscription`, `get_usage`); nobody reports which provider actually served a TTS call, what it cost, or per-attempt failover traces — and Vapi's fallbackPlan never even reports which fallback voice served. Speko's `via provider:model · failover N · $x · bal $y` line on every operation, backed by benchmark-ranked routing (a data asset, not a config list), is unmatched. **Honesty requirement:** on per-CALL cost we currently *trail* Vapi's 8-component costBreakdown and Retell's call_cost — roadmap items 8/9 close that first; the per-OPERATION claim is where we're genuinely alone.

**3. One trusted binary spanning all three tiers + filesystem.** Deepgram's `dg` has primitives but no calls; Vapi has calls but no TTS/STT primitives or multi-provider; ElevenLabs has nouns but single-provider and no CLI; the hosted ops MCPs (including our own 55-tool one) structurally cannot touch the agent's filesystem. `speko` alone does hook-speech → real disclosed calls → receptionist-as-code (`kb sync` shipping repo docs into a voice agent's brain is a capability no hosted MCP can copy). The copyable parts (one-bin, cost display) reward shipping this quarter; the moat parts (rails, benchmark data) compound.

---

## 7. RISKS & DECISIONS (deduped w/ prior report's 8; ≤10, decision-shaped)

| # | Decision | Owner |
|---|----------|-------|
| 1 | **Pricing display**: are µ$ rates display-safe ("editable placeholders" comment, pricing.ts) and is the 7% managed markup publicly visible? New framing: Vapi/Retell show per-component cost by default — hiding ours now reads as a gap, not discretion. Blocks items 24, cost-in-JSON. | Bek/product |
| 2 | **Idempotency-Key on POST dial endpoints** (server-side store+replay)? In-repo guard (item 5) only covers one process; two MCP sessions can still double-dial. Blocks CI story (item 20). | platform/Abat |
| 3 | **call_me verified-owner-phone**: who owns the field + verification UX, is there a ticket? Everything in the escalation lane (UC4 differentiation) blocks on it. | platform/Abat (field) + Bek (priority) |
| 4 | **MCP mutation posture**: agent/number creation CLI-human-gated (our proposal, consistent w/ clone stance) or full MCP parity with Vapi/Retell mutating tools? Also decides call_me's registered-inert vs unregister. | Bek/product |
| 5 | **Clone consent + call-path policy** (required attestation field; cloned voices blocked or self-voice-only on calls) — precondition to shipping clone creation at all (FCC 24-17). | Bek/product + platform |
| 6 | **Hosted rail bypass**: sessions.phone.create dials any E.164 with zero disclosure/quiet-hours (action_tools.py:789-814) — intentional trusted-ops surface, or do rails move server-side? Also the costless create_phone_number description (1-line fix). | Bek/product + platform/Abat |
| 7 | **callbacks.dispatch**: does it enforce quiet hours server-side? (Route only gates CALLBACKS_DISABLED.) Determines whether our dispatch tool wraps rails client-side or trusts the platform. Related: is there any server-side callback *create* (SDK has none)? | platform/Abat |
| 8 | **transcript='compact' default**: acceptable behavior change for existing consumers of the raw shape in v0.x, or full-stays-default? Also: version the --json contracts (AX-23) starting when? | Amir w/ Bek sign-off |
| 9 | **Tag contract on failover** (server strips/translates vs excludes candidates vs client-side gating) + is /v1/recommend-stack public-SDK-intended? (prior Q4+Q7 merged) | platform/Abat |
| 10 | **Timing data green lights**: words[] in batch transcribe + persist worker EOU/TTFT/TTFB legs (prior Q8); plus KYB end-to-end latency (is number-buying CI-scriptable or a one-time human onboarding to document as such?) | platform/Abat |

**Deduped away** (answered by this research): prior Q3 voices-capabilities ("any reason not to?" — no, it's item 23); ax-standards' framework-migration question (resolved: mcp-framework 0.2.22 supports outputSchema, verified this session); "does Claude Code tolerate stray stdout" (moot — fix is 2 lines, item 1).

**Flagged inferences (do not treat as verified):** callbacks are minted only platform-side (inferred from SDK absence of create); askSecret hangs on fully-closed stdin (untested); realtime.connect third-party posture; KB embedding billing; diarization support; SPE-144 tags being prompt-level.

---

## 8. tell bek

> went deep on your "for coding agents" angle. the sdk already types the whole receptionist-as-code loop (agents crud, buy numbers, kb upload, callbacks), we just never surfaced it, and our own hosted mcp has 55 ops tools so the npm one stays lean: calls + rails + filesystem. wedge is real, elevenlabs/cartesia ship consent-free voice clone mcps and nobody enforces disclosure or reports per-op cost, we do rails + honest cost on every result. this week: fix 3 nasty agent bugs found in audit (stray stdout on the json-rpc channel, retry can double-dial a real business, typo'd command hangs the shell), plus usage/cost/transcript commands and an AGENTS.md. full blueprint's ready, 2 asks need you: is the 7% markup ok to show, and does agent/number creation stay human-gated in mcp or match vapi.

---
*Sources: 5-lane research digest (agent-use-cases, ax-standards, sdk-full-surface, competitor-agent-voice, our-ax-audit) + prior report `/Users/amirlankalmukhan/mcp-dev-calls/docs/research/voice-dx-2026-07-02.md`. This-session verifications: mcp-framework outputSchema support (node_modules/mcp-framework/dist/tools/BaseTool.js:34,573,585-615, v0.2.22) and absence of MCPServer `instructions`. Nothing platform-only was upgraded to SDK-exists.*
