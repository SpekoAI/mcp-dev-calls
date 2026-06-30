---
name: speko-calls
description: >-
  Use when the user wants to place a REAL outbound phone call via the Speko Calls MCP — e.g.
  "call <place> and ask <question>", "find the best <X> near me and call them", book a
  reservation, check hours/availability/pricing, or place/chase an order. Covers calling a
  number you have or found via web search (call_number) and Speko's verified business lookup
  (lookup_business → make_call), the mandatory AI disclosure, the quiet-hours + no-spam rails,
  and reporting the call OUTCOME honestly.
---

# Speko Calls — placing real, disclosed phone calls

The Speko Calls MCP places **real, disclosed** outbound phone calls and returns the result as
text. Every call opens with a non-removable AI disclosure — the callee hears
*"Hey! Quick heads up — I'm \<your-name\>'s AI assistant, \<your-name\> asked me to give you a
call…"* before anything else.

There are **two ways to dial**:
- **`call_number`** — dial a number you already have, or one you found via web search. Works
  with just the user's Speko key, no extra setup. **This is the hero path for "find a place and
  call it."**
- **`lookup_business` → `make_call`** — let Speko find the business in a directory and
  carrier-verify it's a real business line, then dial. Use when you want that verification (the
  server must have directory/carrier keys configured).

## Find the number yourself (the hero flow)
When the user names a *kind* of place ("the best taco spot in the Bay Area"), don't ask them
for a number — find it and call it:
1. **Web-search** for the specific business; read its official site/listing for the phone
   number and city.
2. **`call_number(phone_number=<E.164>, objective, caller_name, utc_offset_minutes?)`** places
   the disclosed call. Pass `utc_offset_minutes` if the region isn't auto-recognized — you know
   the city from your search (e.g. `-480` Bay Area / US Pacific, `-300` US Eastern, `0` UK).
3. **Confirm the pick + objective with the user before dialing** — a call is a real-world action.

Example: *"find the best taco place in the Bay Area and ask if they're open and have carnitas"*
→ search → `call_number(...)` → relay the `OUTCOME`.

## Writing the objective
One plain, transactional goal in everyday words:
- **reservation:** *"Ask if there's a table for 4 at 8pm tonight and book it under John."*
- **order:** *"Order 2 carnitas tacos and a Coke Zero for pickup, and ask when it'll be ready."*
- **info:** *"Ask if they're open now and how long the wait is for a table for 2."*

Pass the user's name as `caller_name` (the disclosure says *"I'm \<caller_name\>'s AI assistant"*).
Avoid words the no-spam screen refuses — *sell, promote, discount, deal, survey, donate,
fundraise, campaign, marketing, advertise.* Just say it plainly ("order…", "ask if…", "book…").

## The verified directory path — `lookup_business` → `make_call`
1. **`check_call_readiness()`** — read-only preflight (auth, credit, outbound caller-ID). Run
   first if unsure the account can dial. Never dials.
2. **`lookup_business(name, location?, phone_number?, utc_offset_minutes?)`** — resolves the
   business to candidates, each with a **signed, single-use `dial_token`** (the only thing that
   can authorize `make_call`). Needs the server's directory/carrier keys; without them, use
   `call_number` with a number you found instead.
3. **`make_call(dial_token, objective, caller_name, context?)`** — places the disclosed call,
   waits while it rings, and returns the `OUTCOME:` line + transcript.

## The rails (enforced server-side — you cannot override them)
- **AI disclosure** — hard-coded; cannot be removed or reworded.
- **Transactional objectives only** — reservations, availability, hours, pricing, orders.
  **Refused:** selling, promotion, surveys, fundraising, political campaigning.
- **Quiet hours** — 08:00–21:00 in the destination's local time; calls outside are rejected
  (fail-closed if the timezone is unknown — pass `utc_offset_minutes`).
- **Business-line verification** applies on the `lookup_business` path (mobiles blocked there).

If an objective trips a rail, the tool returns a rejection with a reason. Fix the objective (or
pass `utc_offset_minutes`) and retry, or tell the user it isn't allowed.

## Reading the result — honestly
- `connected` / `answered` are reported truthfully. If the platform never put a real call on
  the wire, it returns **`not_connected`** — do **not** report that as success; run
  `check_call_readiness` and tell the user the deployment's outbound trunk/caller-ID may need setup.
- The `OUTCOME:` line is the answer (e.g. *"table for 4 at 8pm, booked under John"*). Relay it
  plainly and offer the transcript.

## Don't
- Don't invent or guess phone numbers — only dial a number the user gave you or one you found
  from the business's own official listing.
- Don't retry after a pre-dial rejection without fixing the objective/timezone first.
- Don't promise a call will connect — report what actually happened.
