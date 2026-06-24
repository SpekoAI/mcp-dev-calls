import { describe, expect, it } from "vitest";
import { extractOutcome, extractReply } from "../src/lib/transcript.js";

describe("extractOutcome", () => {
  it("returns the text after the LAST OUTCOME: marker", () => {
    const transcript = {
      entries: [
        { source: "agent", text: "Hi there." },
        { source: "agent", text: "OUTCOME: first guess" },
        { source: "agent", text: "OUTCOME: table for 4 at 8pm booked" },
      ],
    };
    expect(extractOutcome(transcript)).toBe("table for 4 at 8pm booked");
  });

  it("returns null when no marker is present", () => {
    expect(extractOutcome({ entries: [{ source: "agent", text: "no result here" }] })).toBeNull();
  });
});

describe("extractReply", () => {
  it("keys on `source` (not `role`) and joins caller turns", () => {
    const transcript = {
      entries: [
        { source: "agent", text: "What would you like me to do?" },
        { source: "user", text: "Ship it" },
        { source: "user", text: "and deploy to staging" },
      ],
    };
    expect(extractReply(transcript)).toBe("Ship it and deploy to staging");
  });

  it("ignores agent/system turns", () => {
    const transcript = { entries: [{ source: "agent", text: "hello" }, { source: "system", text: "x" }] };
    expect(extractReply(transcript)).toBeNull();
  });
});
