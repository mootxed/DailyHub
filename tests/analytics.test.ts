import { describe, expect, it } from "vitest";
import { calculateRangeAnalytics, getHeatmapLevel } from "../src/analytics";
import { addLocalDays, getLocalDateRange, toLocalDateKey } from "../src/date";
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
  it("calculates totals, tracked-day average, active days, opportunities, and stable goal order", () => {
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
      trackedDays: 3,
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
      trackedGoalCount: 2,
      goalCount: 2,
      progressRatio: undefined
    });
  });

  it("averages a new goal Today across only its one tracked day", () => {
    const trackedGoal = {
      ...devopsGoal,
      trackingStartedAt: new Date(2026, 7, 17, 12).toISOString()
    };
    const progressDays = Array.from({ length: 30 }, (_, index) => {
      const dateKey = toLocalDateKey(addLocalDays("2026-07-19", index));
      return day(dateKey, index === 29 ? 1_800 : 0, 0);
    });
    const analytics = calculateRangeAnalytics([trackedGoal], progressDays);

    expect(analytics).toMatchObject({
      totalSeconds: 1_800,
      averageSeconds: 1_800,
      activeDays: 1,
      availableDays: 30,
      trackedDays: 1
    });
  });

  it("keeps a zero-activity tracked day in the average denominator", () => {
    const trackedGoal = {
      ...devopsGoal,
      trackingStartedAt: new Date(2026, 7, 16, 12).toISOString()
    };
    const progressDays = Array.from({ length: 30 }, (_, index) => {
      const dateKey = toLocalDateKey(addLocalDays("2026-07-19", index));
      return day(dateKey, index === 28 ? 3_600 : 0, 0);
    });
    const analytics = calculateRangeAnalytics([trackedGoal], progressDays);

    expect(analytics).toMatchObject({
      totalSeconds: 3_600,
      averageSeconds: 1_800,
      activeDays: 1,
      availableDays: 30,
      trackedDays: 2
    });
  });

  it("excludes unavailable tracked days and available pre-tracking days from the average", () => {
    const trackedGoal = {
      ...devopsGoal,
      trackingStartedAt: new Date(2026, 7, 15, 12).toISOString()
    };
    const analytics = calculateRangeAnalytics([trackedGoal], [
      day("2026-08-14", 0, 0),
      day("2026-08-15", 1_800, 0),
      { dateKey: "2026-08-16", future: false, progress: undefined }
    ]);

    expect(analytics).toMatchObject({
      totalSeconds: 1_800,
      averageSeconds: 1_800,
      activeDays: 1,
      availableDays: 2,
      trackedDays: 1
    });
    expect(analytics.days[2]).toMatchObject({ available: false, trackedGoalCount: 1 });
  });

  it("returns an undefined average when available days all predate tracking", () => {
    const trackedGoal = {
      ...devopsGoal,
      trackingStartedAt: new Date(2026, 7, 18, 12).toISOString()
    };
    const progressDays = Array.from({ length: 30 }, (_, index) => (
      day(toLocalDateKey(addLocalDays("2026-07-19", index)), 0, 0)
    ));
    const analytics = calculateRangeAnalytics([trackedGoal], progressDays);

    expect(analytics).toMatchObject({
      totalSeconds: 0,
      averageSeconds: undefined,
      activeDays: 0,
      availableDays: 30,
      trackedDays: 0
    });
  });

  it("returns a zero average when tracked days have zero activity", () => {
    const trackedGoal = {
      ...devopsGoal,
      trackingStartedAt: new Date(2026, 7, 13, 12).toISOString()
    };
    const progressDays = Array.from({ length: 5 }, (_, index) => (
      day(toLocalDateKey(addLocalDays("2026-08-13", index)), 0, 0)
    ));
    const analytics = calculateRangeAnalytics([trackedGoal], progressDays);

    expect(analytics).toMatchObject({
      totalSeconds: 0,
      averageSeconds: 0,
      activeDays: 0,
      availableDays: 5,
      trackedDays: 5
    });
  });

  it("preserves the historical average denominator for a legacy goal", () => {
    const progressDays = Array.from({ length: 30 }, (_, index) => {
      const dateKey = toLocalDateKey(addLocalDays("2026-07-19", index));
      return day(dateKey, index === 29 ? 1_800 : 0, 0);
    });
    const analytics = calculateRangeAnalytics([devopsGoal], progressDays);

    expect(analytics).toMatchObject({
      totalSeconds: 1_800,
      averageSeconds: 60,
      availableDays: 30,
      trackedDays: 30
    });
  });

  it("counts a day when any goal is tracked in a mixed legacy and new-goal range", () => {
    const newGoal = {
      ...typingGoal,
      trackingStartedAt: new Date(2026, 7, 17, 12).toISOString()
    };
    const analytics = calculateRangeAnalytics([devopsGoal, newGoal], [
      day("2026-08-16", 1_800, 0),
      day("2026-08-17", 0, 1_800)
    ]);

    expect(analytics).toMatchObject({
      totalSeconds: 3_600,
      averageSeconds: 1_800,
      availableDays: 2,
      trackedDays: 2
    });
    expect(analytics.days.map((trackedDay) => trackedDay.trackedGoalCount)).toEqual([1, 2]);
  });

  it("keeps available rest days after tracking began in the calendar-day average", () => {
    const schedule = createDefaultSchedule(60);
    schedule.saturday.enabled = false;
    schedule.sunday.enabled = false;
    const analytics = calculateRangeAnalytics([{ ...devopsGoal, schedule }], [
      day("2026-08-15", 0, 0),
      day("2026-08-16", 0, 0),
      day("2026-08-17", 3_600, 0)
    ]);

    expect(analytics).toMatchObject({
      totalSeconds: 3_600,
      averageSeconds: 1_200,
      activeDays: 1,
      availableDays: 3,
      trackedDays: 3,
      goalOpportunities: 1
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
    expect(noGoals).toMatchObject({
      averageSeconds: undefined,
      availableDays: 1,
      trackedDays: 0,
      goalOpportunities: 0,
      completionRate: undefined
    });
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
      trackedGoalCount: 2,
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

  it("excludes pre-start dates from range opportunities, streaks, and heatmap ratios", () => {
    const trackingStartedAt = new Date(2026, 7, 19, 12).toISOString();
    const trackedGoal = { ...devopsGoal, trackingStartedAt };
    const analytics = calculateRangeAnalytics([trackedGoal], [
      { dateKey: "2026-08-17", future: false, progress: undefined },
      day("2026-08-18", 3_600, 0),
      day("2026-08-19", 3_600, 0)
    ]);

    expect(analytics).toMatchObject({
      totalSeconds: 3_600,
      completedGoals: 1,
      goalOpportunities: 1
    });
    expect(analytics.goals[0]).toMatchObject({
      completedDays: 1,
      availableDays: 1,
      currentStreak: 1,
      bestStreak: 1,
      streakMayBeIncomplete: false
    });
    expect(analytics.days[0]).toMatchObject({ trackedGoalCount: 0, goalCount: 0 });
    expect(analytics.days[1]).toMatchObject({ trackedGoalCount: 0, goalCount: 0, totalSeconds: 0 });
    expect(analytics.days[2]).toMatchObject({ trackedGoalCount: 1, goalCount: 1 });

    const newGoal = { ...typingGoal, trackingStartedAt };
    const mixed = calculateRangeAnalytics([devopsGoal, newGoal], [day("2026-08-18", 1_800, 1_800)]);
    expect(mixed.days[0]).toMatchObject({ trackedGoalCount: 1, goalCount: 1, progressRatio: 0.5 });
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
