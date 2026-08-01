/**
 * Library entry — lets the published MCP embed the backing logic IN-PROCESS (no
 * Express, no localhost HTTP hop) so `npx @spekoai/mcp-calls` + a SPEKO_API_KEY works
 * as a single process. This module is SIDE-EFFECT FREE: importing it must never start
 * the Express server (that lives in index.ts) — it only re-exports the callable core.
 *
 * The MCP's in-process backend builds a context with `buildContext(loadConfig())` and
 * calls these exactly like routes.ts does.
 */
export { loadConfig, ConfigError, serverBearerHash } from "./config.js";
export type { AppConfig, DemoConfig } from "./config.js";
export { buildContext } from "./http/context.js";
export type { ServerContext } from "./http/context.js";
export { lookupBusiness } from "./lookup/index.js";
export { makeCall } from "./calls/makeCall.js";
export { callNumber } from "./calls/callNumber.js";
export type { CallNumberInput } from "./calls/callNumber.js";
export { callMe } from "./calls/callMe.js";
export { placeOwnerVerificationCall } from "./calls/ownerVerification.js";
export { checkReadiness } from "./calls/readiness.js";
export { describeCall } from "./calls/getCall.js";
export { AppError, RejectionError } from "./lib/errors.js";
export { dncAdd, dncList, dncRemove, normalizeE164, resolveGuardStateDir } from "./safety/guard.js";
export {
  checkOwnerVerificationCode,
  createOwnerVerificationChallenge,
  normalizeNanpOwnerPhone,
  readOwnerProfile,
  resolveOwnerStateDir,
  writeOwnerProfile,
} from "./owner/state.js";
export type { OwnerProfile, OwnerVerificationChallenge } from "./owner/state.js";
export type { CallMeInput, CallSummary, SessionDetail, MakeCallInput } from "./types.js";
