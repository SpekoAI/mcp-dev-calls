import {
  COLLECTION_RE,
  HARASSMENT_BLOCK_RE,
  IMPERSONATION_BLOCK_RE,
  OBJECTIVE_BLOCK_RE,
  OBJECTIVE_MIN_CHARS,
} from "../constants.js";

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
  if (HARASSMENT_BLOCK_RE.test(cleaned)) {
    return "Objective is blocked: calls may not be used to harass, prank, threaten, or intimidate anyone.";
  }
  if (IMPERSONATION_BLOCK_RE.test(cleaned)) {
    return (
      "Objective is blocked: the assistant always discloses itself as an AI calling on behalf " +
      "of the named human; objectives that instruct it to pretend to be someone else are blocked."
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
  if (HARASSMENT_BLOCK_RE.test(cleaned)) {
    return "The behavior guidance is blocked: calls may not be used to harass, prank, threaten, or intimidate anyone.";
  }
  if (IMPERSONATION_BLOCK_RE.test(cleaned)) {
    return (
      "The behavior guidance is blocked: the assistant always discloses itself as an AI calling " +
      "on behalf of the named human; instructions to pretend to be someone else are blocked."
    );
  }
  return null;
}

/**
 * Why private context may not be supplied to the call, or null when allowed.
 * Same screen as behavior, but names the context channel in the rejection.
 */
export function contextBlockedReason(context: string | null | undefined): string | null {
  const cleaned = typeof context === "string" ? context.trim() : "";
  if (!cleaned) return null;
  if (OBJECTIVE_BLOCK_RE.test(cleaned)) {
    return (
      "The context channel is blocked by the transactional-only policy: selling, promotion, " +
      "surveys, fundraising, and campaigning are not allowed on any call, and cannot be smuggled " +
      "in via the context channel."
    );
  }
  if (HARASSMENT_BLOCK_RE.test(cleaned)) {
    return "The context channel is blocked: calls may not be used to harass, prank, threaten, or intimidate anyone.";
  }
  if (IMPERSONATION_BLOCK_RE.test(cleaned)) {
    return (
      "The context channel is blocked: the assistant always discloses itself as an AI calling " +
      "on behalf of the named human; context that instructs it to pretend to be someone else is blocked."
    );
  }
  return null;
}

export function collectionMatch(texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => {
    const cleaned = typeof text === "string" ? text.trim() : "";
    return Boolean(cleaned && COLLECTION_RE.test(cleaned));
  });
}
