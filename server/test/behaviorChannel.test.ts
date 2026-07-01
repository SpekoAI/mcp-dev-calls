import { describe, expect, it } from "vitest";
import { buildFirstMessage, buildSystemPrompt, sanitizeSpoken } from "../src/safety/prompt.js";

describe("B1 — spoken objective vs non-spoken behavior channel", () => {
  it("sanitizeSpoken strips leading turn-taking/silence directives, keeps the transactional ask", () => {
    const cleaned = sanitizeSpoken(
      "Do not speak first. Stay completely silent until they respond. Then ask if there's a table for 2 at 8pm.",
    );
    expect(cleaned).not.toMatch(/speak first/i);
    expect(cleaned).not.toMatch(/silent/i);
    expect(cleaned).toMatch(/table for 2/i);
  });

  it("strips an ALL-CAPS 'IMPORTANT ... RULE:' header directive", () => {
    const cleaned = sanitizeSpoken(
      "IMPORTANT TURN-TAKING RULE: Do not speak first. Then ask if there's a table for 2 at 8pm.",
    );
    expect(cleaned).not.toMatch(/turn-taking|speak first/i);
    expect(cleaned).toMatch(/table for 2/i);
  });

  it("leaves a normal transactional objective untouched", () => {
    const cleaned = sanitizeSpoken("ask if they have a table for 4 at 8pm tonight and book it under Bruce");
    expect(cleaned).toMatch(/table for 4/i);
    expect(cleaned).toMatch(/book it under Bruce/i);
  });

  it("buildFirstMessage never speaks a directive smuggled into the objective, keeps disclosure + ask", () => {
    const fm = buildFirstMessage(
      "Bruce",
      "Do not speak first. Stay completely silent until they respond. Then ask if there's a table for 2 at 8pm.",
    );
    expect(fm).not.toMatch(/speak first|silent/i);
    expect(fm).toMatch(/AI assistant/i); // disclosure intact
    expect(fm).toMatch(/table for 2/i); // the real ask is still spoken
  });

  it("behavior goes into the system prompt (BEHAVIOR block) and is NEVER in the spoken opening", () => {
    const behavior = "Wait for them to say hello before you speak, and be extra concise.";
    const objective = "ask if there's a table for 2 at 8pm tonight";
    const sys = buildSystemPrompt(objective, null, "The French Laundry", "Bruce", behavior);
    const fm = buildFirstMessage("Bruce", objective);
    expect(sys).toContain("BEHAVIOR");
    expect(sys).toContain("Wait for them to say hello");
    expect(fm).not.toMatch(/wait for them to say hello/i); // behavior is never spoken
    expect(fm).toMatch(/table for 2/i);
  });

  it("builds fine with no behavior provided and still carries the objective", () => {
    const sys = buildSystemPrompt("ask about hours", null, "Biz", "Bruce");
    expect(sys).toContain("ask about hours");
  });
});
