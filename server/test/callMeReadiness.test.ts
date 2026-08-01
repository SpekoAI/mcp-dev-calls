import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReadiness } from "../src/calls/readiness.js";
import type { AppConfig } from "../src/config.js";
import { writeOwnerProfile } from "../src/owner/state.js";
import type { SpekoClient } from "../src/speko/client.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speko-readiness-owner-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const client = {
  getBalance: async () => ({ balanceUsd: 100 }),
  listPhoneNumbers: async () => [],
} as unknown as SpekoClient;

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ownerStateDir: dir,
    clientProfile: "safe-default",
    clientProfileConfigured: false,
    callMeDisabled: false,
    ...overrides,
  } as unknown as AppConfig;
}

describe("check_call_readiness call_me state", () => {
  it("fails closed without a valid owner and gives the exact self-serve command", async () => {
    const r = await checkReadiness(client, cfg());
    expect(r.call_me).toMatchObject({ available: false, client_profile: "safe-default" });
    expect(r.call_me.note).toContain("speko me verify");
    expect(r.call_me.note).toContain("npx @spekoai/mcp-calls@latest init");
    expect(r.call_me.note).toContain("poll-safe mode");
    expect(r.call_me.owner_phone_last4).toBeUndefined();
  });

  it("reports a verified owner by last four only and names the retained rails", async () => {
    writeOwnerProfile(
      {
        ownerPhone: "+13463760044",
        ownerName: "Bek",
        instanceId: "11111111-2222-4333-8444-555555555555",
      },
      dir,
    );
    const r = await checkReadiness(
      client,
      cfg({ clientProfile: "codex", clientProfileConfigured: true }),
    );
    expect(r.call_me).toMatchObject({ available: true, owner_phone_last4: "0044", client_profile: "codex" });
    expect(r.call_me.note).not.toContain("+13463760044");
    expect(r.call_me.note).toMatch(/does not relax DNC, rate caps, or quiet hours/i);
    expect(r.call_me.note).not.toContain("poll-safe mode");
  });

  it("reports the kill switch as unavailable without deleting owner state", async () => {
    writeOwnerProfile({ ownerPhone: "+13463760044", ownerName: "Bek" }, dir);
    const r = await checkReadiness(client, cfg({ callMeDisabled: true }));
    expect(r.call_me.available).toBe(false);
    expect(r.call_me.owner_phone_last4).toBe("0044");
    expect(r.call_me.note).toContain("SPEKO_CALLME_DISABLED");
  });

  it("treats corrupt owner state as unverified", async () => {
    writeFileSync(join(dir, "owner.json"), "{broken");
    const r = await checkReadiness(client, cfg());
    expect(r.call_me.available).toBe(false);
    expect(r.call_me.owner_phone_last4).toBeUndefined();
  });
});
