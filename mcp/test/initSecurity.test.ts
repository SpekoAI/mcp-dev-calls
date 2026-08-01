import { afterEach, describe, expect, it, vi } from "vitest";
import { printManualConfigs } from "../src/cli/init.js";

describe("init manual configuration output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a placeholder and never a credential-shaped API key", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });

    printManualConfigs("user");
    const output = lines.join("\n");
    expect(output).toContain("YOUR_SPEKO_API_KEY");
    expect(output).not.toMatch(/SPEKO_API_KEY=(?:Bearer\s+)?sk_/);
    expect(output).toContain("the real key is never printed");
  });
});
