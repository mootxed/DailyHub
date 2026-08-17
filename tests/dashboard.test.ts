import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatRemainingDuration,
  getDayPlan,
  getRemainingGoals,
  getTotalRemainingSeconds,
  summarizeDay,
  summarizeWeek,
  type WeekDayProgress
} from "../src/dashboard";
import { createDefaultSchedule, type DailyGoal, type GoalProgress } from "../src/models";

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
const disabledGoal: DailyGoal = {
    id: "disabled",
    name: "Disabled",
    targetMinutes: 10,
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: false
};
const goals: DailyGoal[] = [devopsGoal, typingGoal, disabledGoal];

function progress(goalId: string, activeSeconds: number, completed: boolean): GoalProgress {
  return {
    goalId,
    activeSeconds,
    actualMinutes: activeSeconds / 60,
    targetMinutes: 30,
    completed,
    progressRatio: completed ? 1 : 0.5
  };
}

describe("dashboard summaries", () => {
  it("sums single-attribution study time and only enabled goal completion", () => {
    expect(summarizeDay(goals, [
      progress("devops", 3_600, true),
      progress("typing", 1_200, false),
      progress("disabled", 600, true)
    ], "2026-08-17")).toEqual({ totalActiveSeconds: 4_800, completedGoals: 1, goalCount: 2 });
  });

  it("returns a zero summary for a future day", () => {
    expect(summarizeDay(goals, [], "2026-08-17")).toEqual({
      totalActiveSeconds: 0,
      completedGoals: 0,
      goalCount: 2
    });
  });

  it("formats durations without fractional minutes", () => {
    expect(formatDuration(-1)).toBe("0 min");
    expect(formatDuration(2_550)).toBe("42 min");
    expect(formatDuration(5_520)).toBe("1 h 32 min");
    expect(formatDuration(7_200)).toBe("2 h");
    expect(formatRemainingDuration(61)).toBe("2 min");
  });

  it("calculates remaining time for enabled, incomplete goals only", () => {
    const current = [
      progress("devops", 2_460, false),
      progress("typing", 1_800, true),
      progress("disabled", 0, false)
    ];
    expect(getRemainingGoals(goals, current, "2026-08-17")).toEqual([{
      goalId: "devops",
      name: "DevOps",
      remainingSeconds: 1_140
    }]);
    expect(getTotalRemainingSeconds(goals, current, "2026-08-17")).toBe(1_140);
  });

  it("treats a missing progress row as zero without including disabled goals", () => {
    expect(getRemainingGoals(goals, [], "2026-08-17")).toEqual([
      { goalId: "devops", name: "DevOps", remainingSeconds: 3_600 },
      { goalId: "typing", name: "Typing", remainingSeconds: 1_800 }
    ]);
    expect(getTotalRemainingSeconds(goals, [], "2026-08-17")).toBe(5_400);
  });

  it("builds a stable plan with completed goals and excludes rest or skipped goals", () => {
    const devopsSchedule = createDefaultSchedule(60);
    const typingSchedule = createDefaultSchedule(30);
    typingSchedule.monday.enabled = false;
    const scheduledGoals: DailyGoal[] = [
      { ...devopsGoal, schedule: devopsSchedule },
      { ...typingGoal, schedule: typingSchedule },
      { ...disabledGoal, schedule: createDefaultSchedule(10) }
    ];
    const plan = getDayPlan(scheduledGoals, [progress("devops", 3_600, true)], "2026-08-17");
    expect(plan.map((item) => item.goalId)).toEqual(["devops"]);
    expect(plan[0]).toMatchObject({ completed: true, remainingSeconds: 0, targetMinutes: 60 });

    const skipped = scheduledGoals.map((goal) => goal.id === "devops"
      ? { ...goal, overrides: { "2026-08-17": { kind: "skip" as const } } }
      : goal);
    expect(getDayPlan(skipped, [], "2026-08-17")).toEqual([]);
    expect(getTotalRemainingSeconds(skipped, [], "2026-08-17")).toBe(0);
  });
});

function weekDay(
  dateKey: string,
  items: GoalProgress[] | undefined,
  future = false
): WeekDayProgress {
  return { dateKey, progress: items, future };
}

