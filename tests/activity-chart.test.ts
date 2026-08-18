import { describe, expect, it } from "vitest";
import {
  buildActivityChartSeries,
  filterActivityChartSeries,
  getActivityChartSegments,
  getGoalColor,
  getGoalColorIndex,
  getMaximumChartSeconds,
  getNiceTimeScale,
  GOAL_COLOR_COUNT
} from "../src/activity-chart";
import { getLocalDateRange } from "../src/date";
import type { DailyGoal, GoalProgress } from "../src/models";
import { calculateDailyProgress } from "../src/progress";
import { buildComputerActivityChartSeries } from "../src/view/activity-chart-view";
import type { DailyComputerActivity } from "../src/activity-models";
import { getIdentityColor } from "../src/identity-color";

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
  it("builds top foreground app and category series without mixing mode ids", () => {
    const computer = (
      dateKey: string,
      applications: DailyComputerActivity["applications"],
      categories: DailyComputerActivity["categories"]
    ): DailyComputerActivity => ({
      dateKey,
      available: true,
      activeComputerSeconds: applications.reduce((sum, item) => sum + item.seconds, 0),
      browserForegroundSeconds: 0,
      segments: [],
      applications,
      sites: [],
      categories
    });
    const item = (id: string, seconds: number) => ({ id, label: id, seconds, percentage: 1 });
    const days = [{
      key: "2026-08-17",
      date: new Date(2026, 7, 17),
      future: false,
      progress: undefined,
      computerActivity: computer("2026-08-17", [item("Obsidian", 600)], [item("development", 600)])
    }, {
      key: "2026-08-18",
      date: new Date(2026, 7, 18),
      future: false,
      progress: undefined,
      computerActivity: computer("2026-08-18", [item("Obsidian", 300)], [item("uncategorized", 300)])
    }];
    expect(buildComputerActivityChartSeries(days, "apps", []).map((series) => ({
      id: series.goalId, points: series.points.map((point) => point.seconds)
    }))).toEqual([{ id: "Obsidian", points: [600, 300] }]);
    expect(buildComputerActivityChartSeries(days, "categories", []).map((series) => series.goalId))
      .toEqual(["development", "uncategorized"]);
  });

  it("builds top site series across days from foreground domain totals", () => {
    const item = (id: string, seconds: number) => ({ id, label: id, seconds, percentage: 1 });
    const computer = (
      dateKey: string,
      sites: DailyComputerActivity["sites"]
    ): DailyComputerActivity => ({
      dateKey,
      available: true,
      activeComputerSeconds: sites.reduce((sum, site) => sum + site.seconds, 0),
      browserForegroundSeconds: sites.reduce((sum, site) => sum + site.seconds, 0),
      segments: [],
      applications: [item("Google Chrome", sites.reduce((sum, site) => sum + site.seconds, 0))],
      sites,
      categories: []
    });
    const days = [{
      key: "2026-08-17",
      date: new Date(2026, 7, 17),
      future: false,
      progress: undefined,
      computerActivity: computer("2026-08-17", [item("github.com", 600), item("youtube.com", 300)])
    }, {
      key: "2026-08-18",
      date: new Date(2026, 7, 18),
      future: false,
      progress: undefined,
      computerActivity: computer("2026-08-18", [item("github.com", 120), item("youtube.com", 900)])
    }];

    const series = buildComputerActivityChartSeries(days, "sites", []);

    expect(series.map((entry) => ({
      id: entry.goalId,
      points: entry.points.map((point) => point.seconds)
    }))).toEqual([
      { id: "youtube.com", points: [300, 900] },
      { id: "github.com", points: [600, 120] }
    ]);
    expect(series.map((entry) => entry.goalId)).not.toContain("Google Chrome");
    expect(series[0]?.color).toBe(getIdentityColor("site", "youtube.com"));
  });

  it("limits site activity to the five domains with the largest range totals", () => {
    const sites = [1, 2, 3, 4, 5, 6].map((rank) => ({
      id: `site-${rank}.example`,
      label: `site-${rank}.example`,
      seconds: rank * 60,
      percentage: rank / 21
    }));
    const computer: DailyComputerActivity = {
      dateKey: DATE,
      available: true,
      activeComputerSeconds: 21 * 60,
      browserForegroundSeconds: 21 * 60,
      segments: [],
      applications: [],
      sites,
      categories: []
    };

    const series = buildComputerActivityChartSeries([{
      key: DATE,
      date: new Date(2026, 7, 18),
      future: false,
      progress: undefined,
      computerActivity: computer
    }], "sites", []);

    expect(series.map((entry) => entry.goalId)).toEqual([
      "site-6.example",
      "site-5.example",
      "site-4.example",
      "site-3.example",
      "site-2.example"
    ]);
  });

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
    expect(series[0]?.points.map((point) => point.missingReason)).toEqual(["unavailable", "future"]);
  });

  it("uses a missing point before tracking starts but preserves tracked zero", () => {
    const tracked = goal("devops");
    tracked.trackingStartedAt = new Date(2026, 7, 18, 12).toISOString();
    const series = buildActivityChartSeries([tracked], [
      { dateKey: "2026-08-17", future: false, progress: [progress("devops", 0)] },
      { dateKey: "2026-08-18", future: false, progress: [progress("devops", 0)] }
    ]);

    expect(series[0]?.points).toEqual([
      { dateKey: "2026-08-17", seconds: null, missingReason: "not-tracked" },
      { dateKey: "2026-08-18", seconds: 0 }
    ]);
  });

  it("splits line segments at every missing point", () => {
    const points = [
      { dateKey: "mon", seconds: 1_800 },
      { dateKey: "tue", seconds: null, missingReason: "unavailable" as const },
      { dateKey: "wed", seconds: 3_000 }
    ];
    expect(getActivityChartSegments(points)).toEqual([[points[0]], [points[2]]]);
  });

  it("filters without mutating source series", () => {
    const source = buildActivityChartSeries([goal("devops"), goal("typing")], [{
      dateKey: DATE,
      future: false,
      progress: [progress("devops", 10), progress("typing", 20)]
    }]);
    const snapshot = structuredClone(source);
    expect(filterActivityChartSeries(source, new Set(["typing"])).map((item) => item.goalId))
      .toEqual(["devops"]);
    expect(source).toEqual(snapshot);
  });

  it("reports zero activity when every visible series is zero", () => {
    const source = buildActivityChartSeries([goal("devops"), goal("typing")], [{
      dateKey: DATE,
      future: false,
      progress: [progress("devops", 15), progress("typing", 0)]
    }]);
    const visible = filterActivityChartSeries(source, new Set(["devops"]));

    expect(getMaximumChartSeconds(visible)).toBe(0);
    expect(getMaximumChartSeconds(source)).toBe(15 * 60);
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
    expect(getGoalColor("devops", 4)).toBe("var(--dh-identity-color-5)");
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
