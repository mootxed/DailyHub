import { describe, expect, it } from "vitest";
import { createDefaultSchedule, createEmptyGoal, type DailyGoal, type GoalProgress } from "../src/models";
import {
  applyDefaultTargetToAllDays,
  applyScheduleToProgress,
  getEffectiveGoalDay,
  getEffectiveTargetMinutes,
  getCustomTargetWeekdays,
  getGoalSchedule,
  getWeekday,
  isGoalScheduled,
  isValidTargetMinutes,
  parseDefaultTargetInput,
  parseTargetOverride,
  updateDefaultTarget,
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
      trackingStarted: true,
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

  it("gives lifecycle priority over overrides and starts planning on the local creation date", () => {
    const tracked = goal({
      trackingStartedAt: new Date(2026, 7, 17, 12).toISOString(),
      overrides: { "2026-08-16": { kind: "target", targetMinutes: 90 } }
    });

    expect(getEffectiveGoalDay(tracked, "2026-08-16")).toMatchObject({
      trackingStarted: false,
      scheduled: false,
      skipped: false,
      source: "schedule"
    });
    expect(getEffectiveGoalDay(tracked, "2026-08-17")).toMatchObject({
      trackingStarted: true,
      scheduled: true
    });
    expect(applyScheduleToProgress([tracked], [progress(3_600)], "2026-08-16")[0]).toMatchObject({
      activeSeconds: 0,
      completed: false,
      progressRatio: undefined
    });
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

describe("default target editing", () => {
  it("parses valid raw input and rejects invalid visible values", () => {
    expect(parseDefaultTargetInput("60")).toBe(60);
    expect(parseDefaultTargetInput("1.5")).toBe(1.5);
    expect(parseDefaultTargetInput("0")).toBeUndefined();
    expect(parseDefaultTargetInput("")).toBeUndefined();
    expect(parseDefaultTargetInput("abc")).toBeUndefined();
    expect(parseDefaultTargetInput("Infinity")).toBeUndefined();
  });

  it("updates inherited targets while preserving custom weekday targets", () => {
    const original = goal({ targetMinutes: 30, schedule: createDefaultSchedule(30) });
    getGoalSchedule(original).tuesday.targetMinutes = 45;

    const updated = updateDefaultTarget(original, 60);
    const updatedSchedule = getGoalSchedule(updated);

    expect(updated.targetMinutes).toBe(60);
    expect(updatedSchedule.monday.targetMinutes).toBe(60);
    expect(updatedSchedule.tuesday.targetMinutes).toBe(45);
    expect(updatedSchedule.wednesday.targetMinutes).toBe(60);
    expect(original.targetMinutes).toBe(30);
    expect(getGoalSchedule(original).monday.targetMinutes).toBe(30);
  });

  it("infers saved custom targets without treating inherited rest days as custom", () => {
    const schedule = createDefaultSchedule(30);
    schedule.tuesday.targetMinutes = 45;
    schedule.thursday.targetMinutes = 60;
    schedule.saturday = { enabled: false, targetMinutes: 30 };
    schedule.sunday = { enabled: false, targetMinutes: 45 };
    const original = goal({ targetMinutes: 30, schedule });
    const snapshot = structuredClone(original);

    expect(getCustomTargetWeekdays(original)).toEqual(new Set(["tuesday", "thursday", "sunday"]));
    expect(original).toEqual(snapshot);
  });

  it("finds no saved customs for inherited or legacy schedules", () => {
    expect(getCustomTargetWeekdays(createEmptyGoal())).toEqual(new Set());
    expect(getCustomTargetWeekdays(goal({
      targetMinutes: 30,
      schedule: createDefaultSchedule(30)
    }))).toEqual(new Set());
    expect(getCustomTargetWeekdays(goal({
      targetMinutes: 30,
      schedule: undefined
    }))).toEqual(new Set());
  });

  it("updates inherited stored targets on rest days and preserves custom ones", () => {
    const schedule = createDefaultSchedule(30);
    schedule.saturday = { enabled: false, targetMinutes: 30 };
    schedule.sunday = { enabled: false, targetMinutes: 45 };

    const updated = updateDefaultTarget(goal({ targetMinutes: 30, schedule }), 60);
    const updatedSchedule = getGoalSchedule(updated);

    expect(updatedSchedule.saturday).toEqual({ enabled: false, targetMinutes: 60 });
    expect(updatedSchedule.sunday).toEqual({ enabled: false, targetMinutes: 45 });
  });

  it("carries inherited targets through multiple changes without changing overrides", () => {
    const original = goal({
      targetMinutes: 30,
      schedule: createDefaultSchedule(30),
      overrides: {
        "2026-08-20": { kind: "target", targetMinutes: 90 },
        "2026-08-21": { kind: "skip" }
      }
    });
    getGoalSchedule(original).tuesday.targetMinutes = 45;
    const overrides = structuredClone(original.overrides);

    const updated = updateDefaultTarget(updateDefaultTarget(original, 60), 90);
    const updatedSchedule = getGoalSchedule(updated);

    expect(updatedSchedule.monday.targetMinutes).toBe(90);
    expect(updatedSchedule.tuesday.targetMinutes).toBe(45);
    expect(updated.overrides).toEqual(overrides);
    expect(original.overrides).toEqual(overrides);
  });

  it("preserves an explicitly edited weekday after it collides with a later default", () => {
    const protectedWeekdays = new Set(["tuesday", "saturday"] as const);
    const original = goal({ targetMinutes: 30, schedule: createDefaultSchedule(30) });
    getGoalSchedule(original).tuesday.targetMinutes = 60;
    getGoalSchedule(original).saturday = { enabled: false, targetMinutes: 60 };

    const sixty = updateDefaultTarget(original, 60, protectedWeekdays);
    const ninety = updateDefaultTarget(sixty, 90, protectedWeekdays);

    expect(getGoalSchedule(ninety).monday.targetMinutes).toBe(90);
    expect(getGoalSchedule(ninety).tuesday.targetMinutes).toBe(60);
    expect(getGoalSchedule(ninety).saturday).toEqual({ enabled: false, targetMinutes: 60 });
  });

  it("preserves saved custom targets through repeated default collisions", () => {
    const schedule = createDefaultSchedule(30);
    schedule.tuesday.targetMinutes = 45;
    schedule.thursday.targetMinutes = 60;
    schedule.sunday = { enabled: false, targetMinutes: 45 };
    let updated = goal({ targetMinutes: 30, schedule });
    const protectedWeekdays = getCustomTargetWeekdays(updated);

    updated = updateDefaultTarget(updated, 45, protectedWeekdays);
    expect(getGoalSchedule(updated).tuesday.targetMinutes).toBe(45);
    updated = updateDefaultTarget(updated, 60, protectedWeekdays);
    expect(getGoalSchedule(updated).tuesday.targetMinutes).toBe(45);
    updated = updateDefaultTarget(updated, 90, protectedWeekdays);

    const updatedSchedule = getGoalSchedule(updated);
    expect(updatedSchedule.monday.targetMinutes).toBe(90);
    expect(updatedSchedule.wednesday.targetMinutes).toBe(90);
    expect(updatedSchedule.tuesday.targetMinutes).toBe(45);
    expect(updatedSchedule.thursday.targetMinutes).toBe(60);
    expect(updatedSchedule.sunday).toEqual({ enabled: false, targetMinutes: 45 });
  });

  it("propagates from the last valid default after invalid raw input", () => {
    const original = goal({ targetMinutes: 30, schedule: createDefaultSchedule(30) });

    expect(parseDefaultTargetInput("0")).toBeUndefined();
    expect(original.targetMinutes).toBe(30);
    expect(getGoalSchedule(original).monday.targetMinutes).toBe(30);

    const sixty = updateDefaultTarget(original, parseDefaultTargetInput("60") ?? 0);
    expect(sixty.targetMinutes).toBe(60);
    expect(getGoalSchedule(sixty).monday.targetMinutes).toBe(60);

    expect(parseDefaultTargetInput("")).toBeUndefined();
    const ninety = updateDefaultTarget(sixty, parseDefaultTargetInput("90") ?? 0);
    expect(ninety.targetMinutes).toBe(90);
    expect(getGoalSchedule(ninety).monday.targetMinutes).toBe(90);
  });

  it("resets custom targets to the default and makes them inherited again", () => {
    const schedule = createDefaultSchedule(30);
    schedule.tuesday.targetMinutes = 45;
    schedule.saturday.enabled = false;
    const original = goal({ targetMinutes: 30, schedule });
    const protectedWeekdays = getCustomTargetWeekdays(original);

    const reset = applyDefaultTargetToAllDays(original);
    protectedWeekdays.clear();
    const updated = updateDefaultTarget(reset, 60, protectedWeekdays);

    expect(getGoalSchedule(reset).tuesday.targetMinutes).toBe(30);
    expect(getGoalSchedule(updated).tuesday.targetMinutes).toBe(60);
    expect(getGoalSchedule(updated).saturday).toEqual({ enabled: false, targetMinutes: 60 });
    expect(updated.overrides).toBe(original.overrides);

    getGoalSchedule(updated).tuesday.targetMinutes = 45;
    protectedWeekdays.add("tuesday");
    const customized = updateDefaultTarget(updated, 90, protectedWeekdays);
    expect(getGoalSchedule(customized).monday.targetMinutes).toBe(90);
    expect(getGoalSchedule(customized).tuesday.targetMinutes).toBe(45);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid target %s without mutating the goal",
    (targetMinutes) => {
      const original = goal();
      const snapshot = structuredClone(original);

      expect(() => updateDefaultTarget(original, targetMinutes)).toThrow("Invalid default target");
      expect(original).toEqual(snapshot);
    }
  );
});
