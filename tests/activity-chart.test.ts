import { describe, expect, it } from "vitest";
import {
  buildActivityChartSeries,
  getGoalColor,
  getGoalColorIndex,
  getNiceTimeScale,
  GOAL_COLOR_COUNT
} from "../src/activity-chart";
import { getLocalDateRange } from "../src/date";
import type { DailyGoal, GoalProgress } from "../src/models";
import { calculateDailyProgress } from "../src/progress";

const DATE = "2026-08-18";

function goal(id: string): DailyGoal {
  return {
    id,
    name: id,
    targetMinutes: 30,
    rules: [],
    contextTimeoutMinutes: 10,
    enabled: true
  };
}

function progress(goalId: string, minutes: number): GoalProgress {
  return {
    goalId,
    activeSeconds: minutes * 60,
    actualMinutes: minutes,
    targetMinutes: 30,
    completed: minutes >= 30,
    progressRatio: minutes / 30
  };
}

describe("activity line chart", () => {
  it("builds an independent daily series for each goal", () => {
    const series = buildActivityChartSeries([goal("devops"), goal("japanese")], [
      {
        dateKey: "2026-08-17",
        future: false,
        progress: [progress("devops", 60), progress("japanese", 30)]
      },
      {
        dateKey: "2026-08-18",
        future: false,
        progress: [progress("devops", 120), progress("japanese", 0)]
      }
    ]);

    expect(series.find((item) => item.goalId === "devops")?.points.map((point) => point.seconds))
      .toEqual([3_600, 7_200]);
    expect(series.find((item) => item.goalId === "japanese")?.points.map((point) => point.seconds))
      .toEqual([1_800, 0]);
  });

  it("uses missing points for unavailable and future days", () => {
    const series = buildActivityChartSeries([goal("devops")], [
      { dateKey: "2026-08-17", future: false, progress: undefined },
      { dateKey: "2026-08-18", future: true, progress: [progress("devops", 60)] }
    ]);

    expect(series[0]?.points.map((point) => point.seconds)).toEqual([null, null]);
  });

  it("uses pause-aware progress totals instead of raw event duration", () => {
    const start = getLocalDateRange(DATE).start.getTime();
    const pausedGoal: DailyGoal = {
      ...goal("devops"),
      rules: [{
        id: "kitty",
        role: "primary",
        field: "application",
        operator: "equals",
        value: "kitty",
        countDuringAfk: false
      }],
      trackingPauses: [{
        startedAt: new Date(start + 10 * 60_000).toISOString(),
        endedAt: new Date(start + 20 * 60_000).toISOString()
      }]
    };
    const dailyProgress = calculateDailyProgress([pausedGoal], {
      windowEvents: [{
        timestamp: new Date(start).toISOString(),
        duration: 30 * 60,
        data: { app: "kitty" }
      }],
      browserEvents: [],
      afkEvents: []
    }, DATE);
    const series = buildActivityChartSeries([pausedGoal], [{
      dateKey: DATE,
      future: false,
      progress: dailyProgress
    }]);

    expect(series[0]?.points[0]?.seconds).toBe(20 * 60);
  });

  it("maps each goal id to a stable palette color", () => {
    expect(getGoalColorIndex("devops")).toBe(getGoalColorIndex("devops"));
    expect(getGoalColor("devops")).toBe(getGoalColor("devops"));
    expect(new Set(["devops", "wiki", "typing"].map(getGoalColor)).size).toBe(3);
    expect(getGoalColorIndex("devops")).toBeGreaterThanOrEqual(0);
    expect(getGoalColorIndex("devops")).toBeLessThan(GOAL_COLOR_COUNT);
  });

  it.each([
    [20, 5, 20],
    [120, 30, 120],
    [480, 120, 480]
  ])("creates nice ticks for a %i minute maximum", (maximumMinutes, stepMinutes, axisMinutes) => {
    const scale = getNiceTimeScale(maximumMinutes * 60);
    expect(scale.stepSeconds).toBe(stepMinutes * 60);
    expect(scale.maximumSeconds).toBe(axisMinutes * 60);
    expect(scale.ticks.at(-1)).toBe(axisMinutes * 60);
  });
});
