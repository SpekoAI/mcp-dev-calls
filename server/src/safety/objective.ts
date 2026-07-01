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

/**
 * Why the private `behavior` steering may not drive a call, or null when allowed. Same block-list
 * as the objective screen (no selling/promotion/surveys/etc.) but WITHOUT the min-length rule —
 * behavior is optional and short by nature. Closes the bypass where a blocked intent is moved from
 * `objective` (screened) into `behavior` (previously unscreened). Empty/absent behavior is allowed.
 */
export function behaviorBlockedReason(behavior: string | null | undefined): string | null {
  const cleaned = typeof behavior === "string" ? behavior.trim() : "";
  if (!cleaned) return null;
  if (OBJECTIVE_BLOCK_RE.test(cleaned)) {
    return (
      "The behavior guidance is blocked by the transactional-only policy: selling, promotion, " +
      "surveys, fundraising, and campaigning are not allowed on any call, and cannot be smuggled " +
      "in via the behavior channel."
    );
  }
  return null;
}
