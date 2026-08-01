import {
  beginOwnerCallLease,
  reserveOwnerVerificationCall,
} from "../../src/owner/state.js";

const [mode, dir, workerId] = process.argv.slice(2);
const ownerPhone = "+12025550123";
const nowMs = Date.parse("2026-08-01T12:00:00.000Z");

if (!mode || !dir || !workerId) throw new Error("mode, state directory, and worker id are required");

process.stdout.write("ready\n");
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  let accepted = false;
  let error: string | null = null;
  try {
    if (mode === "lease") {
      const claim = beginOwnerCallLease(
        {
          ownerPhone,
          instanceId: "11111111-2222-4333-8444-555555555555",
          mode: "converse",
          message: `worker-${workerId}`,
          context: null,
          ttlMs: 360_000,
        },
        { dir, nowMs },
      );
      accepted = claim.active.token === claim.token;
    } else if (mode === "otp") {
      reserveOwnerVerificationCall(ownerPhone, { dir, nowMs });
      accepted = true;
    } else {
      throw new Error(`unknown mode: ${mode}`);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  process.stdout.write(`${JSON.stringify({ accepted, error })}\n`);
  process.stdin.unref();
});
