import { describe, expect, it } from "vitest";
import { createDefaultSchedule, type DailyGoal, type GoalProgress } from "../src/models";
import {
  applyScheduleToProgress,
  getEffectiveGoalDay,
  getEffectiveTargetMinutes,
  getGoalSchedule,
  getWeekday,
  isGoalScheduled,
  isValidTargetMinutes,
  parseTargetOverride,
  withGoalDayOverride
} from "../src/schedule";

function goal(overrides: Partial<DailyGoal> = {}): DailyGoal {
  return {
    id: "devops",
    name: "DevOps",
    targetMinutes: 60,
    schedule: createDefaultSchedule(60),
    overrides: {},
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: true,
    ...overrides
  };
}

function progress(seconds: number): GoalProgress {
  return {
    goalId: "devops",
    activeSeconds: seconds,
    actualMinutes: seconds / 60,
    targetMinutes: 60,
    completed: seconds >= 3_600,
    progressRatio: seconds / 3_600
  };
}

describe("effective goal schedules", () => {
  it("maps local calendar dates to weekdays", () => {
    expect(getWeekday("2026-08-17")).toBe("monday");
    expect(getWeekday("2026-08-23")).toBe("sunday");
    expect(() => getWeekday("2026-02-30")).toThrow("Invalid date");
  });

  it("uses the legacy target on every day when schedule data is absent", () => {
    const legacy = goal({ schedule: undefined });
    expect(getGoalSchedule(legacy)).toEqual(createDefaultSchedule(60));
    expect(getEffectiveGoalDay(legacy, "2026-08-17")).toEqual({
      goalId: "devops",
      scheduled: true,
      skipped: false,
      targetMinutes: 60,
      source: "schedule"
    });
  });

  it("resolves regular days, rest days, disabled goals, and helper values", () => {
    const schedule = createDefaultSchedule(60);
    schedule.sunday = { enabled: false, targetMinutes: 60 };
    const scheduled = goal({ schedule });
    expect(isGoalScheduled(scheduled, "2026-08-17")).toBe(true);
    expect(getEffectiveTargetMinutes(scheduled, "2026-08-17")).toBe(60);
    expect(getEffectiveGoalDay(scheduled, "2026-08-23")).toMatchObject({
      scheduled: false,
      skipped: false,
      source: "schedule"
    });
    expect(getEffectiveGoalDay(goal({ enabled: false }), "2026-08-17").scheduled).toBe(false);
  });

  it("gives target and skip overrides priority over the weekday schedule", () => {
    const schedule = createDefaultSchedule(60);
    schedule.monday = { enabled: false, targetMinutes: 60 };
    const overridden = goal({
      schedule,
      overrides: {
        "2026-08-17": { kind: "target", targetMinutes: 90 },
        "2026-08-18": { kind: "skip" }
      }
    });
    expect(getEffectiveGoalDay(overridden, "2026-08-17")).toMatchObject({
      scheduled: true,
      targetMinutes: 90,
      source: "override"
    });
    expect(getEffectiveGoalDay(overridden, "2026-08-18")).toMatchObject({
      scheduled: false,
      skipped: true,
      source: "override"
    });
    expect(getEffectiveGoalDay({ ...overridden, enabled: false }, "2026-08-17").scheduled).toBe(false);
  });

  it("recalculates completion from raw attribution using the effective target", () => {
    const overridden = goal({ overrides: { "2026-08-17": { kind: "target", targetMinutes: 90 } } });
    expect(applyScheduleToProgress([overridden], [progress(89 * 60)], "2026-08-17")[0]).toMatchObject({
      activeSeconds: 89 * 60,
      actualMinutes: 89,
      targetMinutes: 90,
      completed: false,
      progressRatio: 89 / 90
    });
    expect(applyScheduleToProgress([overridden], [progress(90 * 60)], "2026-08-17")[0]?.completed).toBe(true);
    expect(applyScheduleToProgress([overridden], [], "2026-08-17")[0]?.activeSeconds).toBe(0);

    const skipped = goal({ overrides: { "2026-08-17": { kind: "skip" } } });
    expect(applyScheduleToProgress([skipped], [progress(3_600)], "2026-08-17")[0]).toMatchObject({
      scheduled: false,
      completed: false,
      progressRatio: undefined,
      activeSeconds: 3_600
    });
  });
});

describe("override editing", () => {
  it("validates target values and parses editor input", () => {
    expect(isValidTargetMinutes(1)).toBe(true);
    expect(isValidTargetMinutes(1.5)).toBe(true);
    expect(isValidTargetMinutes(0)).toBe(false);
    expect(isValidTargetMinutes(-1)).toBe(false);
    expect(isValidTargetMinutes(Number.NaN)).toBe(false);
    expect(isValidTargetMinutes(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidTargetMinutes("30")).toBe(false);
    expect(parseTargetOverride("90")).toEqual({ kind: "target", targetMinutes: 90 });
    expect(parseTargetOverride("0")).toBeUndefined();
    expect(parseTargetOverride("not a number")).toBeUndefined();
  });

  it("sets, replaces, and resets one date without mutating the original goal", () => {
    const original = goal({ overrides: undefined });
    const targeted = withGoalDayOverride(original, "2026-08-17", { kind: "target", targetMinutes: 90 });
    const skipped = withGoalDayOverride(targeted, "2026-08-17", { kind: "skip" });
    const reset = withGoalDayOverride(skipped, "2026-08-17", undefined);

    expect(original.overrides).toBeUndefined();
    expect(targeted.overrides).toEqual({ "2026-08-17": { kind: "target", targetMinutes: 90 } });
    expect(skipped.overrides).toEqual({ "2026-08-17": { kind: "skip" } });
    expect(reset.overrides).toEqual({});
    expect(() => withGoalDayOverride(original, "2026-08-17", {
      kind: "target",
      targetMinutes: 0
    })).toThrow("Invalid target override");
    expect(() => withGoalDayOverride(original, "bad-date", { kind: "skip" })).toThrow("Invalid date");
  });
});
