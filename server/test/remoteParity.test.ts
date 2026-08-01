import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callMeMock, readinessMock } = vi.hoisted(() => ({
  callMeMock: vi.fn(async () => ({ status: "completed", call_id: "call_1" })),
  readinessMock: vi.fn(async (_client: unknown, cfg: unknown) => ({ ok: true, cfg })),
}));

vi.mock("../src/calls/callMe.js", () => ({ callMe: callMeMock }));
vi.mock("../src/calls/readiness.js", () => ({ checkReadiness: readinessMock }));

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { ServerContext } from "../src/http/context.js";
import { AppError } from "../src/lib/errors.js";

let server: Server | null = null;
let baseUrl = "";
let cfg: AppConfig;

beforeEach(async () => {
  callMeMock.mockReset();
  callMeMock.mockResolvedValue({ status: "completed", call_id: "call_1" });
  readinessMock.mockClear();
  cfg = {
    internalKey: "remote-test-key",
    clientProfile: "claude-code",
    clientProfileConfigured: true,
    demo: { enabled: false },
  } as unknown as AppConfig;
  const ctx = { cfg, client: {}, bearerHash: "bearer" } as unknown as ServerContext;
  server = buildApp(ctx).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
});

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-internal-key": "remote-test-key",
    ...extra,
  };
}

describe("remote request contract", () => {
  it("authenticates the remote boundary before invoking a call", async () => {
    const response = await fetch(`${baseUrl}/call-me`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What next?" }),
    });
    expect(response.status).toBe(401);
    expect(callMeMock).not.toHaveBeenCalled();
  });

  it("applies a valid profile per request without mutating shared config", async () => {
    const response = await fetch(`${baseUrl}/call-me`, {
      method: "POST",
      headers: headers({ "x-speko-client-profile": "codex" }),
      body: JSON.stringify({ message: "What next?", phone_number: "+12025550199" }),
    });
    expect(response.status).toBe(200);
    expect(callMeMock).toHaveBeenCalledTimes(1);
    expect(callMeMock.mock.calls[0][0]).not.toHaveProperty("phoneNumber");
    expect(callMeMock.mock.calls[0][1].cfg).toMatchObject({
      clientProfile: "codex",
      clientProfileConfigured: true,
    });
    expect(cfg).toMatchObject({ clientProfile: "claude-code", clientProfileConfigured: true });
  });

  it.each([undefined, "unknown-profile"])(
    "degrades a %s profile header to unconfigured safe-default readiness",
    async (profile) => {
      const response = await fetch(`${baseUrl}/readiness`, {
        headers: headers(profile ? { "x-speko-client-profile": profile } : {}),
      });
      expect(response.status).toBe(200);
      const requestCfg = readinessMock.mock.calls.at(-1)?.[1] as AppConfig;
      expect(requestCfg).toMatchObject({ clientProfile: "safe-default", clientProfileConfigured: false });
      expect(cfg).toMatchObject({ clientProfile: "claude-code", clientProfileConfigured: true });
    },
  );

  it("keeps simultaneous remote profiles request-scoped", async () => {
    await Promise.all(
      ["codex", "gemini"].map((profile) =>
        fetch(`${baseUrl}/readiness`, { headers: headers({ "x-speko-client-profile": profile }) }),
      ),
    );
    expect(readinessMock.mock.calls.map((call) => (call[1] as AppConfig).clientProfile).sort()).toEqual([
      "codex",
      "gemini",
    ]);
    expect(cfg.clientProfile).toBe("claude-code");
  });

  it("publishes only the allowlisted setup error code", async () => {
    callMeMock.mockRejectedValueOnce(
      new AppError("Owner missing", {
        statusCode: 422,
        nextStep: "Verify on this host.",
        code: "CALL_ME_NOT_CONFIGURED",
      }),
    );
    const response = await fetch(`${baseUrl}/call-me`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message: "What next?" }),
    });
    expect(response.status).toBe(422);
    expect(response.headers.get("x-speko-error-code")).toBe("CALL_ME_NOT_CONFIGURED");
    expect(await response.json()).toMatchObject({ code: "CALL_ME_NOT_CONFIGURED" });

    callMeMock.mockRejectedValueOnce(
      new AppError("Upstream failed", { statusCode: 422, code: "UPSTREAM_PRIVATE_CODE" }),
    );
    const privateResponse = await fetch(`${baseUrl}/call-me`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message: "What next?" }),
    });
    expect(privateResponse.headers.has("x-speko-error-code")).toBe(false);
    expect(await privateResponse.json()).not.toHaveProperty("code");
  });
});
