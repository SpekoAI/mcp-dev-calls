import { describe, expect, it } from "vitest";
import { runStatus } from "../src/cli/status.js";

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => void out.push(s) }, stderr: (line: string) => void err.push(line) };
}

const READY_REPORT = {
  headline: "Ready to call: caller ID available.",
  next_steps: ["Place one test call to confirm the outbound trunk connects."],
  auth: { ok: true },
  credits: { balance_usd: 12.34, minimum_usd: 0.5, sufficient: true },
};

const backendWith = (report: unknown) => ({ get: async () => report });

describe("runStatus", () => {
  it("ready account → key source, backend mode, headline, balance; exit 0", async () => {
    const c = cap();
    const code = await runStatus([], {
      ...c,
      env: { SPEKO_API_KEY: "sk_live_1234567890abcd" } as NodeJS.ProcessEnv,
      backend: backendWith(READY_REPORT),
    });
    expect(code).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("SPEKO_API_KEY");
    expect(text).not.toContain("sk_live_1234567890abcd"); // key must be masked
    expect(text).toContain("single-process");
    expect(text).toContain("Ready to call: caller ID available.");
    expect(text).toContain("$12.34");
    expect(text).toContain("minimum $0.50");
    expect(text).toContain("Place one test call");
  });

  it("not-ready account (insufficient credits) → exit 1, next steps shown", async () => {
    const c = cap();
    const code = await runStatus([], {
      ...c,
      env: { SPEKO_API_KEY: "sk_live_1234567890abcd" } as NodeJS.ProcessEnv,
      backend: backendWith({
        headline: "Almost ready — add credits.",
        next_steps: ["Add credits at platform.speko.dev."],
        auth: { ok: true },
        credits: { balance_usd: 0, minimum_usd: 0.5, sufficient: false },
      }),
    });
    expect(code).toBe(1);
    const text = c.out.join("");
    expect(text).toContain("Almost ready");
    expect(text).toContain("Add credits at platform.speko.dev.");
  });

  it("no key and no server URL → actionable setup hint on stderr, exit 1", async () => {
    const c = cap();
    const code = await runStatus([], { ...c, env: {} as NodeJS.ProcessEnv, backend: backendWith(READY_REPORT) });
    expect(code).toBe(1);
    expect(c.err.join("")).toContain("npx @spekoai/mcp-calls login");
    expect(c.out).toEqual([]);
  });

  it("remote server URL without a key → remote backend mode", async () => {
    const c = cap();
    const code = await runStatus([], {
      ...c,
      env: { SPEKO_MCP_SERVER_URL: "https://calls.speko.dev" } as NodeJS.ProcessEnv,
      backend: backendWith(READY_REPORT),
    });
    expect(code).toBe(0);
    expect(c.out.join("")).toContain("remote server at");
  });

  it("--json → machine-readable report with ready flag and key source", async () => {
    const c = cap();
    const code = await runStatus(["--json"], {
      ...c,
      env: { SPEKO_API_KEY: "sk_live_1234567890abcd" } as NodeJS.ProcessEnv,
      backend: backendWith(READY_REPORT),
    });
    expect(code).toBe(0);
    const json = JSON.parse(c.out.join("").trim());
    expect(json.ready).toBe(true);
    expect(json.key_source).toBe("SPEKO_API_KEY");
    expect(json.backend).toBe("in-process");
    expect(json.headline).toBe("Ready to call: caller ID available.");
  });

  it("backend failure → error on stderr, exit 1", async () => {
    const c = cap();
    const code = await runStatus([], {
      ...c,
      env: { SPEKO_API_KEY: "sk_live_1234567890abcd" } as NodeJS.ProcessEnv,
      backend: {
        get: async () => {
          throw new Error("could not reach the server");
        },
      },
    });
    expect(code).toBe(1);
    expect(c.err.join("")).toContain("could not reach the server");
  });

  it("unknown flag → parse error, exit 2", async () => {
    const c = cap();
    const code = await runStatus(["--bogus"], {
      ...c,
      env: { SPEKO_API_KEY: "sk_live_1234567890abcd" } as NodeJS.ProcessEnv,
      backend: backendWith(READY_REPORT),
    });
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("status:");
  });
});
