# Spec: Replace the quiet-hours hard block with real abuse guardrails

Status: PROPOSED (2026-07-01). Verified against HEAD `0c45830`. Adversarially reviewed by 3 lenses (legal w/ web-verified cites, abuse red-team, implementation sweep) before filing.

Repo: `SpekoAI/mcp-dev-calls` (`@spekoai/mcp-calls` 0.4.9, in-process server). **NOT a platform change** — zero quiet-hours code exists in `spekoai/platform`; everything ships via `npm publish`.

## Context

On 2026-07-01 21:37 PDT a legitimate, user-initiated call was rejected by the quiet-hours rail: destination local time was past 21:00, and the rail is a hard block with **no override path** (`server/src/safety/dialToken.ts:179-195`, enforced at `server/src/calls/makeCall.ts:116-128`). It also fails closed on unknown timezone — twice: `lookup_business` refuses to even mint a dial token when the offset is unknown (`server/src/lookup/index.ts:49-53`), and `make_call` blocks any token carrying a null offset. Any +1 number whose area code is missing from the 75-entry NANP map (`server/src/safety/timezone.ts:17-47`) is unreachable, period.

The blanket time filter blocks the wrong thing. It stops calling your own phone at 21:37 for smoke tests, blocks 24/7 businesses, and blocks unmapped area codes — while doing nothing against actual abuse: nothing today stops calling the same stranger 50 times at 2pm, there is no do-not-call memory when a callee says "stop calling me", the intent screen (`OBJECTIVE_BLOCK_RE`, `server/src/constants.ts:123`) covers only commercial solicitation (not harassment, pranks, or impersonation), and the `context` channel is not screened at all (`makeCall.ts:203`).

Direction (Bek, 2026-07-01): remove the quiet-hours filter; replace it with guardrails against cold calling, harassment, and spam calls.

## Current state (verified 2026-07-01, HEAD 0c45830)

Rails order in `makeCall.ts:90-163` (all reject before any dial):

| # | Rail | Where |
|---|------|-------|
| 1 | Dial-token verify (HMAC, 15-min TTL, account-bound) | `makeCall.ts:95`, `dialToken.ts:101` |
| 2 | Emergency / US-premium / E.164 validity | `dialToken.ts:145-159` |
| 3 | Business-lines-only (skipped on `call_number` path) | `makeCall.ts:108`, `dialToken.ts:161` |
| 4 | **Quiet hours 21:00-08:00 destination local, fail-closed on unknown offset** | `makeCall.ts:116`, `dialToken.ts:179`, `constants.ts:131-132`; ALSO pre-blocked at lookup: `lookup/index.ts:49-53` |
| 5 | No-sell objective screen (`OBJECTIVE_BLOCK_RE`) | `makeCall.ts:130`, `objective.ts:8` |
| 6 | Same screen on `behavior` channel | `makeCall.ts:140`, `objective.ts:32` |
| 7 | caller_name validation + sanitization | `makeCall.ts:148-163` |
| 8 | Non-removable AI disclosure opener | `constants.ts:11`, `prompt.ts` |
| 9 | 300s duration cap; one call at a time per process (`serializeCalls`, `makeCall.ts:272`) | `constants.ts:14`, `config.ts:105` |

Gaps (all verified in code):

- **`context` channel unscreened** — `makeCall.ts:203`. Existing bypass for spam AND harassment intent.
- **No impersonation screen** — "pretend to be her bank" / "say you're calling from the IRS" passes every rail today.
- **No per-destination rate limit.**
- **No do-not-call ledger** — a callee opt-out is forgotten immediately.
- **No harassment-intent screen** — "call my ex repeatedly until she picks up" passes today (at 2pm).

## Proposed change

Delete the quiet-hours **hard block**; replace it with five server-enforced guardrails. With one statutory exception (debt collection, below), no call becomes un-placeable — every rejection message states the exact retry path.

**Threat model (state it honestly):** these guardrails defend against a misaligned or over-eager AGENT within a session. They do not defend against the machine's human operator, who owns the env, the state files, and the source. That is the correct bar for a local dev tool; the disclosure + consent contract carries the operator's obligations.

