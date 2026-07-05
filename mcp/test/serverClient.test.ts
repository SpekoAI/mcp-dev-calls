import { beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessBackend } from "../src/http/serverClient.js";

// The in-process path maps snake_case tool input to the core's camelCase inputs by hand,
// so a new field silently vanishes if the mapping is missed (the after_hours_confirmation
// regression this pins). Mock the core and assert what actually reaches makeCall/callNumber.
const makeCall = vi.fn(async () => ({ status: "completed" }));
const callNumber = vi.fn(async () => ({ status: "completed" }));

vi.mock("@spekoai/mcp-calls-demo-server/core", () => ({
  loadConfig: () => ({ demo: { enabled: false } }),
  buildContext: () => ({ cfg: { demo: { enabled: false } }, client: {}, bearerHash: "bh" }),
  makeCall: (...args: unknown[]) => makeCall(...args),
  callNumber: (...args: unknown[]) => callNumber(...args),
  lookupBusiness: vi.fn(),
  checkReadiness: vi.fn(),
  describeCall: vi.fn(),
}));

beforeEach(() => {
  makeCall.mockClear();
  callNumber.mockClear();
});

describe("InProcessBackend input mapping", () => {
  it("threads after_hours_confirmation and greet_first through /call to makeCall", async () => {
    const backend = new InProcessBackend();
    await backend.post("/call", {
      dial_token: "tok",
      objective: "Do you have a table for four?",
      caller_name: "Bek",
      greet_first: false,
      after_hours_confirmation: "yes, it's my own number, call now",
    });
    expect(makeCall).toHaveBeenCalledTimes(1);
    expect(makeCall.mock.calls[0][0]).toMatchObject({
      greetFirst: false,
      afterHoursConfirmation: "yes, it's my own number, call now",
    });
  });

  it("threads after_hours_confirmation and greet_first through /call-number to callNumber, null when absent", async () => {
    const backend = new InProcessBackend();
    await backend.post("/call-number", {
      phone_number: "+14155550142",
      objective: "Do you have a table for four?",
      caller_name: "Bek",
      greet_first: false,
      after_hours_confirmation: "go ahead, they are expecting the call",
    });
    expect(callNumber.mock.calls[0][0]).toMatchObject({
      greetFirst: false,
      afterHoursConfirmation: "go ahead, they are expecting the call",
    });

    await backend.post("/call-number", {
      phone_number: "+14155550142",
      objective: "Do you have a table for four?",
      caller_name: "Bek",
    });
    expect(callNumber.mock.calls[1][0]).toMatchObject({ afterHoursConfirmation: null, greetFirst: null });
  });
});
