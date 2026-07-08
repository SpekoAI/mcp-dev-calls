/**
 * Org-key fetch: on success returns the key; on any non-2xx it raises
 * OrgKeyUnavailableError (NOT a hang, NOT a "no org" claim) so the wizard falls
 * back to a clean one-time paste. Guards the 2026-07 platform change where
 * /v1/api-keys/organization-credentials began requiring a first-party dashboard
 * session and returns 403 to the CLI's OAuth token even for accounts WITH an org.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgKeyUnavailableError, fetchOrgKey } from "../src/cli/login.js";

afterEach(() => vi.unstubAllGlobals());

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

describe("fetchOrgKey", () => {
  it("returns the key on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { mcpApiKey: { key: "sk_live_abc" } })));
    expect(await fetchOrgKey("bearer")).toBe("sk_live_abc");
  });

  it("raises OrgKeyUnavailableError on the 403 'first-party dashboard session' response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { error: "This action requires a first-party dashboard session" })));
    const err = await fetchOrgKey("bearer").catch((e) => e);
    expect(err).toBeInstanceOf(OrgKeyUnavailableError);
    expect((err as OrgKeyUnavailableError).status).toBe(403);
    expect((err as Error).message).toMatch(/first-party dashboard session/);
  });

  it("raises OrgKeyUnavailableError on other non-2xx (500) — no retry loop, no hang", async () => {
    const fetchMock = vi.fn(async () => res(500, "boom"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchOrgKey("bearer")).rejects.toBeInstanceOf(OrgKeyUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises OrgKeyUnavailableError when the 200 body has no key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, {})));
    await expect(fetchOrgKey("bearer")).rejects.toBeInstanceOf(OrgKeyUnavailableError);
  });
});