### 1. After-hours human confirmation (the override)

- New optional string `after_hours_confirmation` on `make_call` and `call_number` — the human's own words approving a late call (e.g. "yes, it's my own number, call now"). A bare boolean was rejected in review: it carries no attestation and an agent flips it for free. Free text is still agent-forgeable, but it raises friction and produces a real logged artifact.
- If destination local hour is in [21:00, 08:00) **or offset is unknown**: reject unless `after_hours_confirmation` is a non-empty string (min 5 chars after trim), with a message containing destination local time (or "timezone unverified") + "confirm with your human that they want to place this call now, then retry with after_hours_confirmation set to their words. By retrying you confirm the callee has consented to be called."
- The confirmation string is persisted verbatim to the dial ledger (below) next to `{ts, e164, call_id}`.
- `quietHoursReason()` becomes `afterHoursGateReason(offsetMinutes, confirmation, objective, now)` (objective needed for the collection carve-out, below).
- Offset coherence (confirmed in review): `make_call` reads the offset ONLY from the token payload (`makeCall.ts:115`, never re-derives); the ack retry reuses the same token within its 15-min TTL — no re-mint needed.
- **Lookup unblocking (required for this to work at all):** remove the lookup-time unknown-offset block at `lookup/index.ts:45-53` (and the `:99-101` fail-closed comment) — mint the token with `utc_offset_minutes: null` and let make_call's gate handle it. Today lookup returns `dial_token: null` for unknown offsets, so the flag would never be reachable on that path.
- **Route plumbing (required):** the MCP tools reach the server over HTTP and the zod schemas at `routes.ts:18-36` silently STRIP unknown keys — add `after_hours_confirmation: z.string().optional()` to `callSchema` and `callNumberSchema` or the field dies in transit and the agent loops on rejection.

#### Statutory exception: debt collection keeps a hard time gate

FDCPA 15 U.S.C. 1692c(a)(1) imposes the same 8am-9pm destination-local window on debt-collection calls — a NON-solicitation category the no-sell screen does not cover (Cal. Civ. Code 1788.17 extends it to first-party creditors). Note (implementation decision, 2026-07-01): the literal word "debt" was ALREADY in `OBJECTIVE_BLOCK_RE` pre-change and stays there — explicit debt-collection language remains banned outright at any hour (no loosening in this PR); the COLLECTION_RE day-hours gate covers the softer first-party receivables phrasings ("overdue invoice", "owes me money") that the outright ban never caught. So: new `COLLECTION_RE` (`owes?|overdue|past.?due|collect (a )?payment|pay (his|her|their|the|an?) (bill|invoice|balance)|money (he|she|they) owes?|\bdebt\b`) — objectives/behavior/context matching it are **day-hours-only with NO override**: `after_hours_confirmation` does not work, message cites the FDCPA window. Collection calls remain placeable 08:00-21:00 destination time. Quiet hours survives exactly where it is statutory, nowhere else.

### 2. Per-destination rate cap (anti-spam, anti-harassment-by-volume)

- Append-only dial ledger: one JSONL line per attempt, written at the moment the dial is committed (after all rails pass, before `voice.dial`): `{ts, e164, call_id: string|null, after_hours_confirmation?: string}` — no outcome field; rate caps count ATTEMPTS, and outcomes live in the platform. Location `~/.speko/calls/ledger.jsonl` (override: `SPEKO_GUARD_STATE_DIR` — also what tests inject). "Atomic append" = one `appendFileSync` (O_APPEND) call per line, never read-modify-write.
- Cap: max 3 dials to the same E.164 per rolling 60 min, 8 per rolling 24h (env: `SPEKO_MAX_CALLS_PER_NUMBER_HOUR`, `SPEKO_MAX_CALLS_PER_NUMBER_DAY`). Counts attempts including no-answer/failed — retry storms are the harassment vector.
- Rejection message states minutes until the window frees.
- Keying: the ledger keys on the verified token `payload.e164` — already normalized by both mint paths (`callNumber.ts:53`, `lookup/index.ts:102`), so formatting games don't rotate the key.
- Known residual (accepted, documented): the count-then-append decision is TOCTOU-racy across concurrent processes (`serializeCalls` is per-process), and the operator can delete the file. Bounded by the small cap; see threat model.

