import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

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
    return (await getServerClient().get(`/call/${id}`)) as Record<string, unknown>;
  }
}
