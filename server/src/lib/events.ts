/**
 * Normalized type of a serialized platform event from GET /v1/calls/{id}/events.
 * The type can sit under `event_type` (current shape) or `type` (legacy), so read both.
 */
export function eventType(e: Record<string, unknown>): string {
  return String(e.event_type ?? e.type ?? "").toLowerCase();
}
