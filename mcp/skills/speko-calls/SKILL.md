---
name: speko-calls
description: >-
  Use when the user wants to place a REAL outbound phone call via the Speko Calls MCP — e.g.
  "call <place> and ask <question>", "find the best <X> near me and call them", book a
  reservation, check hours/availability/pricing, or place/chase an order. Covers calling a
  number you have or found via web search (call_number) and Speko's verified business lookup
  (lookup_business → make_call), the mandatory AI disclosure, the anti-abuse guardrails,
  and reporting the call OUTCOME honestly.
---

# Speko Calls — placing real, disclosed phone calls

The Speko Calls MCP places **real, disclosed** outbound phone calls and returns the result as
text. Every call opens with a non-removable AI disclosure — the callee hears
*"Hi, I'm \<your-name\>'s AI assistant and \<your-name\> asked me to …"* before anything else.

There are **two ways to dial**:
- **`call_number`** — dial a number you already have, or one you found via web search. Works
  with just the user's Speko key, no extra setup. **This is the hero path for "find a place and
  call it."**
- **`lookup_business` → `make_call`** — let Speko find the business in a directory and
  carrier-verify it's a real business line, then dial. Use when you want that verification (the
  server must have directory/carrier keys configured).

## Find the number yourself (the hero flow)
When the user names a *kind* of place ("the best taco spot in the Bay Area"), don't ask them
for a number — find it and call it. **Be decisive — don't stall the user with options.**
1. **Web-search** and pick the SINGLE best match; don't make the user choose from a list. Read
   its official site/listing for the full phone number and its city.
2. **`call_number(phone_number=<+E.164>, objective, caller_name)`** places the disclosed call.
   Use a full international number with a leading `+` and country code (`+14152857117`, not
   `(415) 285-7117`). The destination timezone auto-derives from common area codes; if the tool
   says it couldn't determine the timezone (an unusual area code, or a toll-free
   800/888/877/866 number), re-run with `utc_offset_minutes` for the business's city
   (US Pacific is `-420` in summer / `-480` in winter, US Eastern `-240`/`-300`, UK `+60`/`0`).
3. One quick inline confirm ("calling La Taqueria, +1 415-285-7117, to ask if they have carnitas
   — go?"), then dial. A call is a real-world action, so keep the gate to a single yes/no.

Example: *"find the best taco place in the Bay Area and ask if they're open and have carnitas"*
→ search → pick La Taqueria → `call_number(...)` → relay the `OUTCOME`.

## Writing the objective
The objective is the ask, not a script: the server composes the spoken opening line and adds the
AI disclosure itself, so never start it with a greeting or self-introduction ("Hi! I'm calling
to...") - write what to accomplish. One plain, transactional goal in everyday words:
- **reservation:** *"Ask if there's a table for 4 at 8pm tonight and book it under John."*
- **order:** *"Order 2 carnitas tacos and a Coke Zero for pickup, and ask when it'll be ready."*
- **info:** *"Ask if they're open now and how long the wait is for a table for 2."*

Pass the user's name as `caller_name` (the disclosure says *"I'm \<caller_name\>'s AI assistant"*).
Avoid words the no-spam screen refuses — they match as substrings (e.g. "promot" catches
"promotion"): *sell, sales pitch, promote, discount, sponsor, advertise, marketing, survey,
donate, fundraise, vote, campaign, debt, warranty, crypto, investment.* Just say it plainly
("order…", "ask if…", "book…", "check the price of…"). ("deal" is fine.)

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
- **Consent anchor** — only call numbers the human has consent to call. The screens are
  best-effort keyword filters; rate caps and the DNC list are the real volume/opt-out controls.
- **AI disclosure** — hard-coded; cannot be removed or reworded.
- **No-sell/no-spam + harassment + impersonation screens** — applied to `objective`,
  `behavior`, and `context`. Keep the task transactional: reservations, availability, hours,
  pricing, orders. Refused: selling, promotion, surveys, fundraising, political campaigning,
  harassment/pranks/repeated dialing, and instructions to pose as someone else.
- **Per-number rate caps** — defaults are 3 calls/hour and 8 calls/day to the same number.
- **Local do-not-call list** — honored before dialing; callee opt-outs are auto-detected when
  possible. Manage it with `speko dnc list`, `speko dnc add <e164>`, and
  `speko dnc remove <e164>`.
- **After-hours confirmation gate** — the normal window is 08:00–21:00 destination-local.
  Outside that window, or when the timezone is unknown, you MUST ask the human first, then retry
  with `after_hours_confirmation` set to the human's own words. By passing it, you confirm the
  callee has consented to be called.
- **Collection-flavored calls** — day-hours-only with NO override (FDCPA).
- **Trusted numbers** — numbers in `SPEKO_TRUSTED_NUMBERS` skip time and volume friction only;
  DNC, disclosure, emergency/premium blocks, and abuse screens still apply.
- **Business-line verification** applies on the `lookup_business` path (mobiles blocked there).

If an objective trips a rail, the tool returns a rejection with a reason. Fix the objective (or
follow the retry instruction) and retry, or tell the user it isn't allowed.

## Reading the result — honestly
- `connected` / `answered` are reported truthfully. If the platform never put a real call on
  the wire, it returns **`not_connected`** — do **not** report that as success; run
  `check_call_readiness` and tell the user the deployment's outbound trunk/caller-ID may need setup.
- The `OUTCOME:` line is the answer (e.g. *"table for 4 at 8pm, booked under John"*). Relay it
  plainly and offer the transcript.

## Don't
- Don't invent or guess phone numbers — only dial a number the user gave you or one you found
  from the business's own official listing.
- Don't retry after a pre-dial rejection without fixing the objective or following the stated
  confirmation/removal path first.
- Don't promise a call will connect — report what actually happened.
