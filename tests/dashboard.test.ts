import { describe, expect, it } from "vitest";
import { formatDuration, summarizeDay } from "../src/dashboard";
import type { DailyGoal, GoalProgress } from "../src/models";

const goals: DailyGoal[] = [
  {
    id: "devops",
    name: "DevOps",
    targetMinutes: 60,
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: true
  },
  {
    id: "typing",
    name: "Typing",
    targetMinutes: 30,
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: true
  },
  {
    id: "disabled",
    name: "Disabled",
    targetMinutes: 10,
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: false
  }
];

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
    ])).toEqual({ totalActiveSeconds: 4_800, completedGoals: 1, goalCount: 2 });
  });

  it("returns a zero summary for a future day", () => {
    expect(summarizeDay(goals, [])).toEqual({ totalActiveSeconds: 0, completedGoals: 0, goalCount: 2 });
  });

  it("formats durations without fractional minutes", () => {
    expect(formatDuration(2_550)).toBe("42 min");
    expect(formatDuration(5_520)).toBe("1 h 32 min");
    expect(formatDuration(7_200)).toBe("2 h");
  });
});
