import { beforeEach } from "vitest";
import { resetCallMeBusyForTests } from "../src/calls/callMeResult.js";
import { resetDialReplayGuard } from "../src/calls/makeCall.js";

// The dial replay guard is a module-level TTL cache keyed on number+objective. Tests across a
// file legitimately re-dial the same fixture number with the same objective; without a reset,
// the guard would reject those as duplicates and every suite would be order-dependent.
beforeEach(() => {
  resetDialReplayGuard();
  resetCallMeBusyForTests();
});