### 3. Do-not-call ledger (opt-out memory)

- `~/.speko/calls/dnc.jsonl`: `{e164, ts, source: "auto"|"manual", call_id?, phrase?}`.
- Checked as an early rail: DNC rejects before dial, regardless of hour, confirmation, or trust.
- **Normalization invariant:** ALL DNC writes (auto and CLI) and reads run the SAME E.164 normalizer (`.replace(/[^\d+]/g,"")` — the shared strip used by `callNumber.ts:53`/`lookup/index.ts:102`) before store/compare. `speko dnc add "+1 (415) 555-0142"` must block `+14155550142`.
- Auto-add at call finalize: scan **only role-attributed callee (non-agent) turns** — reuse `lib/transcript.ts` (`TURN_ROLE_KEYS`/`AGENT_ROLES`, export `findTurnList` if needed). When attribution is absent or transcript is null, SKIP auto-DNC (never scan full text — the agent saying "I'll take you off our list" must not self-DNC the number; rate caps still protect).
- Opt-out regex, aligned with the FCC per-se revocation keywords (47 CFR 64.1200(a)(10)): on callee turns match bare `stop|quit calling|cancel|opt out|unsubscribe|never (call|contact)|do( not|n't) call|don'?t call me|take (me|my (number|name)) off|remove (me|my number)|lose my number|stop (calling|contacting|bothering)`. Auto-detection is best-effort and English-only; the AUTHORITATIVE opt-out channel is `speko dnc add`.
- CLI: `speko dnc list|add <e164>|remove <e164>` — registers in `CLI_COMMANDS` (`mcp/src/cli/router.ts:6-17`) + the dispatch table (`mcp/src/index.ts:53-57`); new `mcp/src/cli/dnc.ts`; tests in `mcp/test/dnc.test.ts`. State-dir helper lives in `server/src/safety/guard.ts` and the CLI reuses it (the mcp build already bundles `../server`).

### 4. Harassment + impersonation screens; close the context hole

- New `HARASSMENT_BLOCK_RE` in `constants.ts` — intent-anchored to avoid false positives: `harass|prank(?:\s+(?:call|him|her|them|my))|threat(?:en)?|intimidat|revenge|get back at|stalk|(?:to|keep) annoy(?:ing)?|mess with (?:him|her|them|my)|wake (?:him|her|them) up|humiliat|embarrass|(?:repeatedly|repeated) call|call (?:\S+\s+){0,3}repeatedly|keep (?:calling|dialing|phoning)(?:\s+\S+)? until|call (?:him|her|them|it)? ?every \d+ ?(?:minutes|mins|hours)|scare (?:him|her|them|my)|teach (?:him|her|them|my \w+) a lesson`. Benign controls pinned in tests: "prank-supplies stock", "anything for annoying pests", "wake-up call reservation", "scary-movie tickets" must all pass.
- New `IMPERSONATION_BLOCK_RE` (review blocker — the single worst legal exposure for an AI dialer, and FCC 24-17 makes AI-voice impersonation maximally radioactive): `pretend (?:to be|you'?re|that)|impersonat|pose as|posing as|pretext|claim(?:ing)? to be|say (?:you'?re|i'?m|we'?re) (?:from|with|calling from)|(?:from|with) the (?:irs|fbi|ssa|social security|medicare|police|sheriff|court|government|immigration|ice)\b`. The AI disclosure asserts one identity; nothing may instruct a contradictory pretext. Accepted collateral: "impersonate a French accent" is blocked — fine.
- Both new REs + the existing `OBJECTIVE_BLOCK_RE` apply to `objective`, `behavior`, AND `context` (new `contextBlockedReason` in `objective.ts` — closes the unscreened-context bypass).
- Tighten cold-outreach terms in `OBJECTIVE_BLOCK_RE`: add `cold.?call|prospect(?:ing|s)?\s+(?:call|list|for)|lead.?gen|sales outreach` (NOT bare `outreach`/`prospect` — "Prospect Park venue" and "community outreach room" must pass; pinned as benign controls).
- Stated plainly in SKILL.md: the keyword screens are best-effort; paraphrase will slip them. The rate cap and DNC are the real volume/opt-out controls.

