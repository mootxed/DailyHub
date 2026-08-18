import { describe, expect, it } from "vitest";
import { getLocalDateRange } from "../src/date";
import type { ActivityWatchStatus, DailyGoal, DayActivity } from "../src/models";
import {
  resolveLiveTrackingState,
  resolveTrackingAt,
  resolveTrackingAtDetailed
} from "../src/progress";

const STATUS: ActivityWatchStatus = {
  kind: "connected",
  windowWatcherAvailable: true,
  browserWatcherAvailable: true,
  afkWatcherAvailable: true,
  message: "connected"
};

function goal(id = "study", app = "kitty"): DailyGoal {
  return {
    id,
    name: id,
    targetMinutes: 30,
    rules: [{
      id: `${id}-rule`, role: "primary", field: "application", operator: "equals",
      value: app, countDuringAfk: false
    }],
    contextTimeoutMinutes: 10,
    enabled: true
  };
}

function event(startMs: number, durationMinutes: number, app: string): DayActivity["windowEvents"][number] {
  return { timestamp: new Date(startMs).toISOString(), duration: durationMinutes * 60, data: { app } };
}

describe("current tracking session", () => {
  const dayStart = getLocalDateRange("2026-08-18").start.getTime();

  it("starts at the latest uninterrupted segment instead of using today's total", () => {
    const now = dayStart + 10 * 60 * 60_000 + 40 * 60_000;
    const activity: DayActivity = {
      windowEvents: [
        event(dayStart + 10 * 60 * 60_000, 20, "kitty"),
        event(dayStart + 10 * 60 * 60_000 + 20 * 60_000, 10, "other"),
        event(dayStart + 10 * 60 * 60_000 + 30 * 60_000, 10, "kitty")
      ],
      browserEvents: [], afkEvents: []
    };
    const live = resolveLiveTrackingState([goal()], activity, now, dayStart);
    expect(live.goal?.id).toBe("study");
    expect(live.currentSessionStartMs).toBe(now - 10 * 60_000);
    expect(live.currentSessionSeconds).toBe(10 * 60);
  });

  it("restarts a session after pause and AFK boundaries", () => {
    const start = dayStart + 10 * 60 * 60_000;
    const now = start + 40 * 60_000;
    const paused = goal();
    paused.trackingPauses = [{
      startedAt: new Date(start + 35 * 60_000).toISOString(),
      endedAt: new Date(start + 37 * 60_000).toISOString()
    }];
    const activity: DayActivity = {
      windowEvents: [event(start, 40, "kitty")], browserEvents: [], afkEvents: []
    };
    expect(resolveLiveTrackingState([paused], activity, now, dayStart).currentSessionSeconds).toBe(3 * 60);

    const withAfk: DayActivity = {
      ...activity,
      afkEvents: [{
        timestamp: new Date(start + 35 * 60_000).toISOString(), duration: 2 * 60,
        data: { status: "afk" }
      }]
    };
    expect(resolveLiveTrackingState([goal()], withAfk, now, dayStart).currentSessionSeconds).toBe(3 * 60);
  });
});

describe("tracking diagnostics", () => {
  const start = getLocalDateRange("2026-08-18").start.getTime() + 10 * 60 * 60_000;
  const now = start + 10 * 60_000;

  function diagnose(goals: DailyGoal[], activity: DayActivity, status = STATUS) {
    return resolveTrackingAtDetailed(goals, activity, now, start, status);
  }

  it("reports the same winner as normal live resolution", () => {
    const goals = [goal("b"), goal("a")];
    const activity = { windowEvents: [event(start, 10, "kitty")], browserEvents: [], afkEvents: [] };
    expect(diagnose(goals, activity).winnerGoalId).toBe(resolveTrackingAt(goals, activity, now, start)?.id);
    expect(diagnose(goals, activity).winnerGoalId).toBe("a");
    expect(diagnose(goals, activity).candidates.find((item) => item.goalId === "b")?.reason).toBe("overlap-lost");
  });

  it("explains paused, not-started, primary mismatch, unavailable watcher, and AFK", () => {
    const paused = goal("paused");
    paused.trackingPauses = [{ startedAt: new Date(start).toISOString() }];
    const future = { ...goal("future"), trackingStartedAt: new Date(now + 60_000).toISOString() };
    const mismatch = goal("mismatch", "code");
    const urlGoal: DailyGoal = {
      ...goal("url"),
      rules: [{
        id: "url-rule", role: "primary", field: "url", operator: "contains",
        value: "example.com", countDuringAfk: false
      }]
    };
    const activity = {
      windowEvents: [event(start, 10, "kitty")], browserEvents: [],
      afkEvents: [{ timestamp: new Date(start).toISOString(), duration: 10 * 60, data: { status: "afk" } }]
    };
    const result = diagnose([paused, future, mismatch, urlGoal, goal("afk")], activity, {
      ...STATUS, browserWatcherAvailable: false
    });
    const reasons = new Map(result.candidates.map((item) => [item.goalId, item.reason]));
    expect(reasons.get("paused")).toBe("paused");
    expect(reasons.get("future")).toBe("not-tracking-yet");
    expect(reasons.get("mismatch")).toBe("primary-mismatch");
    expect(reasons.get("url")).toBe("watcher-unavailable");
    expect(reasons.get("afk")).toBe("afk-blocked");
  });
});
