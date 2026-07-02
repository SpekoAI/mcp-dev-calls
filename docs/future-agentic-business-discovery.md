# Future: Agentic Business Discovery (drop Google Places)

> **Status:** PROPOSAL / roadmap — **not implemented.** Captured 2026-06-27. Not part of the launch demo.

## The idea

Today `lookup_business` resolves a business name → phone number via the **Google Places API**
(in the demo server), runs a **carrier line-type check**, and mints a signed `dial_token`.
That needs `GOOGLE_PLACES_API_KEY` (+ Twilio for line type).

But this MCP runs inside a coding agent that **already has web search** (Claude Code's
`WebSearch`/`WebFetch`). So move **discovery** to the agent: let it find the business's
official number itself, and have the server only **verify + authorize**. This removes the
Google Places dependency and works for any business the open web knows about.

## Key principle: discovery ≠ authorization

Split the two responsibilities cleanly:

- **Discovery → moves to the agent:** find a candidate business name + phone number via web search.
- **Authorization + safety → stays server-side, unchanged:** validate E.164, run the
  **carrier line-type check (business-lines-only)**, apply abuse guardrails (screens, DNC,
  rate caps, after-hours confirmation), and mint the HMAC `dial_token`.

⚠️ **Web search will NOT tell you whether a number is a mobile or a landline.** So the
**line-type check is non-negotiable and must remain** — it's the legal/compliance moat
(FCC 24-17). The agent *proposes* a number; the server *disposes* (gates every call).

## Proposed flow

1. User: *"Call Sakura Sushi in SF and ask about a table for 4 at 8pm."*
2. Agent web-searches → finds the official number from the restaurant's site / a directory → `+1…`.
3. Agent calls `lookup_business(name="Sakura Sushi", location="San Francisco", phone_number="+1…")`.
4. Server (no Places call): validates the number → **line-type check** → confirms it's a business
   line → mints a `dial_token`. Rejects mobiles / emergency / premium.
5. `make_call(dial_token, …)` exactly as today. The AI also **confirms the business name on the
   call** (*"Hi, is this Sakura Sushi?"*) as a second guard against a wrong number.

## Changes required

- **`lookup_business`**: accept an optional agent-provided `phone_number`. If present → skip Places,
  go straight to validate → line-type → mint. If absent → fall back to Places (when configured),
  or return guidance telling the agent to web-search and retry with a number.
- **`SKILL.md`**: instruct the agent — *"Prefer finding the business's official phone number via
  web search and passing it as `phone_number` (E.164); cite your source. Fall back to name +
  location only if you can't find a number."*
- **Optional user-confirmation step**: surface the resolved business + number + source before
  dialing (*"About to call Sakura Sushi at +1… (found on sakurasushisf.com) — proceed?"*). Good for
  trust and catches a wrong number before it rings.
- **Keep a carrier line-type provider** (Twilio Lookup, or an equivalent) — required.

## Tradeoffs

**Pros:** no Google Places key; works for any web-discoverable business; more agentic; the agent can
cite its source; cheaper.

**Cons / risks:** web results can be wrong, outdated, or spoofed → mitigated by (a) the line-type
check, (b) the on-call name confirmation, (c) the optional pre-dial user confirmation; the agent
must actually have a web-search tool; international / edge numbers need care.

## Open questions

- Which line-type provider once Places is gone (keep Twilio Lookup?).
- Require explicit user confirmation of the number before dialing, or trust + verify-on-call?
- Businesses with multiple/region numbers, IVRs, franchise lines.
- Anti-abuse: an agent-provided number widens the input surface — keep the `dial_token` + all rails
  as the choke point; **never let a raw number reach `make_call`** without going through the
  verify-and-mint path.

## Non-goals (for now)

- Not in the launch demo.
- Do **not** remove the line-type / safety rails — only the *discovery* mechanism changes.
