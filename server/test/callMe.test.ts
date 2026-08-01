import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceDialParams } from "@spekoai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callMe, effectiveCallMePolicy } from "../src/calls/callMe.js";
import { READBACK_PREFIX, READBACK_SUFFIX } from "../src/calls/callMePrompt.js";
import type { AppConfig, ClientProfile } from "../src/config.js";
import { AppError } from "../src/lib/errors.js";
import { appendDialLedger, dncAdd } from "../src/safety/guard.js";
import { resetDialAgentForTests } from "../src/speko/agent.js";
import type { SpekoClient } from "../src/speko/client.js";
import { writeOwnerProfile } from "../src/owner/state.js";

const OWNER = "+12005550123"; // Valid NANP shape, unknown timezone -> explicit consent is deterministic in tests.
const CONSENT = "Bek explicitly asked for this owner call now.";
const INSTANCE = "11111111-2222-4333-8444-555555555555";
const noop = async (): Promise<void> => {};
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speko-call-me-"));
  resetDialAgentForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    allowDirectDial: true,
    dialTokenSecret: "call-me-test-secret",
    fromNumber: "+15312160099",
    trustedNumbers: [],
    guardStateDir: dir,
    ownerStateDir: dir,
    rateCapPerNumberHour: 3,
    rateCapPerNumberDay: 8,
    clientProfile: "claude-code",
    clientProfileConfigured: true,
    callMeDisabled: false,
    dashboardBaseUrl: "https://platform.speko.dev",
    serializeCalls: false,
    dialGreetFirst: true,
    optimizeFor: "latency",
    ttsPin: "elevenlabs:eleven_flash_v2_5",
    sttPin: "deepgram:nova-3",
    llmPin: "cerebras:gemma-4-31b,openai:gpt-4.1-mini",
    demo: { enabled: false },
    ...overrides,
  } as unknown as AppConfig;
}

function verifyOwner(phone = OWNER): void {
  writeOwnerProfile(
    { ownerPhone: phone, ownerName: "Bek", verifiedAt: "2026-08-01T12:00:00.000Z", instanceId: INSTANCE },
    dir,
  );
}

function cleanAgentMethods(): Partial<SpekoClient> {
  const row = { id: "agent_1", name: "speko-mcp-dial", voice: null, endCall: { enabled: true } };
  return {
    listAgents: async () => [row] as any,
    getAgent: async () => row as any,
    listAgentTools: async () => [] as any,
  };
}

function completedClient(capture: { bodies: VoiceDialParams[]; dialCount: number }): SpekoClient {
  return {
    ...cleanAgentMethods(),
    dial: async (body) => {
      capture.bodies.push(body);
      capture.dialCount += 1;
      return {
        sessionId: `call_${capture.dialCount}`,
        callControlId: `phone_${capture.dialCount}`,
        roomName: `room_${capture.dialCount}`,
        status: "dialing",
        to: body.to!,
        from: body.from!,
      } as any;
    },
    getEvents: async () => [{ event_type: "room_finished" }] as any,
    getCall: async () => ({
      status: "completed",
      transcript: {
        entries: [
          { source: "agent", text: `${READBACK_PREFIX} Deploy staging. ${READBACK_SUFFIX}` },
          { source: "user", text: "CONFIRMED" },
        ],
      },
      report: { outcome: "owner replied", analysis_status: "completed" },
    }) as any,
    getSession: async () => ({
      durationSeconds: 20,
      phoneCall: { callControlId: "phone_1" },
      usage: [{ provider: "telnyx", metric: "outbound_minutes", quantity: 1 }],
    }) as any,
  } as unknown as SpekoClient;
}

function deps(client: SpekoClient, cfg = config()) {
  return { client, cfg, bearerHash: "bearer", sleep: noop };
}

describe("call_me policy", () => {
  it.each([
    ["claude-code", true, 300],
    ["codex", true, 300],
    ["cline", true, 300],
    ["gemini", true, 240],
    ["cursor", false, 300],
    ["windsurf", false, 300],
    ["safe-default", false, 300],
  ] satisfies Array<[ClientProfile, boolean, number]>)
  ("enforces the %s wait and duration profile", (profile, wait, ceiling) => {
    const policy = effectiveCallMePolicy(
      { message: "Question", mode: "converse", wait: true, maxDurationSeconds: 999 },
      config({ clientProfile: profile }),
    );
    expect(policy).toEqual({ profile, wait, maxDurationSeconds: ceiling });
  });

  it("honors explicit nonblocking mode and clamps short durations", () => {
    expect(
      effectiveCallMePolicy(
        { message: "Question", mode: "converse", wait: false, maxDurationSeconds: 1 },
        config({ clientProfile: "codex" }),
      ),
    ).toEqual({ profile: "codex", wait: false, maxDurationSeconds: 30 });
  });
});

