import { describe, expect, it } from "vitest";
import { bestOutcome, extractEndCallReason, extractOutcome, extractReply } from "../src/lib/transcript.js";

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

describe("extractEndCallReason", () => {
  it("returns the reason from an end_call tool entry when no outcome marker exists", () => {
    const transcript = {
      entries: [
        { source: "agent", text: "thanks", metadata: { toolCalls: [{ name: "end_call", args: '{"farewell":"thanks so much, bye!","reason":"exact requested time not available, offered 9pm instead"}' }] } },
      ],
    };
    expect(extractEndCallReason(transcript)).toBe("exact requested time not available, offered 9pm instead");
    // bestOutcome deliberately does NOT fold the reason in: makeCall's report-grace loop keys
    // on it returning null so it keeps waiting for the substantive report. Call sites compose
    // extractEndCallReason as their own last fallback once done waiting.
    expect(bestOutcome({ outcome: "" }, transcript)).toBeNull();
  });

  it("returns null for malformed args JSON", () => {
    const transcript = {
      entries: [
        { source: "agent", text: "bye", metadata: { toolCalls: [{ name: "end_call", args: '{"reason":' }] } },
      ],
    };
    expect(extractEndCallReason(transcript)).toBeNull();
  });

  it("returns null for farewell-only args", () => {
    const transcript = {
      entries: [
        { source: "agent", text: "bye", metadata: { toolCalls: [{ name: "end_call", args: { farewell: "thanks, bye" } }] } },
      ],
    };
    expect(extractEndCallReason(transcript)).toBeNull();
  });
});

describe("bestOutcome precedence", () => {
  const transcript = {
    entries: [
      { source: "agent", text: "OUTCOME: marker outcome" },
      { source: "agent", text: "bye", metadata: { toolCalls: [{ name: "end_call", args: { reason: "tool reason" } }] } },
    ],
  };

  it("keeps a substantive report outcome ahead of transcript fallbacks", () => {
    expect(bestOutcome({ outcome: "substantive report" }, transcript)).toBe("substantive report");
  });

  it("keeps an OUTCOME marker ahead of end_call reason", () => {
    expect(bestOutcome({ outcome: "" }, transcript)).toBe("marker outcome");
  });
});
