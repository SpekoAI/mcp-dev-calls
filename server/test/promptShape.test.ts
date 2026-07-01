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
