import { describe, expect, it } from "vitest";
import {
  getTrackingStartMs,
  hasGoalTrackingStartedByDate,
  isGoalPaused,
  isGoalPausedAt,
  isGoalTrackingActiveAt,
  isValidTrackingStartedAt,
  pauseGoal,
  resumeGoal,
  startGoalTracking
} from "../src/goal-lifecycle";
import type { DailyGoal } from "../src/models";

function goal(trackingStartedAt?: string): DailyGoal {
  return {
    id: "study",
    name: "Study",
    targetMinutes: 30,
    trackingStartedAt,
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: true
  };
}

describe("goal tracking lifecycle", () => {
  it("validates persisted timestamps and treats invalid values as legacy", () => {
    expect(isValidTrackingStartedAt("2026-08-17T11:40:12.123Z")).toBe(true);
    expect(isValidTrackingStartedAt("banana")).toBe(false);
    expect(isValidTrackingStartedAt("")).toBe(false);
    expect(isValidTrackingStartedAt(undefined)).toBe(false);
    expect(getTrackingStartMs(goal("banana"))).toBeUndefined();
    expect(isGoalTrackingActiveAt(goal(), 0)).toBe(true);
  });

  it("becomes active at the exact tracking timestamp", () => {
    const startedAt = Date.parse("2026-08-17T11:40:12.123Z");
    const tracked = goal(new Date(startedAt).toISOString());

    expect(getTrackingStartMs(tracked)).toBe(startedAt);
    expect(isGoalTrackingActiveAt(tracked, startedAt - 1)).toBe(false);
    expect(isGoalTrackingActiveAt(tracked, startedAt)).toBe(true);
    expect(isGoalTrackingActiveAt(tracked, startedAt + 1)).toBe(true);
  });

  it("uses local calendar boundaries for date-level tracking", () => {
    const localCreation = new Date(2026, 7, 17, 0, 30);
    const tracked = goal(localCreation.toISOString());

    expect(hasGoalTrackingStartedByDate(tracked, "2026-08-16")).toBe(false);
    expect(hasGoalTrackingStartedByDate(tracked, "2026-08-17")).toBe(true);
    expect(hasGoalTrackingStartedByDate(tracked, "2026-08-18")).toBe(true);
    expect(hasGoalTrackingStartedByDate(goal(), "2026-08-16")).toBe(true);
  });

  it("sets a canonical timestamp once and preserves an existing start", () => {
    const startedAt = new Date("2026-08-17T11:40:12.123Z");
    const started = startGoalTracking(goal(), startedAt);
    expect(started.trackingStartedAt).toBe("2026-08-17T11:40:12.123Z");

    const existing = goal("2026-08-01T00:00:00.000Z");
    expect(startGoalTracking(existing, startedAt)).toBe(existing);
    expect(startGoalTracking(goal("banana"), startedAt).trackingStartedAt).toBe(startedAt.toISOString());
  });

  it("pauses and resumes at exact interval boundaries", () => {
    const tracked = goal("2026-08-18T09:00:00.000Z");
    expect(pauseGoal(tracked, "2026-08-18T10:00:00.000Z")).toBe(true);
    expect(isGoalPausedAt(tracked, Date.parse("2026-08-18T09:59:59.999Z"))).toBe(false);
    expect(isGoalPausedAt(tracked, Date.parse("2026-08-18T10:00:00.000Z"))).toBe(true);
    expect(isGoalTrackingActiveAt(tracked, Date.parse("2026-08-18T10:10:00.000Z"))).toBe(false);

    expect(resumeGoal(tracked, "2026-08-18T10:20:00.000Z")).toBe(true);
    expect(isGoalPausedAt(tracked, Date.parse("2026-08-18T10:19:59.999Z"))).toBe(true);
    expect(isGoalPausedAt(tracked, Date.parse("2026-08-18T10:20:00.000Z"))).toBe(false);
    expect(isGoalPaused(tracked, new Date("2026-08-18T10:20:00.000Z"))).toBe(false);
  });

  it("makes repeated pause and resume operations safe no-ops", () => {
    const tracked = goal();
    expect(pauseGoal(tracked, "2026-08-18T10:00:00.000Z")).toBe(true);
    expect(pauseGoal(tracked, "2026-08-18T10:05:00.000Z")).toBe(false);
    expect(tracked.trackingPauses).toHaveLength(1);
    expect(resumeGoal(tracked, "2026-08-18T10:20:00.000Z")).toBe(true);
    expect(resumeGoal(tracked, "2026-08-18T10:25:00.000Z")).toBe(false);
    expect(tracked.trackingPauses).toEqual([{
      startedAt: "2026-08-18T10:00:00.000Z",
      endedAt: "2026-08-18T10:20:00.000Z"
    }]);
  });

  it("safely rejects invalid timestamps and malformed pause state", () => {
    const tracked = goal();
    expect(isGoalPausedAt(tracked, Number.NaN)).toBe(false);
    expect(isGoalPausedAt({ trackingPauses: [{ startedAt: "invalid" }] }, 0)).toBe(false);
    expect(isGoalPausedAt({
      trackingPauses: [{ startedAt: "2026-08-18T10:00:00.000Z", endedAt: "invalid" }]
    }, Date.parse("2026-08-18T10:10:00.000Z"))).toBe(false);
    expect(pauseGoal(tracked, "invalid")).toBe(false);
    expect(pauseGoal(tracked, new Date(Number.NaN))).toBe(false);
    expect(resumeGoal(tracked, "invalid")).toBe(false);
    expect(resumeGoal(tracked, Date.parse("2026-08-18T10:00:00.000Z"))).toBe(false);

    tracked.trackingPauses = [{ startedAt: "invalid" }];
    expect(pauseGoal(tracked, Date.parse("2026-08-18T10:00:00.000Z"))).toBe(false);
    expect(resumeGoal(tracked, "2026-08-18T10:20:00.000Z")).toBe(false);

    tracked.trackingPauses = [{ startedAt: "2026-08-18T10:20:00.000Z" }];
    expect(resumeGoal(tracked, "2026-08-18T10:00:00.000Z")).toBe(false);
  });

  it("closes only the open interval when prior pauses exist", () => {
    const tracked = goal();
    tracked.trackingPauses = [
      { startedAt: "2026-08-18T09:00:00.000Z", endedAt: "2026-08-18T09:20:00.000Z" },
      { startedAt: "2026-08-18T10:00:00.000Z" }
    ];
    expect(resumeGoal(tracked, new Date("2026-08-18T10:20:00.000Z"))).toBe(true);
    expect(tracked.trackingPauses[0]?.endedAt).toBe("2026-08-18T09:20:00.000Z");
    expect(tracked.trackingPauses[1]?.endedAt).toBe("2026-08-18T10:20:00.000Z");
  });
});
