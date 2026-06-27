import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

const schema = z.object({
  name: z.string().min(1).describe('Business name, e.g. "Joe\'s Pizza".'),
  location: z.string().optional().describe("Optional city or area to disambiguate, e.g. 'New York'."),
  phone_number: z
    .string()
    .optional()
    .describe(
      "The business's official phone number in E.164 (e.g. +14155551234) if you can find it via web search. " +
        "When provided, this skips the directory lookup and verifies this exact number — it's still carrier-checked " +
        "as a business line before any call. Omit it to resolve by name + location instead.",
    ),
  utc_offset_minutes: z
    .number()
    .int()
    .optional()
    .describe(
      "Destination UTC offset in minutes for quiet-hours (e.g. -300 US Eastern, -480 US Pacific, 0 UK). " +
        "Pass this alongside phone_number when you know the business's region but its number isn't auto-recognized " +
        "(otherwise the offset is derived from the number).",
    ),
});

interface Candidate {
  name: string;
  phone: string;
  allowed: boolean;
  blocked_reason: string | null;
}

interface LookupResponse {
  candidates?: Candidate[];
  source?: string;
}

export default class LookupBusinessTool extends MCPTool {
  name = "lookup_business";
  description =
    "Resolve a business to dialable candidates and mint a signed dial_token for each callable one — " +
    "the only path that can authorize make_call (raw phone numbers are rejected). If you can find the " +
    "business's official number via web search, pass it as phone_number to skip the directory lookup; " +
    "otherwise pass name (plus optional location). Either way the number is carrier-verified as a business line.";
  schema = schema;
  override annotations = {
    title: "Lookup Business",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  async execute(input: z.infer<typeof schema>): Promise<Record<string, unknown>> {
    const out = (await getServerClient().post("/lookup", {
      name: input.name,
      location: input.location,
      phone_number: input.phone_number,
      utc_offset_minutes: input.utc_offset_minutes,
    })) as LookupResponse;

    const candidates = out.candidates ?? [];
    const lines = candidates.map((c) =>
      c.allowed
        ? `${c.name} (${c.phone}) is callable.`
        : `${c.name} (${c.phone}) is not callable: ${c.blocked_reason ?? "unknown reason"}`,
    );
    const summary = candidates.length
      ? `${lines.join(" ")} Pass the chosen candidate's dial_token to make_call.`
      : "No matching businesses with a dialable phone number were found. Try a more specific name or add a location.";

    return { summary, ...out };
  }
}
