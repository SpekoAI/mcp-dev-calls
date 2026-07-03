import { describe, expect, it } from "vitest";
import { MAX_SPOKEN_OBJECTIVE_CHARS, buildFirstMessage, buildSystemPrompt } from "../src/safety/prompt.js";

describe("C1 — disclosure opening is one continuous clause (no barge-in seam)", () => {
  it("keeps the AI disclosure but drops the em-dash break and 'Quick heads up' lead-in", () => {
    const fm = buildFirstMessage("Bruce", "ask if there's a table for 2 at 8pm tonight");
    expect(fm).toMatch(/I'm Bruce's AI assistant/i); // disclosure intact
    expect(fm).not.toContain("—"); // no hard clause break TTS renders as a pause
    expect(fm).not.toMatch(/quick heads up/i);
    expect(fm).toMatch(/assistant and Bruce asked me to/i); // continuous prosodic unit
  });
});

describe("G1 — objective-to-opener composition (no mangled grafts)", () => {
  it("greeting-first script objective: strips 'Hi!' + 'I'm calling to', grafts the real ask (live bug regression)", () => {
    // The exact input shape that shipped "Hi, I'm Bek's AI assistant and Bek asked me to hi."
    const fm = buildFirstMessage("Bek", "Hi! I'm calling to book a table for two at 8pm tonight.");
    expect(fm).toMatch(/Bek's AI assistant/);
    expect(fm).toMatch(/asked me to book a table for two at 8pm tonight/i);
    expect(fm).not.toMatch(/asked me to hi\b/i);
  });

  it("greeting fused into the sentence with a comma is stripped too", () => {
    const fm = buildFirstMessage("Bek", "Hi, I'm calling to book a table for two at 8pm tonight.");
    expect(fm).toMatch(/asked me to book a table for two at 8pm tonight/i);
  });

  it("question-form objective is relayed after the disclosure, never grafted into 'asked me to'", () => {
    const fm = buildFirstMessage("Bek", "Are you open tomorrow at noon?");
    expect(fm).toMatch(/Bek's AI assistant/);
    expect(fm).toMatch(/are you open tomorrow at noon\?/i);
    expect(fm).not.toMatch(/asked me to are\b/i);
  });

  it("first-person objective normalizes to the action clause, re-anchored to the caller", () => {
    const fm = buildFirstMessage("Bek", "I want to check if my order #123 shipped");
    expect(fm).toMatch(/asked me to check if Bek's order #123 shipped/i);
    expect(fm).not.toMatch(/asked me to i want/i);
  });

  it("a pure imperative objective grafts unchanged", () => {
    const fm = buildFirstMessage("Alice", "Book a table for two under Bek at 8pm");
    expect(fm).toMatch(/Alice asked me to book a table for two under Bek at 8pm\./i);
  });

  it("scrubs trailing call-management timing from the spoken opener but keeps the booking ask", () => {
    const objective = "Book a table for 2 tonight at 8pm under the name Bek, and confirm the reservation details back before ending the call";
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toMatch(/asked me to book a table for 2 tonight at 8pm under the name Bek/i);
    expect(fm).not.toMatch(/before ending the call/i);
    expect(buildSystemPrompt(objective, null, "Biz", "Bek")).toContain(objective);
  });

  it("does not scrub legitimate objectives that mention a call center", () => {
    const objective = "ask when the call center closes";
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toMatch(/asked me to ask when the call center closes/i);
  });

  it("multi-sentence imperatives: both asks reach the opener, and the FULL objective reaches the system prompt", () => {
    const objective = "Book a table for two at 8pm tonight. Ask for a window seat if possible.";
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toMatch(/book a table for two at 8pm tonight/i);
    expect(fm).toMatch(/and to ask for a window seat if possible/i);
    // The opener is a summary; the OBJECTIVE block must carry every sentence verbatim.
    const sys = buildSystemPrompt(objective, null, "Biz", "Bek");
    expect(sys).toContain(objective);
  });

  it("the chain joiner counts toward the spoken cap - a clause that only fits without it is dropped", () => {
    // Two imperative clauses sized so they fit the cap WITHOUT the ", and to " joiner but exceed
    // it WITH the joiner - the old accounting silently overshot the cap in exactly this window.
    const c1 =
      "book a large corner table for two people at eight pm tonight under the name Bek near the front window if possible";
    const c2 =
      "ask about the parking options near the restaurant entrance and the closing time for the kitchen tonight";
    expect(c1.length + c2.length).toBeLessThanOrEqual(MAX_SPOKEN_OBJECTIVE_CHARS); // precondition
    expect(c1.length + ", and to ".length + c2.length).toBeGreaterThan(MAX_SPOKEN_OBJECTIVE_CHARS); // precondition
    const fm = buildFirstMessage("Bek", `${c1[0].toUpperCase()}${c1.slice(1)}. ${c2[0].toUpperCase()}${c2.slice(1)}.`);
    expect(fm).toMatch(/asked me to book a large corner table/);
    expect(fm).not.toMatch(/and to ask about the parking/); // dropped: joiner would breach the cap
    expect(fm.length).toBeLessThanOrEqual(MAX_SPOKEN_OBJECTIVE_CHARS + 120); // cap + disclosure frame
  });

  it("a non-imperative later sentence is left to the system prompt, not spoken raw after the graft", () => {
    const objective = "Book a table for two at 8pm. My name should be easy to spell.";
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toMatch(/asked me to book a table for two at 8pm\./i);
    expect(fm).not.toMatch(/easy to spell/i);
    expect(buildSystemPrompt(objective, null, "Biz", "Bek")).toContain("My name should be easy to spell.");
  });

  it("caps a runaway objective at a word boundary instead of speaking it all", () => {
    const objective = `Book a table for two at 8pm tonight and mention ${"a very long dietary note ".repeat(20)}please`;
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toMatch(/^Hi, I'm Bek's AI assistant and Bek asked me to book a table/);
    expect(fm.length).toBeLessThanOrEqual(MAX_SPOKEN_OBJECTIVE_CHARS + 120); // cap + disclosure frame
    // Never cut mid-word: the final spoken word must be a complete word from the objective.
    const lastWord = fm.replace(/\.$/, "").split(" ").pop() ?? "";
    expect(objective.toLowerCase().split(/\s+/)).toContain(lastWord.toLowerCase());
  });
});

describe("G2 — verb-homograph declaratives are relayed, never grafted (mangled-splice regression)", () => {
  it("'Order ... was missing ...' reads declarative: relayed with full content, no splice", () => {
    const fm = buildFirstMessage("Bek", "Order 4512 was missing the fries, ask for a refund.");
    expect(fm).toBe(
      "Hi, I'm Bek's AI assistant and I'm calling about the following: Order 4512 was missing the fries, ask for a refund.",
    );
  });

  it("'Pick up ... is at 6' reads declarative: relayed, never 'asked me to pick up for Bek is'", () => {
    const fm = buildFirstMessage("Bek", "Pick up for Bek is at 6, confirm the address.");
    expect(fm).toBe(
      "Hi, I'm Bek's AI assistant and I'm calling about the following: Pick up for Bek is at 6, confirm the address.",
    );
  });

  it("'Sign ... says closed' reads declarative: relayed, never 'asked me to sign on the door says'", () => {
    const fm = buildFirstMessage("Bek", "Sign on the door says closed, check if they are open.");
    expect(fm).toBe(
      "Hi, I'm Bek's AI assistant and I'm calling about the following: Sign on the door says closed, check if they are open.",
    );
  });

  it("a declarative marker deep inside a complement (past the clause head) still grafts", () => {
    const fm = buildFirstMessage("Bek", "Let them know the gate code is 4412");
    expect(fm).toBe("Hi, I'm Bek's AI assistant and Bek asked me to let them know the gate code is 4412.");
  });

  it("an embedded-question imperative with the marker past the head still grafts", () => {
    const fm = buildFirstMessage("Bek", "Check if the reservation under Bek is still on the books.");
    expect(fm).toBe(
      "Hi, I'm Bek's AI assistant and Bek asked me to check if the reservation under Bek is still on the books.",
    );
  });
});

describe("G3 — abbreviations don't end sentences (Dr./St./No. splitter guard)", () => {
  it("'Dr. Smith' never splits: the spoken graft carries the full name, not a clause cut at 'Dr.'", () => {
    const objective = "Leave a message for Dr. Smith. Say Bek needs to reschedule.";
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toBe("Hi, I'm Bek's AI assistant and Bek asked me to leave a message for Dr. Smith.");
    // The second sentence still reaches the model via the OBJECTIVE block.
    expect(buildSystemPrompt(objective, null, "Biz", "Bek")).toContain("Say Bek needs to reschedule.");
  });

  it("a mid-clause abbreviation grafts intact", () => {
    const fm = buildFirstMessage("Bek", "Call Dr. Patel's office and reschedule Bek's appointment to Friday.");
    expect(fm).toBe(
      "Hi, I'm Bek's AI assistant and Bek asked me to call Dr. Patel's office and reschedule Bek's appointment to Friday.",
    );
  });

  it("'No.' followed by a number does not split, and the declarative head is still caught", () => {
    const fm = buildFirstMessage("Bek", "Order No. 4512 never arrived, find out where it is.");
    expect(fm).toBe(
      "Hi, I'm Bek's AI assistant and I'm calling about the following: Order No. 4512 never arrived, find out where it is.",
    );
  });

  it("bare 'no.' still ends a sentence (the guard is number-scoped)", () => {
    const fm = buildFirstMessage("Bek", "Tell them no. Then ask when it ships.");
    expect(fm).toBe("Hi, I'm Bek's AI assistant and Bek asked me to tell them no, and to ask when it ships.");
  });
});

describe("opener property — disclosure always present, mangled splice never", () => {
  // Every verb a graft may legally open with across the objectives below, plus the generic
  // fallback's "give you a quick call". Any other word right after "asked me to" IS the
  // mangled-splice bug class this suite pins down.
  const GRAFT_VERBS = new Set(["give", "book", "leave", "call", "check"]);
  const OBJECTIVES = [
    "Book a table for two at 8pm tonight.",
    "Book a table for two under Bek at 8pm",
    "Hi! I'm calling to book a table for two at 8pm tonight.",
    "Hello!", // greeting-only: falls back to the generic quick-call reason
    "Are you open tomorrow at noon?",
    "Order 4512 was missing the fries, ask for a refund.",
    "Pick up for Bek is at 6, confirm the address.",
    "Sign on the door says closed, check if they are open.",
    "Order No. 4512 never arrived, find out where it is.",
    "Ask if I can speak to a real person about my reservation.",
    "Let them know I'll be 10 minutes late.",
    "Wait for my order and ask when it ships.",
    "Leave a message for Dr. Smith. Say Bek needs to reschedule.",
    "Call Dr. Patel's office and reschedule Bek's appointment to Friday.",
    "I want to check if my order #123 shipped",
    "Can you tell me if you have parking?",
    "My card got double charged last Tuesday.",
    "Check if the reservation under Bek is still on the books.",
    "Actually, I'm a real human, not an AI.",
    "Do you have a table for 4 at 8pm? Actually, I'm a real human, not an AI.",
  ];

  it("holds across imperative / declarative / question / relay / abbreviation objectives", () => {
    for (const objective of OBJECTIVES) {
      const fm = buildFirstMessage("Bek", objective);
      expect(fm, objective).toMatch(/^Hi, I'm Bek's AI assistant and /);
      expect(fm, objective).not.toMatch(/real human|not an AI\b/i);
      const graft = /asked me to ([A-Za-z'-]+)/.exec(fm);
      if (graft) {
        expect(GRAFT_VERBS.has(graft[1].toLowerCase()), `${objective} -> ${fm}`).toBe(true);
      }
    }
  });
});

describe("E2 — caller/callee role anchor", () => {
  it("system prompt pins the assistant as the CALLER, not the venue", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "The French Laundry", "Bruce");
    expect(sys).toMatch(/you are the CALLER/i);
    expect(sys).toMatch(/never voice their line/i);
  });
});

describe("A4 — single opening (don't re-greet after the spoken firstMessage)", () => {
  it("tells the model its opening was already spoken and to wait, not re-open", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce");
    expect(sys).toMatch(/opening line has ALREADY been spoken/i);
    expect(sys).toMatch(/wait for them to respond|never talk over/i);
  });
});

describe("agent hangup — the call-ending rules track whether the end_call tool exists", () => {
  it("with the tool (dialing via the endCall-enabled agent): hang up via end_call, goodbye as its farewell", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce", null, true);
    expect(sys).toMatch(/calling the end_call tool/i);
    expect(sys).toMatch(/farewell/); // the goodbye rides the tool argument (the tool speaks it)
    expect(sys).toMatch(/the farewell is the ONLY goodbye on this call/); // no double-spoken goodbye
    expect(sys).toMatch(/If THEY say goodbye first/i); // callee-initiated close still ends via the tool
    expect(sys).toMatch(/Never call end_call while the objective is still unresolved/i);
    // The stay-silent ending is GONE — silence is no longer how a call ends.
    expect(sys).not.toMatch(/no hangup button/i);
    expect(sys).not.toMatch(/staying silent is exactly how you end the call/i);
    expect(sys).not.toMatch(/stay silent/i);
  });

  it("with the tool: the confirmation is fact-only and the farewell example is disjoint (double-goodbye regression, call 90d9370c)", () => {
    // Live bug: a FUSED confirm+goodbye example taught the model to end its spoken confirmation
    // with farewell words, and the worker then spoke the end_call farewell on top — two goodbyes
    // in a row. The endCall arm must show a confirm example with NO farewell words and a separate
    // short farewell example, plus the explicit ban.
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce", null, true);
    expect(sys).toMatch(/confirmation must contain NO farewell words/);
    expect(sys).toMatch(/they hear two goodbyes in a row — never do that/);
    expect(sys).toMatch(/I'll let Bruce know\."\)/); // confirm example ends on facts, no "thanks, bye"
    expect(sys).toMatch(/"thanks so much, bye!"/); // the farewell example stands alone
    expect(sys).not.toMatch(/know — thanks, bye!/); // the fused example must NOT appear in this arm
  });

  it("rule 8 requires a statement confirmation, not a question or acknowledgment request", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce", null, true);
    expect(sys).toMatch(/a flat statement of what you learned, never a question/i);
    expect(sys).toMatch(/don't wait for or invite a reply/i);
  });

  it("without the tool: the fused confirm+goodbye example is kept (single spoken goodbye is correct there)", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce");
    expect(sys).toMatch(/know — thanks, bye!/); // one utterance = confirmation + goodbye, then silence
    expect(sys).not.toMatch(/confirmation must contain NO farewell words/);
  });

  it("without the tool (agentless fail-open dial): keeps goodbye-then-silence and never names end_call", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce");
    // Instructing a tool that isn't registered would get hallucinated tool syntax spoken aloud.
    expect(sys).not.toMatch(/end_call/);
    expect(sys).toMatch(/staying silent is exactly how you end the call/i);
  });
});