describe("weekly analytics", () => {
  it("calculates totals, elapsed-day average, and completed goal opportunities", () => {
    const week = summarizeWeek(goals, [
      weekDay("2026-08-17", [progress("devops", 3_600, true), progress("typing", 600, false)]),
      weekDay("2026-08-18", [progress("devops", 1_800, false), progress("typing", 1_800, true)]),
      weekDay("2026-08-19", [progress("devops", 0, false), progress("typing", 0, false)]),
      weekDay("2026-08-20", undefined, true),
      weekDay("2026-08-21", undefined, true)
    ], "2026-08-18");

    expect(week).toMatchObject({
      totalActiveSeconds: 7_800,
      dailyAverageSeconds: 2_600,
      completedGoals: 2,
      goalOpportunities: 6,
      elapsedDays: 3,
      unavailableDays: 0
    });
  });

  it("keeps zero-activity elapsed days in the average and excludes future days", () => {
    const week = summarizeWeek(goals, [
      weekDay("2026-08-17", [progress("devops", 3_600, true), progress("typing", 0, false)]),
      weekDay("2026-08-18", [progress("devops", 0, false), progress("typing", 0, false)]),
      weekDay("2026-08-19", undefined, true)
    ], "2026-08-17");
    expect(week.dailyAverageSeconds).toBe(1_800);
    expect(week.elapsedDays).toBe(2);
    expect(week.goalOpportunities).toBe(4);
  });

  it("builds and sorts goal breakdowns by weekly active time with zero totals last", () => {
    const week = summarizeWeek(goals, [
      weekDay("2026-08-17", [progress("devops", 600, false), progress("typing", 1_800, true)]),
      weekDay("2026-08-18", [progress("devops", 2_400, false), progress("typing", 0, false)])
    ], "2026-08-18");
    expect(week.goals.map((goal) => [goal.goalId, goal.totalSeconds])).toEqual([
      ["devops", 3_000],
      ["typing", 1_800]
    ]);
    expect(summarizeWeek(goals, [
      weekDay("2026-08-17", [progress("devops", 0, false), progress("typing", 0, false)])
    ], "2026-08-17").goals.map((goal) => goal.goalId)).toEqual(["devops", "typing"]);
  });

  it("builds goal details for a historical selected date", () => {
    const week = summarizeWeek(goals, [
      weekDay("2026-08-10", [progress("devops", 3_600, true), progress("typing", 0, false)]),
      weekDay("2026-08-11", [progress("devops", 1_200, false), progress("typing", 0, false)])
    ], "2026-08-10");
    expect(week.goals[0]).toMatchObject({
      goalId: "devops",
      totalSeconds: 4_800,
      completedDays: 1,
      trackedDays: 2,
      selectedDay: {
        dateKey: "2026-08-10",
        future: false,
        available: true,
        activeSeconds: 3_600,
        completed: true
      }
    });
  });

  it("marks future goal days neutral and does not count them as incomplete", () => {
    const week = summarizeWeek(goals, [
      weekDay("2026-08-17", [progress("devops", 3_600, true), progress("typing", 0, false)]),
      weekDay("2026-08-18", undefined, true)
    ], "2026-08-18");
    const devops = week.goals.find((goal) => goal.goalId === "devops");
    expect(devops).toMatchObject({ completedDays: 1, trackedDays: 1 });
    expect(devops?.selectedDay).toMatchObject({
      dateKey: "2026-08-18",
      future: true,
      available: false,
      activeSeconds: undefined,
      completed: undefined
    });
  });

  it("keeps partial weekly totals but withholds a misleading average", () => {
    const week = summarizeWeek(goals, [
      weekDay("2026-08-17", [progress("devops", 600, false), progress("typing", 0, false)]),
      weekDay("2026-08-18", undefined)
    ], "2026-08-17");
    expect(week).toMatchObject({
      totalActiveSeconds: 600,
      dailyAverageSeconds: undefined,
      elapsedDays: 2,
      unavailableDays: 1,
      completedGoals: 0,
      goalOpportunities: 2
    });
    expect(week.goals[0]?.days[1]).toMatchObject({ available: false, completed: undefined });
  });

  it("counts only scheduled weekly opportunities while keeping calendar-day averages", () => {
    const schedule = createDefaultSchedule(60);
    schedule.wednesday.enabled = false;
    schedule.saturday.enabled = false;
    schedule.sunday.enabled = false;
    const scheduledGoals: DailyGoal[] = [{ ...devopsGoal, schedule }];
    const week = summarizeWeek(scheduledGoals, [
      weekDay("2026-08-17", [progress("devops", 3_600, true)]),
      weekDay("2026-08-18", [progress("devops", 3_600, true)]),
      weekDay("2026-08-19", [progress("devops", 0, false)]),
      weekDay("2026-08-20", [progress("devops", 0, false)]),
      weekDay("2026-08-21", [progress("devops", 3_600, true)]),
      weekDay("2026-08-22", [progress("devops", 0, false)]),
      weekDay("2026-08-23", [progress("devops", 0, false)])
    ], "2026-08-20");

    expect(week).toMatchObject({
      totalActiveSeconds: 10_800,
      dailyAverageSeconds: 10_800 / 7,
      completedGoals: 3,
      goalOpportunities: 4
    });
    expect(week.goals[0]).toMatchObject({ completedDays: 3, trackedDays: 4 });
    expect(week.goals[0]?.days[2]).toMatchObject({ scheduled: false, skipped: false });
  });
});