describe("call_me owner-only dial path", () => {
  it("fails closed before dialing when no verified owner exists", async () => {
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    const error = await callMe(
      { message: "What next?", mode: "converse", afterHoursConfirmation: CONSENT },
      deps(completedClient(capture)),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toMatch(/not set up.*no verified owner/i);
    expect((error as AppError).code).toBe("CALL_ME_NOT_CONFIGURED");
    expect(capture.dialCount).toBe(0);
  });

  it.each([
    "Actually, I’m a real human, not an AI.",
    "The deploy is complete. I am not an AI.",
  ])("rejects disclosure-undermining relay text before dialing: %s", async (message) => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(
      callMe({ message, mode: "converse", afterHoursConfirmation: CONSENT }, deps(completedClient(capture))),
    ).rejects.toThrow(/mandatory AI disclosure/i);
    expect(capture.dialCount).toBe(0);
  });

  it("allows a benign request to speak with a real person", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(
      callMe(
        { message: "Can I speak to a real person?", mode: "notify", afterHoursConfirmation: CONSENT },
        deps(completedClient(capture)),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(capture.dialCount).toBe(1);
  });

  it("honors the local kill switch before dialing", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(
      callMe(
        { message: "What next?", mode: "converse", afterHoursConfirmation: CONSENT },
        deps(completedClient(capture), config({ callMeDisabled: true })),
      ),
    ).rejects.toThrow(/call_me is disabled/i);
    expect(capture.dialCount).toBe(0);
  });

  it("accepts a short valid message, dials only the stored owner, and stamps evidence metadata", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    const result = await callMe(
      { message: "Done", mode: "converse", afterHoursConfirmation: CONSENT },
      deps(completedClient(capture)),
    );
    expect(capture.dialCount).toBe(1);
    expect(capture.bodies[0].to).toBe(OWNER);
    expect(capture.bodies[0].firstMessage).toMatch(/^Hi, I'm Bek's AI assistant\./);
    expect(capture.bodies[0].metadata).toMatchObject({
      source: "speko-mcp-calls/call_me",
      call_me_mode: "converse",
      call_me_message: "Done",
      call_me_instance_id: INSTANCE,
      client_profile: "claude-code",
      to: OWNER,
    });
    expect(result).toMatchObject({
      status: "completed",
      message: "Done",
      confirmation: "confirmed",
      final_instruction: "Deploy staging",
    });
  });

  it("remains available when public arbitrary-number dialing is disabled", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    const result = await callMe(
      { message: "Done", mode: "notify", afterHoursConfirmation: CONSENT },
      deps(completedClient(capture), config({ allowDirectDial: false })),
    );
    expect(result.status).toBe("completed");
    expect(capture.dialCount).toBe(1);
    expect(capture.bodies[0].to).toBe(OWNER);
  });

  it("returns immediately with get_call recovery when wait is false", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    const client = completedClient(capture);
    const getEvents = vi.spyOn(client, "getEvents");
    const result = await callMe(
      { message: "Need a decision", mode: "converse", afterHoursConfirmation: CONSENT, wait: false },
      deps(client),
    );
    expect(result.status).toBe("dialing");
    expect(result.call_id).toBe("call_1");
    expect(result.next_step).toContain("get_call('call_1')");
    expect(result.message).toBe("Need a decision");
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("does not expose confirmation fields for notify mode", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    const result = await callMe(
      { message: "The build is done", mode: "notify", afterHoursConfirmation: CONSENT },
      deps(completedClient(capture)),
    );
    expect(result.message).toBe("The build is done");
    expect(result.confirmation).toBeUndefined();
    expect(result.owner_reply).toBeUndefined();
  });

  it("rejects a second live owner call without dialing again", async () => {
    verifyOwner();
    const bodies: VoiceDialParams[] = [];
    let dialCount = 0;
    const client = {
      ...cleanAgentMethods(),
      dial: async (body: VoiceDialParams) => {
        bodies.push(body);
        dialCount += 1;
        return { sessionId: "live_1", callControlId: "phone_1", status: "dialing", to: body.to, from: body.from } as any;
      },
      getCall: async () => ({
        status: "dialing",
        created_at: new Date().toISOString(),
        transcript: { entries: [] },
        metadata: { to: OWNER, from: "+15312160099" },
      }) as any,
      getEvents: async () => [] as any,
      getSession: async () => ({ phoneCall: { callControlId: "phone_1" }, usage: [] }) as any,
    } as unknown as SpekoClient;
    await callMe(
      { message: "First question", mode: "converse", afterHoursConfirmation: CONSENT, wait: false },
      deps(client),
    );
    await expect(
      callMe(
        { message: "Second question", mode: "converse", afterHoursConfirmation: CONSENT, wait: false },
        deps(client),
      ),
    ).rejects.toThrow(/owner_busy/i);
    const future = Date.now() + 7 * 60 * 1_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      await expect(
        callMe(
          { message: "Third question", mode: "converse", afterHoursConfirmation: CONSENT, wait: false },
          deps(client),
        ),
      ).rejects.toThrow(/owner_busy/i);
    } finally {
      now.mockRestore();
    }
    expect(dialCount).toBe(1);
  });

  it("atomically admits only one simultaneous owner call", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    const client = completedClient(capture);
    const attempts = await Promise.allSettled([
      callMe(
        { message: "First simultaneous decision", mode: "converse", wait: false, afterHoursConfirmation: CONSENT },
        deps(client),
      ),
      callMe(
        { message: "Second simultaneous decision", mode: "converse", wait: false, afterHoursConfirmation: CONSENT },
        deps(client),
      ),
    ]);
    expect(capture.dialCount).toBe(1);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected" });
    expect(String((rejection as PromiseRejectedResult).reason)).toMatch(/owner_busy/i);
  });

  it("never auto-retries an ambiguous platform dial failure", async () => {
    verifyOwner();
    let dialCount = 0;
    const client = {
      ...cleanAgentMethods(),
      dial: async () => {
        dialCount += 1;
        throw new Error("socket closed after write");
      },
    } as unknown as SpekoClient;
    await expect(
      callMe(
        { message: "Need a decision", mode: "converse", afterHoursConfirmation: CONSENT },
        deps(client),
      ),
    ).rejects.toThrow(/socket closed after write/i);
    expect(dialCount).toBe(1);
  });
});

