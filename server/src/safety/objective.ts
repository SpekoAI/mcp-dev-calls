import { OBJECTIVE_BLOCK_RE, OBJECTIVE_MIN_CHARS } from "../constants.js";

/**
 * Why the objective may not drive an outbound call, or null when allowed.
 * Block-list always wins: a blocked intent cannot ride in on transactional wording.
 * Objectives matching no block-list keyword are allowed by design.
 */
export function objectiveBlockedReason(objective: string): string | null {
  const cleaned = typeof objective === "string" ? objective.trim() : "";
  if (cleaned.length < OBJECTIVE_MIN_CHARS) {
    return (
      "Objective is too short; ask a fuller question, for example " +
      "'Do you have a table for 4 at 8pm tonight?'."
    );
  }
  if (OBJECTIVE_BLOCK_RE.test(cleaned)) {
    return (
      "Objective is blocked by the transactional-objectives-only policy: calls may only ask " +
      "transactional questions (availability, reservations, pricing, order status); selling, " +
      "promotion, surveys, fundraising, and campaigning are not allowed."
    );
  }
  return null;
}