### 5. Trusted numbers (zero-friction smoke tests)

- `SPEKO_TRUSTED_NUMBERS` (comma-separated E.164; each entry run through the same `/[^\d+]/g` normalizer at config load, so formatted entries work): exempt from after-hours confirmation AND rate caps. NOT exempt from DNC, harassment/impersonation screens, emergency/premium block, or disclosure. DNC overrides trust.
- Only numbers you OWN and consent to (your own smoke-test phones) belong here — a trusted number loses all volume and time-of-day protection. Env-only; no agent-writable path.

### New rails order

token → emergency/premium/E.164 → **DNC** → line-type → **rate cap** → **after-hours gate (with collection carve-out)** → objective screen → behavior screen → **context screen** (all three run OBJECTIVE + HARASSMENT + IMPERSONATION REs) → caller_name. Trusted-number check short-circuits only rate-cap + after-hours.

### What does NOT change

AI disclosure (non-removable), emergency/premium block, business-lines-only on make_call, dial-token flow, 300s cap, per-process call serialization, no-sell screen semantics.

## Legal grounding (cites web-verified 2026-07-01; treat as engineering posture, not legal advice)

- **Time-of-day rules:** 47 CFR 64.1200(c)(1) (8am-9pm) attaches to *telephone solicitations* only; 16 CFR 310.4(c) to *telemarketing* only — both verified against current text. State calling-hour statutes with stricter windows (FL/OK 8pm, RI 6pm, etc.) were checked and are all telephonic-SALES statutes. The no-solicitation screen is what keeps these calls outside every one of those rules — that is the affirmative case for removing the blanket gate. **Exception:** FDCPA 15 U.S.C. 1692c(a)(1) imposes 8am-9pm on debt-collection calls independent of solicitation status (Cal. Civ. Code 1788.17 reaches first-party creditors) — hence the collection carve-out in §1, the one place a hard time gate survives.
- **Artificial voice / consent:** FCC 24-17 (Feb 2024; persuasive rather than binding post-*McLaughlin v. McKesson*, 606 U.S. ___ (2025), but we design to it): AI-generated voice = "artificial voice" under 227(b). Artificial-voice calls to cell phones require prior express consent regardless of content (oral consent suffices for non-telemarketing). **The compliance anchor for 227(b) is the user's consent assertion** (call_number's "a number you have consent to call" contract + the after-hours message restating it) — NOT the no-sell screen, and NOT the rate caps (the no-consent residential exemption is 3 calls/30 days, far below our caps; we do not rely on it).
- **Identification:** 47 CFR 64.1200(b)(1)-(b)(2) requires artificial-voice calls to state the responsible entity at the start (the disclosure does this) AND provide its telephone number during/after the call — **nothing supplies a callback number today. Known PRE-EXISTING gap, explicitly out of scope here; file a follow-up** (optional `callback_number` input woven into the prompt's closing instruction).
- **Opt-out:** 47 CFR 64.1200(a)(10) (effective Apr 2025) makes bare "stop/quit/cancel/opt out/unsubscribe/revoke" per-se revocations that must be honored within 10 business days — the DNC ledger's instant, permanent honor beats that ceiling; the per-se keywords are folded into the §3 regex. (The "revoke-all-channels" scope portion was delayed to Jan 2027; not relevant to a single-channel dialer.)
- **Harassment:** 47 U.S.C. 223(a)(1)(C)-(E) (interstate/foreign calls) + state analogs for intrastate, e.g. Cal. Penal Code 653m — time-of-day independent; addressed by the rate cap, DNC, and harassment screen, which map to the statute in a way quiet hours never did.

## Acceptance criteria

1. Call to a quiet-hours destination without `after_hours_confirmation` → rejected; message contains destination local time, the retry instruction, and the consent restatement. With a non-empty confirmation → dials, and the confirmation string appears verbatim in `ledger.jsonl` for that call. Never a dead-end block (except collection, #3).
2. Unknown-offset number: `lookup_business` now MINTS a token (`utc_offset_minutes: null`, no `dial_token: null` refusal); `make_call` requires the confirmation with a "timezone unverified" message. `agentProvidedLookup.test.ts:203-211` updated to pin the new behavior.
3. Collection-flavored objective ("his invoice is 60 days overdue, get him to pay") at 22:00 destination → rejected citing the FDCPA window, and `after_hours_confirmation` does NOT unlock it; same call at 14:00 → dials.
4. `after_hours_confirmation` survives the HTTP route layer (integration test through `routes.ts` schemas — not just direct `makeCall()` calls).
5. Trusted number dials at any hour with no confirmation; rate caps skipped; DNC still blocks it.
6. 4th dial to one number within 60 min → rejected with minutes-to-free; 9th within 24h → rejected. Ledger keys on normalized token e164.
7. DNC number → rejected before dial regardless of hour/confirmation/trust. `speko dnc add` with a formatted number ("+1 (415) 555-0142") blocks the normalized form.
8. Transcript whose CALLEE turn contains a per-se revocation ("stop", "take me off your list", "lose my number") → auto-appended to dnc.jsonl with call_id + phrase (= the exact first regex match, trimmed to 80 chars); next call blocked. An AGENT turn "I'll take you off our list" does NOT trigger; unattributed/null transcript → no auto-DNC.
9. Harassment intents rejected on objective, behavior, and context ("prank my roommate", "keep dialing until she answers", "call him every 10 minutes tonight", "teach my neighbor a lesson"). Benign controls pass ("prank-supplies stock", "annoying pests", "wake-up call reservation", "scary-movie tickets").
10. Impersonation intents rejected on all three channels ("pretend to be her bank", "say you're calling from the IRS", "pose as a customer").
11. `context` rejects no-sell intents (bypass closed; regression test).
12. All existing green rails tests still pass (emergency, premium, mobile, token, no-sell objective/behavior, clean-call control).
13. No stale quiet-hours copy: `rg -in "quiet"` (WITHOUT `--no-ignore` — dist/ is stale build output) returns only the allowlist: conversational-silence copy in `prompt.ts` + `scripts/call-en.mjs`, this spec, and changelog history. Both SKILL.md copies, READMEs, tool descriptions, init wizard updated.
14. `npm run typecheck` + `vitest run` green in server/ and mcp/. Versions: mcp 0.4.9 → 0.5.0, server 0.1.0 → 0.2.0 **including the `VERSION` const at `constants.ts:8`**.

## Testing plan

| Layer | What | Count |
|-------|------|-------|
| Unit | `afterHoursGateReason`: quiet/day/unknown-offset/confirmation/trusted/collection-carve-out | +8 |
| Unit | guard ledger: rate windows, normalization keying, atomic append, `SPEKO_GUARD_STATE_DIR` override | +8 |
| Unit | DNC: add/check/normalize round-trip; auto-opt-out per-se keywords; agent-turn negative; null-transcript skip | +8 |
| Unit | `HARASSMENT_BLOCK_RE` + `IMPERSONATION_BLOCK_RE` + `contextBlockedReason`: hits + all benign controls above | +12 |
| Integration | makeCallRails: new rails order, each rail rejects before dial, trusted path, route-schema flag survival | +12 (modify `makeCallRails.test.ts:84,95`; rewrite `dialToken.test.ts:72-81` quiet-hours describe; update `agentProvidedLookup.test.ts:129,203-211`; touch `callNumber.test.ts:17` comment) |
| CLI | `speko dnc` list/add/remove incl. formatted-number normalization | +5 |

Rails tests keep the existing pattern: `dialSpy()` + `deps(client)` with cast AppConfig (`makeCallRails.test.ts:23-40`, `helpers/fakePlatform.ts`); the guard rail takes its state dir from injected config/env.

## Rollback

Revert the PR; `npm publish` the previous mcp version (0.4.9 stays on npm). State files under `~/.speko/calls/` are inert without the code. No migrations, no platform coupling.

## Effort

~0.5-1 day via the Codex implement→review loop: guard.ts ~180 LOC, gate + lookup unblock + route plumbing ~120, screens ~60, tool schemas ~40, CLI ~90, docs/copy sweep ~80, tests ~350. Bek review ~30 min.

## Files reference

| File | Change |
|------|--------|
| `server/src/constants.ts:8,123-132` | VERSION bump; +HARASSMENT/IMPERSONATION/COLLECTION REs; cold-outreach terms; quiet-hours consts → after-hours consts; rate-cap defaults |
| `server/src/safety/dialToken.ts:179-195` | `quietHoursReason` → `afterHoursGateReason(offset, confirmation, objective, now)` |
| `server/src/safety/objective.ts` | +`contextBlockedReason`; all three REs in all three screens |
| `server/src/safety/guard.ts` (new) | ledger, rate cap, DNC store/check, trusted-numbers, opt-out scan, state-dir resolution |
| `server/src/calls/makeCall.ts:108-146,203,509-585` | new rails order; screen context; ledger append at dial; finalize opt-out scan via `lib/transcript.ts` |
| `server/src/calls/callNumber.ts` | plumb `after_hours_confirmation` (pass-through; offset/token flow unchanged) |
| `server/src/lookup/index.ts:45-53,99-101` | REMOVE lookup-time unknown-offset block; mint with null offset |
| `server/src/lookup/demo.ts:43-44` | comment update |
| `server/src/routes.ts:18-36,95` | +`after_hours_confirmation` in callSchema + callNumberSchema; comment update |
| `server/src/config.ts:93` | +SPEKO_TRUSTED_NUMBERS, +SPEKO_GUARD_STATE_DIR, +rate-cap envs; fix stale comment |
| `server/src/safety/timezone.ts:1-13` | header comment (no longer "fails closed → blocks") |
| `server/src/lib/transcript.ts` | export `findTurnList` (or equivalent) for the opt-out scan |
| `mcp/src/tools/MakeCallTool.ts`, `CallNumberTool.ts` | +`after_hours_confirmation` param ("set ONLY to the human's own words after they explicitly confirm") ; drop stale quiet-hours copy |
| `mcp/src/tools/LookupBusinessTool.ts:21` | utc_offset_minutes description: quiet-hours → after-hours-gate wording |
| `mcp/src/cli/dnc.ts` (new), `mcp/src/cli/router.ts:6-17`, `mcp/src/index.ts:53-57` | `speko dnc` subcommand |
| `mcp/src/cli/init.ts:226` | wizard copy: quiet-hours line → guardrails line |
| `mcp/skills/speko-calls/SKILL.md:8,71` + `~/.claude/skills/speko-calls/SKILL.md:8,70` | rails section rewrite (incl. consent-anchor + best-effort-screen language) |
| `README.md:19,38,111`, `mcp/README.md:58` | copy sweep |
| `scripts/call-number.mjs:34`, `scripts/place-call.mjs:35` | rejection-list comments (scripts hit the same server rails — no code change) |
| `docs/future-agentic-business-discovery.md:22` | copy sweep |
| `mcp/package.json:3` / `server/package.json` | 0.5.0 / 0.2.0 |
| `server/test/*`, `mcp/test/dnc.test.ts` | per testing plan |

## Out of scope

- Platform (`spekoai/platform`) dialer changes; scheduler-dashboard outbound harness; benchmarks.
- `callback_number` for 47 CFR 64.1200(b)(2) — pre-existing gap, separate follow-up issue.
- call_me v2 (verified personal phone on platform).
- Carrier-level compliance (Telnyx 10DLC etc.); any UI; non-English opt-out detection.

## Alternatives considered

- **Pure deletion of the time check** (no confirmation gate): loses the audit trail, the consent restatement, and the FDCPA carve-out hook; rejected — the gate costs one retry in the rare late-night case and is the always-available override that was missing.
- **Boolean `after_hours_ok`**: rejected in red-team review — a free-to-flip boolean is not an audit trail; the human's own words are.
- **Env flag to disable quiet hours** (`SPEKO_QUIET_HOURS=off`): keeps the blunt filter as the default control and solves one machine; rejected — the filter itself is the wrong control.
