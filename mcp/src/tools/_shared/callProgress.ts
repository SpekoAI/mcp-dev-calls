export const MIN_CALL_WAIT_SECONDS = 30;
export const MAX_CALL_WAIT_SECONDS = 300;

const HEARTBEAT_MS = 5_000;

export type ReportCallProgress = (progress: number, total: number, message: string) => void | Promise<void>;

export function clampCallWait(value: number | undefined): number {
  const requested = value ?? MAX_CALL_WAIT_SECONDS;
  return Math.min(Math.max(requested, MIN_CALL_WAIT_SECONDS), MAX_CALL_WAIT_SECONDS);
}

function reportSafely(report: ReportCallProgress, progress: number, total: number, message: string): void {
  try {
    void Promise.resolve(report(progress, total, message)).catch(() => {});
  } catch {
    // Progress is best-effort and must never change the call result.
  }
}

/** Start the shared call heartbeat and return an idempotent cleanup function. */
export function startCallProgress(report: ReportCallProgress, maxWait: number): () => void {
  const startedAtMs = Date.now();
  reportSafely(report, 0, maxWait, "Placing the call...");

  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1_000);
    const progressSeconds = Math.min(Math.max(elapsedSeconds, 0), maxWait);
    reportSafely(report, progressSeconds, maxWait, `Call in progress - ${progressSeconds}s elapsed`);
  }, HEARTBEAT_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
