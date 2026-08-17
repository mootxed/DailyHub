import { describe, expect, it } from "vitest";
import { summarizeWeek } from "../src/dashboard";
import { getLocalDateRange } from "../src/date";
import type { ActivityEvent, DailyGoal, DayActivity, GoalRule } from "../src/models";
import {
  calculateGoalWeekStats,
  calculateWeekProgress,
  type WeekDayActivity
} from "../src/weekly-progress";

const SELECTED_DATE = "2026-08-10";

function event(offsetSeconds: number, duration: number, application: string): ActivityEvent {
  return {
    timestamp: new Date(getLocalDateRange(SELECTED_DATE).start.getTime() + offsetSeconds * 1_000).toISOString(),
    duration,
    data: { app: application }
  };
}

function rule(value: string, role: GoalRule["role"] = "primary"): GoalRule {
  const base = {
    id: `${role}-${value}`,
    field: "application" as const,
    operator: "equals" as const,
    value
  };
  return role === "primary"
    ? { ...base, role, countDuringAfk: false }
    : { ...base, role };
}

function goal(id: string, rules: GoalRule[], targetMinutes = 30): DailyGoal {
  return {
    id,
    name: id,
    targetMinutes,
    rules,
    contextTimeoutMinutes: 10,
    enabled: true
  };
}

function activity(windowEvents: ActivityEvent[]): DayActivity {
  return { windowEvents, browserEvents: [], afkEvents: [] };
}

function day(dayActivity: DayActivity, dateKey = SELECTED_DATE): WeekDayActivity {
  return { dateKey, future: false, activity: dayActivity };
}

describe("Goal Details weekly attribution", () => {
  it("keeps an overlapping Primary segment assigned to only the global winner", () => {
    const goals = [
      goal("b-goal", [rule("Browser")]),
      goal("a-goal", [rule("Browser")])
    ];
    const days = [day(activity([event(0, 600, "Browser")]))];

    expect(calculateGoalWeekStats(goals, "a-goal", days, SELECTED_DATE)?.totalSeconds).toBe(600);
    expect(calculateGoalWeekStats(goals, "b-goal", days, SELECTED_DATE)?.totalSeconds).toBe(0);
  });

  it("lets another goal's Primary match interrupt the selected goal's context", () => {
    const goals = [
      goal("devops", [rule("Stepik"), rule("Konsole", "continuation")]),
      goal("japanese", [rule("KotoKitsu")])
    ];
    const days = [day(activity([
      event(0, 300, "Stepik"),
      event(300, 300, "Konsole"),
      event(600, 300, "KotoKitsu"),
      event(900, 300, "Konsole")
    ]))];

    expect(calculateGoalWeekStats(goals, "devops", days, SELECTED_DATE)?.totalSeconds).toBe(600);
    expect(calculateGoalWeekStats(goals, "japanese", days, SELECTED_DATE)?.totalSeconds).toBe(300);
  });

  it("matches the selected goal total from the same global daily calculations", () => {
    const goals = [
      goal("devops", [rule("Stepik"), rule("Konsole", "continuation")]),
      goal("japanese", [rule("KotoKitsu")])
    ];
    const days = [
      day(activity([event(0, 300, "Stepik"), event(300, 300, "Konsole")])),
      { dateKey: "2026-08-11", future: false, activity: undefined },
      { dateKey: "2026-08-12", future: true, activity: undefined }
    ];
    const globalDays = calculateWeekProgress(goals, days);
    const dashboardWeek = summarizeWeek(goals, globalDays, SELECTED_DATE);
    const expectedTotal = globalDays.reduce((total, currentDay) => (
      total + (currentDay.progress?.find((item) => item.goalId === "devops")?.activeSeconds ?? 0)
    ), 0);
    const details = calculateGoalWeekStats(goals, "devops", days, SELECTED_DATE);

    expect(details?.totalSeconds).toBe(expectedTotal);
    expect(details).toEqual(dashboardWeek.goals.find((item) => item.goalId === "devops"));
    expect(details?.selectedDay?.dateKey).toBe(SELECTED_DATE);
    expect(details?.selectedDay?.activeSeconds).toBe(600);
  });

  it("uses refreshed goal configuration and presentation fields", () => {
    const currentGoal = goal("study", [rule("OldApp")], 30);
    const days = [day(activity([
      event(0, 300, "OldApp"),
      event(300, 300, "NewApp")
    ]))];
    const initial = calculateGoalWeekStats(
      [currentGoal],
      currentGoal.id,
      days,
      SELECTED_DATE
    );

    currentGoal.name = "Updated study";
    currentGoal.targetMinutes = 5;
    currentGoal.rules = [rule("NewApp")];

    const refreshed = calculateGoalWeekStats(
      [currentGoal],
      currentGoal.id,
      days,
      SELECTED_DATE
    );

    expect(initial).toMatchObject({
      goalName: "study",
      targetMinutes: 30,
      totalSeconds: 300,
      selectedDay: { completed: false }
    });
    expect(refreshed).toMatchObject({
      goalName: "Updated study",
      targetMinutes: 5,
      totalSeconds: 300,
      selectedDay: { completed: true }
    });
  });
});
