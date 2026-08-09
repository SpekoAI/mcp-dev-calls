import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../src/http/serverClient.js", () => ({
  getServerClient: () => ({ post }),
}));

import MakeCallTool from "../src/tools/MakeCallTool.js";

describe("MakeCallTool", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("exposes the dial schema with wait defaulting to the blocking behavior", () => {
    const tool = new MakeCallTool();
    expect(tool.name).toBe("make_call");
    expect(Object.keys(tool.schema.shape)).toEqual([
      "dial_token",
      "objective",
      "caller_name",
      "context",
      "behavior",
      "greet_first",
      "after_hours_confirmation",
      "max_duration_seconds",
      "wait",
    ]);
    expect(
      tool.schema.safeParse({
        dial_token: "tok",
        objective: "Ask if they have a table for four tonight.",
        caller_name: "Bek",
      }),
    ).toMatchObject({ success: true, data: { wait: true } });
    expect(tool.schema.safeParse({ dial_token: "tok", objective: "x", caller_name: "Bek", wait: "yes" }).success).toBe(
      false,
    );
    // wait stays optional — no schema change for existing callers.
    expect(tool.inputSchema.required).toEqual(["dial_token", "objective", "caller_name"]);
    expect(tool.schema.shape.wait.description).toMatch(/call_id to poll via get_call/i);
    expect(tool.schema.shape.wait.description).toMatch(/never re-invoke make_call/i);
  });

  it("maps every field including wait to /call with the blocking timeout envelope", async () => {
    post.mockResolvedValue({
      status: "completed",
      call_id: "call_1",
      connected: true,
      answered: true,
      outcome: "Table booked at 8pm.",
    });
    const tool = new MakeCallTool();
    vi.spyOn(tool as any, "reportProgress").mockImplementation(() => undefined);
    const result = await tool.execute({
      dial_token: "tok",
      objective: "Book a table for four at 8pm under Bek.",
      caller_name: "Bek",
      context: "party of four",
      behavior: "be concise",
      greet_first: false,
      after_hours_confirmation: "Bek asked me to call now",
      max_duration_seconds: 240,
      wait: true,
    });
    expect(post).toHaveBeenCalledWith(
      "/call",
      {
        dial_token: "tok",
        objective: "Book a table for four at 8pm under Bek.",
        caller_name: "Bek",
        context: "party of four",
        behavior: "be concise",
        greet_first: false,
        after_hours_confirmation: "Bek asked me to call now",
        max_duration_seconds: 240,
        wait: true,
      },
      expect.objectContaining({ timeoutMs: 270_000 }),
    );
    expect(result.summary).toBe("Table booked at 8pm.");
  });

  it("wait:false returns the pollable dialing shape with explicit no-redial guidance", async () => {
    post.mockResolvedValue({
      status: "dialing",
      call_id: "call_bg",
      connected: false,
      answered: false,
      reason: "The call was placed and is continuing in the background.",
      next_step: "Poll get_call('call_bg') until it reaches a terminal status. Do not place another call.",
    });
    const tool = new MakeCallTool();
    vi.spyOn(tool as any, "reportProgress").mockImplementation(() => undefined);
    const result = await tool.execute({
      dial_token: "tok",
      objective: "Ask if they have a table for four tonight.",
      caller_name: "Bek",
      wait: false,
    });
    expect(post.mock.calls[0][1]).toMatchObject({ wait: false });
    expect(result.status).toBe("dialing");
    expect(result.call_id).toBe("call_bg");
    expect(result.summary).toContain("get_call('call_bg')");
    expect(result.summary).toContain("Do not place another call");
  });
});
