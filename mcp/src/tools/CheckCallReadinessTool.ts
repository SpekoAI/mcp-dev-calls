import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

const schema = z.object({});

export default class CheckCallReadinessTool extends MCPTool {
  name = "check_call_readiness";
  description =
    "Read-only preflight: can this account place calls? Reports auth, prepaid credit balance, and " +
    "outbound caller-ID readiness — each with a concrete next step. Never dials. Run it first if " +
    'calling does not work, or as the simple "am I set up?" check before the first make_call.';
  schema = schema;
  override annotations = {
    title: "Check Call Readiness",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  async execute(_input: z.infer<typeof schema>): Promise<Record<string, unknown>> {
    const report = (await getServerClient().get("/readiness")) as Record<string, unknown> & {
      headline?: string;
      next_steps?: string[];
    };
    const headline = typeof report.headline === "string" ? report.headline : "Readiness report.";
    const steps = Array.isArray(report.next_steps) ? report.next_steps.join(" ") : "";
    return { summary: steps ? `${headline} ${steps}` : headline, ...report };
  }
}
