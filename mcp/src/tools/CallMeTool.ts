import { MCPTool } from "mcp-framework";
import { z } from "zod";

const schema = z.object({
  message: z.string().describe("Message to speak to the owner's verified phone (1-2000 chars)."),
  mode: z
    .enum(["notify", "converse"])
    .optional()
    .describe("'notify' delivers and hangs up; 'converse' also relays the spoken reply."),
});

/**
 * DEFERRED to v2. Registered so the surface is documented and discoverable, but
 * intentionally inert: the Speko platform exposes no verified personal phone today,
 * so call_me cannot resolve a target. Throwing yields a clean isError tool result.
 */
export default class CallMeTool extends MCPTool {
  name = "call_me";
  description =
    "Ring the account owner's own verified phone to deliver a message ('notify') or relay a spoken " +
    "reply ('converse'). DEFERRED to v2: the Speko platform does not yet expose a verified personal " +
    "phone, so this is not available in v1.";
  schema = schema;
  override annotations = {
    title: "Call Me",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  async execute(_input: z.infer<typeof schema>): Promise<never> {
    throw new Error(
      "call_me is not available in v1: the Speko platform does not yet expose a verified personal " +
        "phone number. Use lookup_business + make_call to call a business; " +
        "next_step=Track call_me for v2 (needs a verified-owner-phone field on the platform).",
    );
  }
}
