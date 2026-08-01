import { afterEach, describe, expect, it, vi } from "vitest";
import { clampCallWait, startCallProgress } from "../src/tools/_shared/callProgress.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("call progress", () => {
  it.each([
    [undefined, 300],
    [1, 30],
    [30, 30],
    [180, 180],
    [999, 300],
  ])("clamps requested wait %s to %s", (requested, expected) => {
    expect(clampCallWait(requested)).toBe(expected);
  });

  it("reports immediately, uses wall-clock time, and keeps value and message bounded together", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const report = vi.fn(async () => {});
    const stop = startCallProgress(report, 30);

    expect(report).toHaveBeenCalledWith(0, 30, "Placing the call...");

    vi.setSystemTime(new Date("2026-01-01T00:00:35Z"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report).toHaveBeenLastCalledWith(30, 30, "Call in progress - 30s elapsed");

    vi.setSystemTime(new Date("2025-12-31T23:59:50Z"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report).toHaveBeenLastCalledWith(0, 30, "Call in progress - 0s elapsed");

    stop();
  });

  it("cleans up idempotently and swallows progress reporter failures", async () => {
    vi.useFakeTimers();
    const report = vi.fn(() => Promise.reject(new Error("client disconnected")));
    const stop = startCallProgress(report, 60);
    await Promise.resolve();
    stop();
    stop();
    const callsAfterStop = report.mock.calls.length;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(report).toHaveBeenCalledTimes(callsAfterStop);
  });
});
