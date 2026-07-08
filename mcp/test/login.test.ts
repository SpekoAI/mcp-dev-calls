/**
 * Brand-new-signup handling: the org key is fetched with a wait, so a user who
 * signs in before their workspace exists is picked up automatically instead of
 * being dead-ended into "paste a key" (there is none yet).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoOrgError, fetchOrgKey, fetchOrgKeyWaiting } from "../src/cli/login.js";

afterEach(() => vi.unstubAllGlobals());

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("fetchOrgKey", () => {
  it("returns the key on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { mcpApiKey: { key: "sk_live_abc" } })));
    expect(await fetchOrgKey("bearer")).toBe("sk_live_abc");
  });

  it("throws NoOrgError on 403 / 404 (authenticated but no org)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { error: "no org" })));
    await expect(fetchOrgKey("bearer")).rejects.toBeInstanceOf(NoOrgError);
    vi.stubGlobal("fetch", vi.fn(async () => res(404, {})));
    await expect(fetchOrgKey("bearer")).rejects.toBeInstanceOf(NoOrgError);
  });

  it("throws a generic error on other failures (e.g. 500)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(500, { error: "boom" })));
    const err = await fetchOrgKey("bearer").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoOrgError);
  });
});

describe("fetchOrgKeyWaiting", () => {
  it("polls through no-org responses and resolves once the workspace exists", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls < 3 ? res(403, {}) : res(200, { mcpApiKey: { key: "sk_ready" } });
      }),
    );
    const logs: string[] = [];
    const key = await fetchOrgKeyWaiting("bearer", (m) => logs.push(m), { intervalMs: 1, timeoutMs: 5_000 });
    expect(key).toBe("sk_ready");
    expect(calls).toBe(3);
    // told the user we're waiting, and that it resolved
    expect(logs.join("\n")).toMatch(/Waiting for it/);
    expect(logs.join("\n")).toMatch(/ready/i);
  });

  it("gives up with NoOrgError after the timeout (no infinite loop)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(403, {})));
    // now() advances past the timeout on the second check
    let t = 0;
    const now = () => (t += 10_000);
    await expect(
      fetchOrgKeyWaiting("bearer", () => {}, { intervalMs: 1, timeoutMs: 5_000, now }),
    ).rejects.toBeInstanceOf(NoOrgError);
  });

  it("does not swallow real auth errors — a 500 propagates immediately", async () => {
    const fetchMock = vi.fn(async () => res(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchOrgKeyWaiting("bearer", () => {}, { intervalMs: 1 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on non-NoOrg
  });
});
