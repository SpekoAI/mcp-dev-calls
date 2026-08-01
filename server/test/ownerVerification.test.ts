import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceDialParams } from "@spekoai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeOwnerVerificationCall } from "../src/calls/ownerVerification.js";
import type { AppConfig } from "../src/config.js";
import { reserveOwnerVerificationCall } from "../src/owner/state.js";
import { appendDialLedger, dncAdd } from "../src/safety/guard.js";
import { resetDialAgentForTests } from "../src/speko/agent.js";
import type { SpekoClient } from "../src/speko/client.js";

const OWNER = "+12005550123";
const CODE = "123456";
const noop = async (): Promise<void> => {};
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speko-owner-verify-"));
  resetDialAgentForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    allowDirectDial: true,
    dialTokenSecret: "owner-verify-test-secret",
    fromNumber: "+15312160099",
    trustedNumbers: [],
    guardStateDir: dir,
    ownerStateDir: dir,
    rateCapPerNumberHour: 3,
    rateCapPerNumberDay: 8,
    serializeCalls: false,
    dialGreetFirst: true,
    dashboardBaseUrl: "https://platform.speko.dev",
    optimizeFor: "latency",
    ttsPin: "elevenlabs:eleven_flash_v2_5",
    sttPin: "deepgram:nova-3",
    llmPin: "cerebras:gemma-4-31b,openai:gpt-4.1-mini",
    demo: { enabled: false },
    ...overrides,
  } as unknown as AppConfig;
}

function fakeClient(capture: VoiceDialParams[]): SpekoClient {
  const row = { id: "agent_1", name: "speko-mcp-dial", voice: null, endCall: { enabled: true } };
  return {
    listAgents: async () => [row] as any,
    getAgent: async () => row as any,
    listAgentTools: async () => [] as any,
    dial: async (body) => {
      capture.push(body);
      return {
        sessionId: "verify_1",
        callControlId: "phone_1",
        roomName: "room_1",
        status: "dialing",
        to: body.to!,
        from: body.from!,
      } as any;
    },
    getEvents: async () => [{ event_type: "room_finished" }] as any,
    getCall: async () => ({
      status: "completed",
      transcript: { entries: [{ source: "agent", text: "Your code is one two three four five six." }] },
      report: { outcome: "verification code delivered", analysis_status: "completed" },
    }) as any,
    getSession: async () => ({
      durationSeconds: 10,
      phoneCall: { callControlId: "phone_1" },
      usage: [{ provider: "telnyx", metric: "outbound_minutes", quantity: 1 }],
    }) as any,
  } as unknown as SpekoClient;
}

async function place(capture: VoiceDialParams[], config = cfg()) {
  return placeOwnerVerificationCall(
    { ownerPhone: OWNER, ownerName: "Bek", verificationCode: CODE },
    { client: fakeClient(capture), cfg: config, bearerHash: "bearer", sleep: noop },
  );
}

describe("owner verification call", () => {
  it("places one disclosed OTP call outside the time gate and retains ElevenLabs + LLM failover pins", async () => {
    const bodies: VoiceDialParams[] = [];
    const result = await place(bodies);
    expect(result.call_id).toBe("verify_1");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].firstMessage).toMatch(/^Hi, I'm Bek's AI assistant/);
    expect(bodies[0].firstMessage?.match(/1 2 3 4 5 6/g)).toHaveLength(2);
    expect(bodies[0].constraints).toEqual({
      allowedProviders: {
        tts: ["elevenlabs:eleven_flash_v2_5"],
        stt: ["deepgram:nova-3"],
        llm: ["cerebras:gemma-4-31b", "openai:gpt-4.1-mini"],
      },
    });
    expect(bodies[0].metadata).toMatchObject({
      source: "speko-mcp-calls/owner-verification",
      owner_verification: true,
      to: OWNER,
    });
    expect(JSON.stringify(bodies[0].metadata)).not.toContain(CODE);

    const ordinaryLedger = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    const otpLedger = readFileSync(join(dir, "owner-verification.jsonl"), "utf8");
    expect(ordinaryLedger).toContain(OWNER);
    expect(otpLedger).toContain(OWNER);
    expect(ordinaryLedger + otpLedger).not.toContain(CODE);
  });

  it("counts against ordinary caps even when the number is configured as trusted", async () => {
    for (let index = 0; index < 3; index += 1) appendDialLedger({ e164: OWNER, call_id: `prior_${index}` }, dir);
    const bodies: VoiceDialParams[] = [];
    await expect(place(bodies, cfg({ trustedNumbers: [OWNER] }))).rejects.toThrow(/rate cap reached/i);
    expect(bodies).toHaveLength(0);
    expect(existsSync(join(dir, "owner-verification.jsonl"))).toBe(false);
  });

  it("honors DNC before consuming an OTP attempt", async () => {
    dncAdd(OWNER, { source: "manual" }, dir);
    const bodies: VoiceDialParams[] = [];
    await expect(place(bodies)).rejects.toThrow(/do-not-call/i);
    expect(bodies).toHaveLength(0);
    expect(existsSync(join(dir, "owner-verification.jsonl"))).toBe(false);
  });

  it("enforces the independent three-per-day OTP call cap before platform dial", async () => {
    const now = Date.now();
    reserveOwnerVerificationCall(OWNER, { dir, nowMs: now - 3 });
    reserveOwnerVerificationCall(OWNER, { dir, nowMs: now - 2 });
    reserveOwnerVerificationCall(OWNER, { dir, nowMs: now - 1 });
    const bodies: VoiceDialParams[] = [];
    await expect(
      place(bodies, cfg({ rateCapPerNumberHour: 100, rateCapPerNumberDay: 100 })),
    ).rejects.toThrow(/verification call limit reached/i);
    expect(bodies).toHaveLength(0);
  });
});
