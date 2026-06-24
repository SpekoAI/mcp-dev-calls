---
name: speko-calls
description: >-
  Use when the user wants to place a REAL outbound phone call to a BUSINESS via the
  Speko Calls MCP — e.g. "call <place> and ask <question>", book a reservation, check
  hours/availability/pricing, or chase an order. Teaches the lookup → dial_token →
  make_call workflow, the mandatory AI disclosure, the business-lines-only + quiet-hours
  rails, and how to report the call OUTCOME honestly. Not for personal/consumer calls.
disable-model-invocation: true
---

# Speko Calls — placing real, disclosed business calls

The Speko Calls MCP places **real, disclosed** outbound phone calls to **businesses** and
returns the result as text. Every call opens with a non-removable AI disclosure
(*"Hi, this is an AI assistant calling on behalf of …"*). You drive it through three tools
and **never dial a raw number directly**.

## Workflow — always in this order
1. **`check_call_readiness()`** — read-only preflight (auth, credit balance, outbound
   caller-ID). Run first if unsure the account can dial. Never dials.
2. **`lookup_business(name, location?)`** — resolves the business to dialable candidates,
   each with a **signed, single-use `dial_token`**. This is the ONLY thing that can
   authorize a call.
3. **`make_call(dial_token, objective, caller_name, context?)`** — places the disclosed
   call, waits while it rings, returns the `OUTCOME:` line + transcript.

`make_call` is impossible without a fresh `dial_token` from `lookup_business`. There is no
way to pass a raw phone number — that's a safety boundary, not a limitation.

## Before dialing — confirm with the human
- **Confirm the business and the objective with the user.** A call is a real-world action.
- Pass the user's name as `caller_name` (the disclosure says "on behalf of `<caller_name>`").
- Write `objective` as ONE clear transactional goal:
  *"Ask if there's a table for 4 at 8pm tonight and book it under Amirlan."*

## The rails (enforced server-side — you cannot override them)
- **Business lines only** — mobiles are blocked (carrier line-type check).
- **Transactional objectives only** — reservations, availability, hours, pricing, order
  status. **Refused:** selling, promotion, surveys, fundraising, political campaigning.
- **Quiet hours** — 08:00–21:00 in the destination's local time (fail-closed if unknown).
- **AI disclosure** — hard-coded; cannot be removed or reworded.

If an objective trips a rail, `make_call` returns a rejection with a reason. Rewrite the
objective as a single transactional question and retry, or tell the user it isn't allowed.

## Reading the result — honestly
- `connected` / `answered` are reported truthfully. If the platform never put a real call
  on the wire (no telephony leg), it returns **`not_connected`** — do **not** report that
  as success. Run `check_call_readiness` and tell the user the deployment's outbound
  trunk / caller-ID may need setup.
- The `OUTCOME:` line is the answer (e.g. *"table for 4 at 8pm, booked under Amirlan"*).
  Relay it plainly and offer the transcript.

## Don't
- Don't invent or hardcode phone numbers — only server-minted `dial_token`s dial.
- Don't retry after a pre-dial rejection without fixing the objective first.
- Don't promise a call will connect — report what actually happened.
