import { describe, expect, it } from "vitest";
import { calculateRangeAnalytics, getHeatmapLevel } from "../src/analytics";
import { getLocalDateRange } from "../src/date";
import { createDefaultSchedule, type ActivityEvent, type DailyGoal, type DayActivity, type GoalProgress } from "../src/models";
import { calculateRangeProgress, type DayProgressResult } from "../src/range-progress";

const devopsGoal: DailyGoal = {
  id: "devops",
  name: "DevOps",
  targetMinutes: 60,
  rules: [],
  contextTimeoutMinutes: 10,
  enabled: true
};

const typingGoal: DailyGoal = {
  id: "typing",
  name: "Typing",
  targetMinutes: 30,
  rules: [],
  contextTimeoutMinutes: 10,
  enabled: true
};

const goals: DailyGoal[] = [
  devopsGoal,
  typingGoal,
  { id: "off", name: "Disabled", targetMinutes: 10, rules: [], contextTimeoutMinutes: 10, enabled: false }
];

function item(goalId: string, seconds: number, targetMinutes: number): GoalProgress {
  return {
    goalId,
    activeSeconds: seconds,
    actualMinutes: seconds / 60,
    targetMinutes,
    completed: seconds >= targetMinutes * 60,
    progressRatio: seconds / (targetMinutes * 60)
  };
}

function day(dateKey: string, devops: number, typing: number): DayProgressResult {
  return {
    dateKey,
    future: false,
    progress: [item("devops", devops, 60), item("typing", typing, 30)]
  };
}

