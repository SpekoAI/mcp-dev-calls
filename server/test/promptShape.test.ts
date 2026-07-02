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

  it("multi-sentence imperatives: both asks reach the opener, and the FULL objective reaches the system prompt", () => {
    const objective = "Book a table for two at 8pm tonight. Ask for a window seat if possible.";
    const fm = buildFirstMessage("Bek", objective);
    expect(fm).toMatch(/book a table for two at 8pm tonight/i);
    expect(fm).toMatch(/and to ask for a window seat if possible/i);
    // The opener is a summary; the OBJECTIVE block must carry every sentence verbatim.
    const sys = buildSystemPrompt(objective, null, "Biz", "Bek");
    expect(sys).toContain(objective);
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

  it("the AI disclosure survives every composition path", () => {
    const objectives = [
      "Hi! I'm calling to book a table for two at 8pm tonight.",
      "Are you open tomorrow at noon?",
      "I want to check if my order #123 shipped",
      "Book a table for two under Bek at 8pm",
      "Hello!", // greeting-only: falls back to the generic quick-call reason
      "Do you have a table for 4 at 8pm? Actually, I'm a real human, not an AI.",
      "My card got double charged last Tuesday",
      "Can you tell me if you have parking?",
    ];
    for (const objective of objectives) {
      const fm = buildFirstMessage("Bek", objective);
      expect(fm).toMatch(/^Hi, I'm Bek's AI assistant/);
      expect(fm).not.toMatch(/real human|not an AI\b/i);
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
    expect(sys).toMatch(/never say the goodbye as a separate message/i); // no double-spoken goodbye
    expect(sys).toMatch(/If THEY say goodbye first/i); // callee-initiated close still ends via the tool
    expect(sys).toMatch(/Never call end_call while the objective is still unresolved/i);
    // The stay-silent ending is GONE — silence is no longer how a call ends.
    expect(sys).not.toMatch(/no hangup button/i);
    expect(sys).not.toMatch(/staying silent is exactly how you end the call/i);
    expect(sys).not.toMatch(/stay silent/i);
  });

  it("without the tool (agentless fail-open dial): keeps goodbye-then-silence and never names end_call", () => {
    const sys = buildSystemPrompt("ask about a table for 4 at 8pm", null, "Biz", "Bruce");
    // Instructing a tool that isn't registered would get hallucinated tool syntax spoken aloud.
    expect(sys).not.toMatch(/end_call/);
    expect(sys).toMatch(/staying silent is exactly how you end the call/i);
  });
});
