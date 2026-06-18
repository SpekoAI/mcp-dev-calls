import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { getServerClient } from "../http/serverClient.js";

const schema = z.object({
  name: z.string().min(1).describe('Business name, e.g. "Joe\'s Pizza".'),
  location: z.string().optional().describe("Optional city or area to disambiguate, e.g. 'New York'."),
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
    "Resolve a business name (plus optional location) to dialable candidates and mint a signed " +
    "dial_token for each callable one. This is the only path that can authorize make_call — raw " +
    "phone numbers are rejected.";
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