describe("30-day range analytics", () => {
  it("calculates totals, available-day average, active days, opportunities, and stable goal order", () => {
    const analytics = calculateRangeAnalytics(goals, [
      day("2026-08-14", 3_600, 1_800),
      day("2026-08-15", 0, 900),
      { dateKey: "2026-08-16", future: false, progress: undefined },
      day("2026-08-17", 0, 0)
    ]);

    expect(analytics).toMatchObject({
      totalSeconds: 6_300,
      averageSeconds: 2_100,
      activeDays: 2,
      availableDays: 3,
      completedGoals: 2,
      goalOpportunities: 6,
      completionRate: 1 / 3
    });
    expect(analytics.goals.map((goal) => goal.goalId)).toEqual(["devops", "typing"]);
    expect(analytics.days[2]).toEqual({
      dateKey: "2026-08-16",
      available: false,
      totalSeconds: undefined,
      completedGoals: undefined,
      goalCount: 2,
      progressRatio: undefined
    });
  });

  it("does not let an incomplete current day erase yesterday's current streak", () => {
    const analytics = calculateRangeAnalytics([devopsGoal], [
      day("2026-08-14", 0, 0),
      day("2026-08-15", 3_600, 0),
      day("2026-08-16", 3_600, 0),
      day("2026-08-17", 0, 0)
    ]);
    expect(analytics.goals[0]).toMatchObject({ currentStreak: 2, bestStreak: 2 });
  });

  it("includes today when complete and finds a longer historical best streak", () => {
    const analytics = calculateRangeAnalytics([devopsGoal], [
      day("2026-08-11", 3_600, 0),
      day("2026-08-12", 3_600, 0),
      day("2026-08-13", 3_600, 0),
      day("2026-08-14", 0, 0),
      day("2026-08-15", 3_600, 0),
      day("2026-08-16", 3_600, 0),
      day("2026-08-17", 3_600, 0)
    ]);
    expect(analytics.goals[0]).toMatchObject({ currentStreak: 3, bestStreak: 3 });
  });

  it("breaks streak certainty at an unavailable historical or current day", () => {
    const historicalGap = calculateRangeAnalytics([devopsGoal], [
      day("2026-08-14", 3_600, 0),
      { dateKey: "2026-08-15", future: false, progress: undefined },
      day("2026-08-16", 3_600, 0),
      day("2026-08-17", 0, 0)
    ]).goals[0];
    expect(historicalGap).toMatchObject({ currentStreak: 1, bestStreak: 1, streakMayBeIncomplete: true });

    const currentGap = calculateRangeAnalytics([devopsGoal], [
      day("2026-08-16", 3_600, 0),
      { dateKey: "2026-08-17", future: false, progress: undefined }
    ]).goals[0];
    expect(currentGap?.currentStreak).toBe(0);
  });

  it("normalizes and caps heatmap intensity across enabled goals", () => {
    expect(getHeatmapLevel(0)).toBe(0);
    expect(getHeatmapLevel(0.25)).toBe(1);
    expect(getHeatmapLevel(0.5)).toBe(2);
    expect(getHeatmapLevel(0.75)).toBe(3);
    expect(getHeatmapLevel(0.99)).toBe(4);
    expect(getHeatmapLevel(1)).toBe(5);
    expect(getHeatmapLevel(3)).toBe(5);
    expect(getHeatmapLevel(-1)).toBe(0);

    const analytics = calculateRangeAnalytics(goals, [{
      dateKey: "2026-08-17",
      future: false,
      progress: [item("devops", 10_800, 60), item("typing", 900, 30)]
    }]);
    expect(analytics.days[0]?.progressRatio).toBe(0.75);
  });

  it("keeps overlapping activity assigned to the global deterministic winner", () => {
    const overlapping: DailyGoal[] = [
      { ...devopsGoal, id: "b", name: "B", targetMinutes: 5, rules: [{ id: "b-rule", role: "primary", field: "application", operator: "equals", value: "Browser", countDuringAfk: false }] },
      { ...devopsGoal, id: "a", name: "A", targetMinutes: 5, rules: [{ id: "a-rule", role: "primary", field: "application", operator: "equals", value: "Browser", countDuringAfk: false }] }
    ];
    const event: ActivityEvent = {
      timestamp: getLocalDateRange("2026-08-17").start.toISOString(),
      duration: 600,
      data: { app: "Browser" }
    };
    const activity: DayActivity = { windowEvents: [event], browserEvents: [], afkEvents: [] };
    const range = calculateRangeProgress(overlapping, [{ dateKey: "2026-08-17", future: false, activity }]);
    const analytics = calculateRangeAnalytics(overlapping, range);

    expect(analytics.totalSeconds).toBe(600);
    expect(analytics.goals.map((goal) => [goal.goalId, goal.totalSeconds])).toEqual([["b", 0], ["a", 600]]);
    expect(range[0]?.progress?.reduce((total, progress) => total + progress.activeSeconds, 0)).toBe(600);
  });

  it("returns undefined rates when no days or goal opportunities are available", () => {
    expect(calculateRangeAnalytics(goals, []).averageSeconds).toBeUndefined();
    const noGoals = calculateRangeAnalytics([], [day("2026-08-17", 0, 0)]);
    expect(noGoals).toMatchObject({ availableDays: 1, goalOpportunities: 0, completionRate: undefined });
    expect(noGoals.days[0]?.progressRatio).toBeUndefined();
  });

  it("treats all-rest heatmap days as neutral and excludes rest goals from mixed ratios", () => {
    const devopsSchedule = createDefaultSchedule(60);
    const typingSchedule = createDefaultSchedule(30);
    devopsSchedule.monday.enabled = false;
    typingSchedule.monday.enabled = false;
    const rest = calculateRangeAnalytics([
      { ...devopsGoal, schedule: devopsSchedule },
      { ...typingGoal, schedule: typingSchedule }
    ], [day("2026-08-17", 1_080, 0)]);
    expect(rest.days[0]).toMatchObject({
      available: true,
      totalSeconds: 1_080,
      completedGoals: 0,
      goalCount: 0,
      progressRatio: undefined
    });
    expect(rest.goalOpportunities).toBe(0);

    typingSchedule.monday = { enabled: true, targetMinutes: 30 };
    const japanese: DailyGoal = {
      ...devopsGoal,
      id: "japanese",
      name: "Japanese",
      targetMinutes: 30,
      schedule: createDefaultSchedule(30)
    };
    const mixed = calculateRangeAnalytics([
      { ...devopsGoal, schedule: devopsSchedule },
      { ...typingGoal, schedule: typingSchedule },
      japanese
    ], [{
      dateKey: "2026-08-17",
      future: false,
      progress: [item("devops", 2_000, 60), item("typing", 900, 30), item("japanese", 1_800, 30)]
    }]);
    expect(mixed.days[0]?.progressRatio).toBe(0.75);
    expect(mixed.days[0]?.goalCount).toBe(2);
  });

  it("keeps streaks continuous across rest days and ignores unavailable rest data", () => {
    const schedule = createDefaultSchedule(60);
    schedule.saturday.enabled = false;
    schedule.sunday.enabled = false;
    const scheduledGoal = { ...devopsGoal, schedule };
    const analytics = calculateRangeAnalytics([scheduledGoal], [
      day("2026-08-14", 3_600, 0),
      { dateKey: "2026-08-15", future: false, progress: undefined },
      day("2026-08-16", 1_200, 0),
      day("2026-08-17", 3_600, 0)
    ]).goals[0];
    expect(analytics).toMatchObject({
      completedDays: 2,
      availableDays: 2,
      currentStreak: 2,
      bestStreak: 2,
      streakMayBeIncomplete: false
    });
  });

  it("lets today rest preserve yesterday's streak but lets a scheduled failure break it", () => {
    const sundayRest = createDefaultSchedule(60);
    sundayRest.sunday.enabled = false;
    const restingToday = calculateRangeAnalytics([{ ...devopsGoal, schedule: sundayRest }], [
      day("2026-08-15", 3_600, 0),
      day("2026-08-16", 3_600, 0),
      day("2026-08-17", 3_600, 0),
      day("2026-08-18", 3_600, 0),
      day("2026-08-19", 3_600, 0),
      day("2026-08-20", 3_600, 0),
      day("2026-08-21", 3_600, 0),
      day("2026-08-22", 3_600, 0),
      day("2026-08-23", 0, 0)
    ]).goals[0];
    expect(restingToday?.currentStreak).toBe(7);

    const wednesdayRest = createDefaultSchedule(60);
    wednesdayRest.wednesday.enabled = false;
    const broken = calculateRangeAnalytics([{ ...devopsGoal, schedule: wednesdayRest }], [
      day("2026-08-18", 3_600, 0),
      day("2026-08-19", 0, 0),
      day("2026-08-20", 0, 0),
      day("2026-08-21", 3_600, 0)
    ]).goals[0];
    expect(broken).toMatchObject({ currentStreak: 1, bestStreak: 1 });
  });

  it("uses explicit target and skip overrides in historical completion", () => {
    const overridden = {
      ...devopsGoal,
      overrides: {
        "2026-08-17": { kind: "target" as const, targetMinutes: 90 },
        "2026-08-18": { kind: "skip" as const }
      }
    };
    const analytics = calculateRangeAnalytics([overridden], [
      day("2026-08-17", 89 * 60, 0),
      day("2026-08-18", 0, 0)
    ]);
    expect(analytics).toMatchObject({ completedGoals: 0, goalOpportunities: 1 });
    expect(analytics.goals[0]).toMatchObject({ completedDays: 0, availableDays: 1 });
  });

  it("lets a skip override bridge completed scheduled days in a streak", () => {
    const skipped = {
      ...devopsGoal,
      overrides: { "2026-08-18": { kind: "skip" as const } }
    };
    const stats = calculateRangeAnalytics([skipped], [
      day("2026-08-17", 3_600, 0),
      day("2026-08-18", 0, 0),
      day("2026-08-19", 3_600, 0)
    ]).goals[0];
    expect(stats).toMatchObject({ currentStreak: 2, bestStreak: 2, availableDays: 2 });
  });
});
