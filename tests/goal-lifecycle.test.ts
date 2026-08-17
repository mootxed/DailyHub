import { describe, expect, it } from "vitest";
import {
  getTrackingStartMs,
  hasGoalTrackingStartedByDate,
  isGoalTrackingActiveAt,
  isValidTrackingStartedAt,
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
});
