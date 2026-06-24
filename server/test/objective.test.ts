import { describe, expect, it } from "vitest";
import { objectiveBlockedReason } from "../src/safety/objective.js";

describe("objective screen", () => {
  it("allows neutral transactional questions", () => {
    expect(objectiveBlockedReason("Do you have a table for 4 at 8pm tonight?")).toBeNull();
    expect(objectiveBlockedReason("What time do you close today?")).toBeNull();
  });

  it("rejects objectives that are too short", () => {
    expect(objectiveBlockedReason("hi")).toMatch(/too short/);
  });

  it("blocks selling / promotion / surveys / fundraising / campaigning", () => {
    expect(objectiveBlockedReason("I want to sell you our new service")).toMatch(/blocked/);
    expect(objectiveBlockedReason("Run a quick customer survey for me")).toMatch(/blocked/);
    expect(objectiveBlockedReason("Ask them to donate to our fundraiser")).toMatch(/blocked/);
  });

  it("block-list wins over transactional wording", () => {
    // Mentions a reservation but also a sales pitch → still blocked.
    expect(objectiveBlockedReason("Book a table and also pitch our promotion")).toMatch(/blocked/);
  });
});
