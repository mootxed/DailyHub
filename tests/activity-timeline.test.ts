import { describe, expect, it } from "vitest";
import {
  buildActivityTimeline,
  GOAL_COLOR_COUNT,
  getGoalColor,
  getGoalColorIndex,
  getTimelineSegmentPosition
} from "../src/activity-timeline";
import { getLocalDateRange } from "../src/date";
import type { ActivityEvent, DailyGoal, DayActivity, GoalRule } from "../src/models";

const DATE = "2026-08-18";

function timestamp(offsetSeconds: number): string {
  return new Date(getLocalDateRange(DATE).start.getTime() + offsetSeconds * 1000).toISOString();
}

function event(
  offsetSeconds: number,
  duration: number,
  data: Record<string, unknown>,
  sourceBucketId?: string
): ActivityEvent {
  return { timestamp: timestamp(offsetSeconds), duration, data, sourceBucketId };
}

function goal(id: string, rule: GoalRule): DailyGoal {
  return {
    id,
    name: id,
    targetMinutes: 30,
    rules: [rule],
    contextTimeoutMinutes: 10,
    enabled: true
  };
}

function appRule(value: string): GoalRule {
  return {
    id: `app-${value}`,
    role: "primary",
    field: "application",
    operator: "equals",
    value,
    countDuringAfk: false
  };
}

function urlRule(value: string): GoalRule {
  return {
    id: `url-${value}`,
    role: "primary",
    field: "url",
    operator: "contains",
    value,
    countDuringAfk: false
  };
}

function activity(overrides: Partial<DayActivity> = {}): DayActivity {
  return { windowEvents: [], browserEvents: [], afkEvents: [], ...overrides };
}

describe("activity timeline", () => {
  it("uses resolver segments with their real positions instead of daily totals", () => {
    const timeline = buildActivityTimeline([goal("devops", appRule("kitty"))], [{
      dateKey: DATE,
      activity: activity({ windowEvents: [event(3_600, 1_800, { app: "kitty" })] })
    }]);
    const segment = timeline[0]?.segments[0];

    expect(segment).toMatchObject({ goalId: "devops" });
    expect(segment === undefined ? undefined : segment.endMs - segment.startMs).toBe(1_800_000);
    expect(segment === undefined ? undefined : getTimelineSegmentPosition(segment, DATE)).toEqual({
      leftPercent: (1 / 24) * 100,
      widthPercent: (0.5 / 24) * 100
    });
  });

  it("cuts a paused interval out of the timeline", () => {
    const paused = {
      ...goal("devops", appRule("kitty")),
      trackingPauses: [{ startedAt: timestamp(120), endedAt: timestamp(240) }]
    };
    const segments = buildActivityTimeline([paused], [{
      dateKey: DATE,
      activity: activity({ windowEvents: [event(0, 600, { app: "kitty" })] })
    }])[0]?.segments;

    expect(segments?.map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [Date.parse(timestamp(0)), Date.parse(timestamp(120))],
      [Date.parse(timestamp(240)), Date.parse(timestamp(600))]
    ]);
  });

  it("uses the deterministic overlap winner without double segments", () => {
    const segments = buildActivityTimeline([
      goal("z-goal", appRule("kitty")),
      goal("a-goal", appRule("kitty"))
    ], [{
      dateKey: DATE,
      activity: activity({ windowEvents: [event(0, 600, { app: "kitty" })] })
    }])[0]?.segments;

    expect(segments).toHaveLength(1);
    expect(segments?.[0]?.goalId).toBe("a-goal");
  });

  it("includes URL tracking while another application is foreground", () => {
    const segments = buildActivityTimeline([goal("typing", urlRule("keybr.com"))], [{
      dateKey: DATE,
      activity: activity({
        windowEvents: [event(0, 600, { app: "Obsidian" })],
        browserEvents: [event(
          0,
          600,
          { url: "https://keybr.com", title: "Practice" },
          "aw-watcher-web-firefox_host"
        )]
      })
    }])[0]?.segments;

    expect(segments).toHaveLength(1);
    expect(segments?.[0]?.goalId).toBe("typing");
  });

  it("cuts AFK time from timeline segments", () => {
    const segments = buildActivityTimeline([goal("devops", appRule("kitty"))], [{
      dateKey: DATE,
      activity: activity({
        windowEvents: [event(0, 600, { app: "kitty" })],
        afkEvents: [event(120, 120, { status: "afk" })]
      })
    }])[0]?.segments;

    expect(segments?.map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [Date.parse(timestamp(0)), Date.parse(timestamp(120))],
      [Date.parse(timestamp(240)), Date.parse(timestamp(600))]
    ]);
  });

  it("keeps separated activity intervals as separate rendered segments", () => {
    const segments = buildActivityTimeline([goal("devops", appRule("kitty"))], [{
      dateKey: DATE,
      activity: activity({
        windowEvents: [
          event(0, 60, { app: "kitty" }),
          event(120, 60, { app: "kitty" })
        ]
      })
    }])[0]?.segments;

    expect(segments).toHaveLength(2);
  });

  it("distinguishes empty available days from unavailable days", () => {
    const timeline = buildActivityTimeline([], [
      { dateKey: DATE, activity: activity() },
      { dateKey: "2026-08-19" }
    ]);

    expect(timeline[0]).toMatchObject({ available: true, segments: [] });
    expect(timeline[1]).toMatchObject({ available: false, segments: [] });
  });

  it("maps each goal id to a stable palette color", () => {
    expect(getGoalColorIndex("devops")).toBe(getGoalColorIndex("devops"));
    expect(getGoalColor("devops")).toBe(getGoalColor("devops"));
    expect(new Set(["devops", "wiki", "typing"].map(getGoalColor)).size).toBe(3);
    expect(getGoalColorIndex("devops")).toBeGreaterThanOrEqual(0);
    expect(getGoalColorIndex("devops")).toBeLessThan(GOAL_COLOR_COUNT);
  });
});