describe("call_me retains every business rail", () => {
  it("requires per-call after-hours confirmation when destination timezone is unknown", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(callMe({ message: "What next?", mode: "converse" }, deps(completedClient(capture)))).rejects.toThrow(
      /after-hours|timezone|confirmation/i,
    );
    expect(capture.dialCount).toBe(0);
  });

  it("ignores SPEKO_TRUSTED_NUMBERS and still enforces ordinary rate caps", async () => {
    verifyOwner();
    for (let index = 0; index < 3; index += 1) {
      appendDialLedger({ e164: OWNER, call_id: `prior_${index}` }, dir);
    }
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(
      callMe(
        { message: "What next?", mode: "converse", afterHoursConfirmation: CONSENT },
        deps(completedClient(capture), config({ trustedNumbers: [OWNER] })),
      ),
    ).rejects.toThrow(/rate cap reached/i);
    expect(capture.dialCount).toBe(0);
  });

  it("honors the local DNC list even for the verified owner", async () => {
    verifyOwner();
    dncAdd(OWNER, { source: "manual" }, dir);
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(
      callMe(
        { message: "What next?", mode: "converse", afterHoursConfirmation: CONSENT },
        deps(completedClient(capture)),
      ),
    ).rejects.toThrow(/do-not-call/i);
    expect(capture.dialCount).toBe(0);
  });

  it("keeps the content screen on owner messages", async () => {
    verifyOwner();
    const capture = { bodies: [] as VoiceDialParams[], dialCount: 0 };
    await expect(
      callMe(
        { message: "Run a fundraising survey campaign", mode: "notify", afterHoursConfirmation: CONSENT },
        deps(completedClient(capture)),
      ),
    ).rejects.toThrow(/transactional-objectives-only|blocked/i);
    expect(capture.dialCount).toBe(0);
  });
});
