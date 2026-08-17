import { describe, expect, it } from "vitest";
import { calculateRangeAnalytics, getHeatmapLevel } from "../src/analytics";
import { getLocalDateRange } from "../src/date";
import type { ActivityEvent, DailyGoal, DayActivity, GoalProgress } from "../src/models";
import { calculateRangeProgress, type DayProgressResult } from "../src/range-progress";

const devopsGoal: DailyGoal = {
  id: "devops",
  name: "DevOps",
  targetMinutes: 60,
  rules: [],
  contextTimeoutMinutes: 10,
  enabled: true
};

const goals: DailyGoal[] = [
  devopsGoal,
  { id: "typing", name: "Typing", targetMinutes: 30, rules: [], contextTimeoutMinutes: 10, enabled: true },
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
      goalCount: undefined,
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
});
