import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../src/http/serverClient.js", () => ({
  getServerClient: () => ({ post }),
}));

import CallMeTool from "../src/tools/CallMeTool.js";

describe("CallMeTool", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("exposes an owner-only schema with safe defaults and no destination field", () => {
    const tool = new CallMeTool();
    expect(tool.name).toBe("call_me");
    expect(Object.keys(tool.schema.shape)).toEqual([
      "message",
      "mode",
      "context",
      "after_hours_confirmation",
      "max_duration_seconds",
      "wait",
    ]);
    expect(tool.schema.safeParse({ message: "What next?" })).toMatchObject({
      success: true,
      data: { message: "What next?", mode: "converse", max_duration_seconds: 180, wait: true },
    });
    expect(tool.schema.safeParse({ message: "" }).success).toBe(false);
    expect(tool.schema.safeParse({ message: "x".repeat(2_001) }).success).toBe(false);
    expect(tool.schema.safeParse({ message: "ok", max_duration_seconds: 301 }).success).toBe(false);
    expect(tool.description).toMatch(/locally verified owner phone/i);
    expect(tool.description).toMatch(/unconfirmed instructions are advisory only/i);
    expect(tool.description).toMatch(/Every invocation places at most one call/i);
  });

  it("maps every field to /call-me and uses the shared blocking timeout envelope", async () => {
    post.mockResolvedValue({
      status: "completed",
      call_id: "call_1",
      confirmation: "confirmed",
      owner_reply: "OWNER_REPLY (voice transcript, speaker unverified): staging",
    });
    const tool = new CallMeTool();
    vi.spyOn(tool as any, "reportProgress").mockImplementation(() => undefined);
    const result = await tool.execute({
      message: "Where should I deploy?",
      mode: "converse",
      context: "platform repo",
      after_hours_confirmation: "Bek asked me to call now",
      max_duration_seconds: 240,
      wait: true,
    });
    expect(post).toHaveBeenCalledWith(
      "/call-me",
      {
        message: "Where should I deploy?",
        mode: "converse",
        context: "platform repo",
        after_hours_confirmation: "Bek asked me to call now",
        max_duration_seconds: 240,
        wait: true,
      },
      expect.objectContaining({ timeoutMs: 270_000 }),
    );
    expect(result.summary).toContain("Confirmation: confirmed");
    expect(result.summary).toContain("OWNER_REPLY (voice transcript, speaker unverified)");
  });

  it("returns explicit polling guidance for wait:false", async () => {
    post.mockResolvedValue({
      status: "dialing",
      call_id: "call_live",
      next_step: "Poll get_call('call_live') until terminal. Do not place another call.",
    });
    const tool = new CallMeTool();
    vi.spyOn(tool as any, "reportProgress").mockImplementation(() => undefined);
    const result = await tool.execute({
      message: "Need a decision",
      mode: "converse",
      max_duration_seconds: 180,
      wait: false,
    });
    expect(result.summary).toContain("get_call('call_live')");
    expect(result.summary).toContain("Do not place another call");
  });
});
