import { describe, expect, it } from "vitest";
import { buildFirstMessage, buildSystemPrompt } from "../src/safety/prompt.js";

describe("C1 — disclosure opening is one continuous clause (no barge-in seam)", () => {
  it("keeps the AI disclosure but drops the em-dash break and 'Quick heads up' lead-in", () => {
    const fm = buildFirstMessage("Bruce", "ask if there's a table for 2 at 8pm tonight");
    expect(fm).toMatch(/I'm Bruce's AI assistant/i); // disclosure intact
    expect(fm).not.toContain("—"); // no hard clause break TTS renders as a pause
    expect(fm).not.toMatch(/quick heads up/i);
    expect(fm).toMatch(/assistant and Bruce asked me to/i); // continuous prosodic unit
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
