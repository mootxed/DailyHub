import { describe, expect, it } from "vitest";
import { getLocalDateRange } from "../src/date";
import type { ActivityEvent, DailyGoal, DayActivity, GoalRule } from "../src/models";
import { calculateDailyProgress, getGoalProgress } from "../src/progress";

const DATE = "2026-08-16";

function timestamp(offsetSeconds: number, date = DATE): string {
  return new Date(getLocalDateRange(date).start.getTime() + offsetSeconds * 1000).toISOString();
}

function event(
  offsetSeconds: number,
  duration: number,
  data: Record<string, unknown>,
  date = DATE,
  sourceBucketId?: string
): ActivityEvent {
  return { timestamp: timestamp(offsetSeconds, date), duration, data, sourceBucketId };
}

function goal(id: string, targetMinutes: number, rule: GoalRule): DailyGoal {
  return { id, name: id, targetMinutes, rules: [rule], enabled: true };
}

function appRule(value: string): GoalRule {
  return { id: `app-${value}`, field: "application", operator: "equals", value };
}

function activity(overrides: Partial<DayActivity> = {}): DayActivity {
  return { windowEvents: [], browserEvents: [], afkEvents: [], ...overrides };
}

describe("daily progress", () => {
  it("sums matching activity duration", () => {
    const goals = [goal("typing", 30, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 600, { app: "kitty", title: "Practice" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(600);
    expect(result[0]?.actualMinutes).toBe(10);
  });

  it("excludes AFK intervals at or above the threshold", () => {
    const goals = [goal("typing", 30, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 600, { app: "kitty" })],
      afkEvents: [event(120, 120, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(480);
  });

  it("excludes even a short interval already reported as AFK", () => {
    const goals = [goal("typing", 30, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 120, { app: "kitty" })],
      afkEvents: [event(30, 30, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(90);
  });

  it("does not exclude a not-afk interval", () => {
    const goals = [goal("typing", 30, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 120, { app: "kitty" })],
      afkEvents: [event(30, 30, { status: " NOT-AFK " })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(120);
  });

  it("counts normally when there is no AFK event", () => {
    const goals = [goal("typing", 30, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 90, { app: "kitty" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(90);
  });

  it("marks a goal complete at its daily target", () => {
    const goals = [goal("typing", 10, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 600, { app: "kitty" })]
    }), DATE);
    expect(result[0]).toMatchObject({ completed: true, progressRatio: 1 });
  });

  it("continues counting above target while capping the progress bar", () => {
    const goals = [goal("typing", 10, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 900, { app: "kitty" })]
    }), DATE);
    expect(result[0]).toMatchObject({ actualMinutes: 15, completed: true, progressRatio: 1 });
  });

  it("calculates statistics for a requested date only", () => {
    const goals = [goal("typing", 10, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [
        event(0, 300, { app: "kitty" }, "2026-08-15"),
        event(0, 600, { app: "kitty" }, DATE)
      ]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(600);
    expect(getGoalProgress("typing", goals, activity({
      windowEvents: [event(0, 300, { app: "kitty" }, "2026-08-15")]
    }), "2026-08-15")?.activeSeconds).toBe(300);
  });

  it("never double-counts when two goals match the same segment", () => {
    const goals = [goal("z-goal", 10, appRule("kitty")), goal("a-goal", 10, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 600, { app: "kitty" })]
    }), DATE);
    expect(result.find((item) => item.goalId === "a-goal")?.activeSeconds).toBe(600);
    expect(result.find((item) => item.goalId === "z-goal")?.activeSeconds).toBe(0);
    expect(result.reduce((sum, item) => sum + item.activeSeconds, 0)).toBe(600);
  });

  it("uses browser URL data alongside the active window", () => {
    const urlGoal = goal("url-goal", 10, { id: "url", field: "url", operator: "contains", value: "keybr.com" });
    const result = calculateDailyProgress([urlGoal], activity({
      windowEvents: [event(0, 300, { app: "firefox", title: "Keybr" })],
      browserEvents: [event(0, 300, { url: "https://keybr.com", title: "Keybr" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(300);
  });

  it("does not apply a stale browser URL after Terminal becomes active", () => {
    const urlGoal = goal("typing", 30, { id: "url", field: "url", operator: "contains", value: "keybr.com" });
    const result = calculateDailyProgress([urlGoal], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Keybr — Mozilla Firefox" }),
        event(300, 300, { app: "kitty", title: "Keybr" })
      ],
      browserEvents: [event(
        0,
        600,
        { url: "https://keybr.com", title: "Keybr" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(300);
  });

  it("selects the browser bucket that matches the active browser", () => {
    const urlGoal = goal("typing", 30, { id: "url", field: "url", operator: "contains", value: "keybr.com" });
    const result = calculateDailyProgress([urlGoal], activity({
      windowEvents: [event(0, 600, { app: "Firefox", title: "Keybr — Mozilla Firefox" })],
      browserEvents: [
        event(0, 600, { url: "https://keybr.com", title: "Keybr" }, DATE, "aw-watcher-web-firefox_host"),
        event(100, 500, { url: "https://example.com", title: "Example" }, DATE, "aw-watcher-web-chrome_host")
      ]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(600);
  });

  it("does not trust a browser URL without an active window event", () => {
    const urlGoal = goal("typing", 30, { id: "url", field: "url", operator: "contains", value: "keybr.com" });
    const result = calculateDailyProgress([urlGoal], activity({
      browserEvents: [event(0, 300, { url: "https://keybr.com", title: "Keybr" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("cuts overlapping window, browser, and AFK events at every boundary", () => {
    const urlGoal = goal("typing", 30, { id: "url", field: "url", operator: "contains", value: "keybr.com" });
    const result = calculateDailyProgress([urlGoal], activity({
      windowEvents: [event(0, 600, { app: "Firefox", title: "Keybr — Mozilla Firefox" })],
      browserEvents: [event(0, 600, { url: "https://keybr.com", title: "Keybr" })],
      afkEvents: [event(200, 50, { status: "AfK" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(550);
  });

  it("clips events crossing both edges of the selected day", () => {
    const goals = [goal("typing", 10, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [
        event(-60, 120, { app: "kitty" }),
        event(86_370, 60, { app: "kitty" })
      ]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(90);
  });

  it("sorts input and ignores zero, negative, and malformed events", () => {
    const goals = [goal("typing", 10, appRule("kitty"))];
    const malformed: ActivityEvent = { timestamp: "not-a-date", duration: 300, data: { app: "kitty" } };
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [
        event(120, 60, { app: "kitty" }),
        event(0, 0, { app: "kitty" }),
        malformed,
        event(60, -20, { app: "kitty" })
      ]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(60);
  });

  it("does not double-count overlapping duplicate bucket events", () => {
    const goals = [goal("typing", 10, appRule("kitty"))];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [
        event(0, 600, { app: "kitty" }, DATE, "aw-watcher-window_host"),
        event(0, 600, { app: "kitty" }, DATE, "aw-watcher-window-old_host")
      ]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(600);
  });
});
