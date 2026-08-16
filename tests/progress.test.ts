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

function goal(
  id: string,
  targetMinutes: number,
  rules: GoalRule | GoalRule[],
  contextTimeoutMinutes = 10
): DailyGoal {
  return {
    id,
    name: id,
    targetMinutes,
    rules: Array.isArray(rules) ? rules : [rules],
    contextTimeoutMinutes,
    enabled: true
  };
}

function appRule(
  value: string,
  role: GoalRule["role"] = "primary",
  countDuringAfk = false
): GoalRule {
  const rule = { id: `${role}-app-${value}`, field: "application" as const, operator: "equals" as const, value };
  return role === "primary"
    ? { ...rule, role, countDuringAfk }
    : { ...rule, role };
}

function urlRule(
  value: string,
  role: GoalRule["role"] = "primary",
  countDuringAfk = false
): GoalRule {
  const rule = { id: `${role}-url-${value}`, field: "url" as const, operator: "contains" as const, value };
  return role === "primary"
    ? { ...rule, role, countDuringAfk }
    : { ...rule, role };
}

function contextGoal(timeoutMinutes = 10, countDuringAfk = false): DailyGoal {
  return goal("devops", 90, [
    urlRule("stepik.org", "primary", countDuringAfk),
    appRule("Terminal", "continuation")
  ], timeoutMinutes);
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
    const urlGoal = goal("url-goal", 10, urlRule("keybr.com"));
    const result = calculateDailyProgress([urlGoal], activity({
      windowEvents: [event(0, 300, { app: "firefox", title: "Keybr" })],
      browserEvents: [event(0, 300, { url: "https://keybr.com", title: "Keybr" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(300);
  });

  it("does not apply a stale browser URL after Terminal becomes active", () => {
    const urlGoal = goal("typing", 30, urlRule("keybr.com"));
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
    const urlGoal = goal("typing", 30, urlRule("keybr.com"));
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
    const urlGoal = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([urlGoal], activity({
      browserEvents: [event(0, 300, { url: "https://keybr.com", title: "Keybr" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("cuts overlapping window, browser, and AFK events at every boundary", () => {
    const urlGoal = goal("typing", 30, urlRule("keybr.com"));
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

  it("counts a primary rule without requiring context", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [event(0, 600, { app: "Firefox", title: "Stepik" })],
      browserEvents: [event(
        0,
        600,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(600);
  });

  it("does not count a continuation rule without established context", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [event(0, 600, { app: "Terminal" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("continues a primary context in a matching application", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 600, { app: "Firefox", title: "Stepik" }),
        event(600, 1_200, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        600,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(1_800);
  });

  it("keeps context alive throughout a long continuous continuation", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 1_800, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(2_100);
  });

  it("allows continuation after a short unrelated interruption without counting it", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 600, { app: "Terminal" }),
        event(900, 300, { app: "Discord" }),
        event(1_200, 600, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(1_500);
  });

  it("expires context after a long unrelated interruption", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 600, { app: "Terminal" }),
        event(900, 900, { app: "Discord" }),
        event(1_800, 600, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(900);
  });

  it("switches context when another goal has a primary match", () => {
    const japanese = goal("japanese", 30, appRule("KotoKitsu"));
    const result = calculateDailyProgress([contextGoal(), japanese], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 300, { app: "Terminal" }),
        event(600, 300, { app: "KotoKitsu" }),
        event(900, 300, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )]
    }), DATE);
    expect(result.find((item) => item.goalId === "devops")?.activeSeconds).toBe(600);
    expect(result.find((item) => item.goalId === "japanese")?.activeSeconds).toBe(300);
  });

  it("does not count AFK time or preserve context past its timeout", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 300, { app: "Terminal" }),
        event(600, 1_200, { app: "Terminal" }),
        event(1_800, 600, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(600, 1_200, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(600);
  });

  it("reconstructs context when calculating an arbitrary date", () => {
    const previousDate = "2026-08-15";
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }, previousDate),
        event(300, 600, { app: "Terminal" }, previousDate)
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        previousDate,
        "aw-watcher-web-firefox_host"
      )]
    }), previousDate);
    expect(result[0]?.activeSeconds).toBe(900);
  });

  it("does not count a default primary rule while AFK", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 240, { app: "Firefox", title: "Keybr" })],
      browserEvents: [event(
        0,
        240,
        { url: "https://keybr.com", title: "Keybr" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(0, 240, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("counts a matching passive primary rule while AFK", () => {
    const result = calculateDailyProgress([contextGoal(10, true)], activity({
      windowEvents: [event(0, 900, { app: "Firefox", title: "Stepik" })],
      browserEvents: [event(
        0,
        900,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(0, 900, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(900);
  });

  it("combines active and passive time for the same primary rule", () => {
    const result = calculateDailyProgress([contextGoal(10, true)], activity({
      windowEvents: [event(0, 1_200, { app: "Firefox", title: "Stepik" })],
      browserEvents: [event(
        0,
        1_200,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(300, 900, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(1_200);
  });

  it("lets passive primary time keep context alive for continuation", () => {
    const result = calculateDailyProgress([contextGoal(10, true)], activity({
      windowEvents: [
        event(0, 1_200, { app: "Firefox", title: "Stepik" }),
        event(1_200, 600, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        1_200,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(300, 900, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(1_800);
  });

  it("never counts a continuation rule while AFK", () => {
    const result = calculateDailyProgress([contextGoal(10, true)], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 300, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(300, 300, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(300);
  });

  it("lets uncounted continuation AFK time expire context", () => {
    const result = calculateDailyProgress([contextGoal(10, true)], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 1_200, { app: "Terminal" }),
        event(1_500, 600, { app: "Terminal" })
      ],
      browserEvents: [event(
        0,
        300,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(300, 1_200, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(300);
  });

  it("does not count a passive URL rule when its browser is in the background", () => {
    const result = calculateDailyProgress([contextGoal(10, true)], activity({
      windowEvents: [event(0, 900, { app: "Terminal", title: "Shell" })],
      browserEvents: [event(
        0,
        900,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(0, 900, { status: "afk" })]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("chooses only AFK-eligible goals before applying deterministic overlap fallback", () => {
    const ineligible = goal("a-ineligible", 30, urlRule("stepik.org"));
    const eligible = goal("z-eligible", 30, urlRule("stepik.org", "primary", true));
    const result = calculateDailyProgress([ineligible, eligible], activity({
      windowEvents: [event(0, 600, { app: "Firefox", title: "Stepik" })],
      browserEvents: [event(
        0,
        600,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_host"
      )],
      afkEvents: [event(0, 600, { status: "afk" })]
    }), DATE);
    expect(result.find((item) => item.goalId === "a-ineligible")?.activeSeconds).toBe(0);
    expect(result.find((item) => item.goalId === "z-eligible")?.activeSeconds).toBe(600);
  });
});
