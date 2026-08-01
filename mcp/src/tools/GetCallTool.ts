import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";
import { summarizeCallResult, summarizeOwnerCallResult } from "./_shared/callSummary.js";

const schema = z.object({
  call_id: z
    .string()
    .describe("The call_id returned by make_call or call_number — to re-check a call's status, outcome, and transcript."),
});

export default class GetCallTool extends MCPTool {
  name = "get_call";
  description =
    "Read-only: re-check an existing call by its call_id — status, connected/answered, the OUTCOME line, and the " +
    "transcript. Never dials. Use it after make_call or call_number reports a timeout, or to inspect a finished call.";
  schema = schema;
  override annotations = {
    title: "Get Call",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  async execute(input: z.infer<typeof schema>): Promise<Record<string, unknown>> {
    const id = encodeURIComponent(String(input.call_id ?? "").trim());
    const result = (await getServerClient().get(`/call/${id}`)) as Record<string, unknown>;
    // Same plain-language `summary` line make_call/call_number lead with, so the agent
    // never has to interpret the raw status/connected/answered fields itself.
    return {
      summary: summarizeOwnerCallResult(result) ?? summarizeCallResult(result, { retryTool: null }),
      ...result,
    };
  }
}
