import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../src/http/serverClient.js", () => ({
  getServerClient: () => ({ post }),
}));

import CallNumberTool from "../src/tools/CallNumberTool.js";

describe("CallNumberTool", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("exposes the direct-dial schema with wait defaulting to the blocking behavior", () => {
    const tool = new CallNumberTool();
    expect(tool.name).toBe("call_number");
    expect(Object.keys(tool.schema.shape)).toEqual([
      "phone_number",
      "objective",
      "caller_name",
      "recipient_name",
      "context",
      "behavior",
      "greet_first",
      "utc_offset_minutes",
      "after_hours_confirmation",
      "max_duration_seconds",
      "wait",
    ]);
    expect(
      tool.schema.safeParse({
        phone_number: "+14155550142",
        objective: "Ask if they have a table for four tonight.",
        caller_name: "Bek",
      }),
    ).toMatchObject({ success: true, data: { wait: true } });
    expect(
      tool.schema.safeParse({ phone_number: "+14155550142", objective: "x", caller_name: "Bek", wait: "yes" }).success,
    ).toBe(false);
    // wait stays optional — no schema change for existing callers.
    expect(tool.inputSchema.required).toEqual(["phone_number", "objective", "caller_name"]);
    expect(tool.schema.shape.wait.description).toMatch(/call_id to poll via get_call/i);
    expect(tool.schema.shape.wait.description).toMatch(/never re-invoke call_number/i);
  });

  it("maps every field including wait to /call-number with the blocking timeout envelope", async () => {
    post.mockResolvedValue({
      status: "completed",
      call_id: "call_1",
      connected: true,
      answered: true,
      outcome: "They are open until 9pm.",
    });
    const tool = new CallNumberTool();
    vi.spyOn(tool as any, "reportProgress").mockImplementation(() => undefined);
    const result = await tool.execute({
      phone_number: "+14155550142",
      objective: "Ask if they are open tonight.",
      caller_name: "Bek",
      recipient_name: "Sam",
      context: "closing-time check",
      behavior: "be concise",
      greet_first: false,
      utc_offset_minutes: -420,
      after_hours_confirmation: "Bek asked me to call now",
      max_duration_seconds: 240,
      wait: true,
    });
    expect(post).toHaveBeenCalledWith(
      "/call-number",
      {
        phone_number: "+14155550142",
        objective: "Ask if they are open tonight.",
        caller_name: "Bek",
        recipient_name: "Sam",
        context: "closing-time check",
        behavior: "be concise",
        greet_first: false,
        utc_offset_minutes: -420,
        after_hours_confirmation: "Bek asked me to call now",
        max_duration_seconds: 240,
        wait: true,
      },
      expect.objectContaining({ timeoutMs: 270_000 }),
    );
    expect(result.summary).toBe("They are open until 9pm.");
  });

  it("wait:false returns the pollable dialing shape with explicit no-redial guidance", async () => {
    post.mockResolvedValue({
      status: "dialing",
      call_id: "call_bg2",
      connected: false,
      answered: false,
      reason: "The call was placed and is continuing in the background.",
      next_step: "Poll get_call('call_bg2') until it reaches a terminal status. Do not place another call.",
    });
    const tool = new CallNumberTool();
    vi.spyOn(tool as any, "reportProgress").mockImplementation(() => undefined);
    const result = await tool.execute({
      phone_number: "+14155550142",
      objective: "Ask if they have a table for four tonight.",
      caller_name: "Bek",
      wait: false,
    });
    expect(post.mock.calls[0][1]).toMatchObject({ wait: false });
    expect(result.status).toBe("dialing");
    expect(result.call_id).toBe("call_bg2");
    expect(result.summary).toContain("get_call('call_bg2')");
    expect(result.summary).toContain("Do not place another call");
  });
});
