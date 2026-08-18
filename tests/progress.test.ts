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

  it("bridges the real-data-shaped keybr browser heartbeat gap", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 130.323, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        46.157,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )],
      afkEvents: [event(0, 130.323, { status: "not-afk" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBeCloseTo(130.323, 3);
  });

  it("uses a zero-duration tab change as point-in-time evidence until the next heartbeat", () => {
    const course = goal("course", 30, urlRule("udemy.com/course/docker-ru"));
    const result = calculateDailyProgress([course], activity({
      windowEvents: [event(
        0,
        240,
        { app: "Google-chrome", title: "Course: Docker from scratch | Udemy - Google Chrome" }
      )],
      browserEvents: [
        event(
          0,
          0,
          {
            url: "https://www.udemy.com/course/docker-ru/learn/lecture/30644492#overview",
            title: "Course: Docker from scratch | Udemy"
          },
          DATE,
          "aw-watcher-web-chrome_fedora"
        ),
        event(
          90,
          150,
          {
            url: "https://www.udemy.com/course/docker-ru/learn/lecture/30644492#overview",
            title: "Course: Docker from scratch | Udemy"
          },
          DATE,
          "aw-watcher-web-chrome_fedora"
        )
      ],
      afkEvents: [event(0, 240, { status: "not-afk" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(240);
  });

  it("does not let a zero-duration browser event create time without a foreground window", () => {
    const course = goal("course", 30, urlRule("example.com/course"));
    const result = calculateDailyProgress([course], activity({
      browserEvents: [event(
        0,
        0,
        { url: "https://example.com/course", title: "Course" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("clips inferred browser context at the two-minute grace boundary", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 300, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(150);
  });

  it("stops inferred browser context as soon as the window title changes", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [
        event(0, 60, { app: "Google-chrome", title: "PRACTICE - Google Chrome" }),
        event(60, 120, { app: "Google-chrome", title: "ChatGPT - Google Chrome" })
      ],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: " practice " },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(60);
  });

  it("does not keep counting a stale active URL after the foreground browser title changes", () => {
    const course = goal("course", 30, urlRule("example.com/course"));
    const result = calculateDailyProgress([course], activity({
      windowEvents: [
        event(0, 60, { app: "Google-chrome", title: "Course - Google Chrome" }),
        event(60, 120, { app: "Google-chrome", title: "ChatGPT - Google Chrome" })
      ],
      browserEvents: [event(
        0,
        180,
        { url: "https://example.com/course", title: "Course" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(60);
  });

  it("lets newer point evidence supersede an overlapping event from the previous tab", () => {
    const course = goal("course", 30, urlRule("example.com/course"));
    const result = calculateDailyProgress([course], activity({
      windowEvents: [
        event(0, 60, { app: "Google-chrome", title: "Course - Google Chrome" }),
        event(60, 120, { app: "Google-chrome", title: "ChatGPT - Google Chrome" })
      ],
      browserEvents: [
        event(
          0,
          180,
          { url: "https://example.com/course", title: "Course" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        ),
        event(
          60,
          0,
          { url: "https://chatgpt.com", title: "ChatGPT" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        )
      ]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(60);
  });

  it("does not carry Chrome browser context into a Firefox foreground window", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 120, { app: "Firefox", title: "Practice - Mozilla Firefox" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("stops inferred browser context as soon as the foreground application changes", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [
        event(0, 60, { app: "Google-chrome", title: "Practice - Google Chrome" }),
        event(60, 60, { app: "Obsidian", title: "Practice" })
      ],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(60);
  });

  it("uses the latest same-browser evidence instead of searching back for a matching title", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [
        event(
          0,
          30,
          { url: "https://www.keybr.com/", title: "Practice" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        ),
        event(
          40,
          10,
          { url: "https://chatgpt.com/", title: "ChatGPT" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        )
      ]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(40);
  });

  it("does not let evidence from another browser cancel the foreground browser context", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 100, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [
        event(
          0,
          30,
          { url: "https://www.keybr.com/", title: "Practice" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        ),
        event(
          40,
          10,
          { url: "https://example.com/", title: "Example" },
          DATE,
          "aw-watcher-web-firefox_fedora"
        )
      ]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(100);
  });

  it("always uses a real active browser event instead of inferred context", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 80, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [
        event(
          0,
          30,
          { url: "https://www.keybr.com/", title: "Practice" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        ),
        event(
          20,
          60,
          { url: "https://chatgpt.com/", title: "ChatGPT" },
          DATE,
          "aw-watcher-web-chrome_fedora"
        )
      ]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(20);
  });

  it("can carry forward a tiny browser heartbeat without extending past grace", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 180, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        0.001,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBeCloseTo(120.001, 3);
  });

  it("does not infer browser context from an empty browser title", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(30);
  });

  it("does not infer browser context from an empty window title", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(30);
  });

  it("does not infer browser context without an identifiable browser source", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(0, 30, { url: "https://www.keybr.com/", title: "Practice" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(30);
  });

  it("does not infer a URL when browser watcher data is missing", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "Practice - Google Chrome" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("does not mutate ActivityWatch events while inferring browser context", () => {
    const dayActivity = activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    });
    const original = JSON.stringify(dayActivity);

    calculateDailyProgress([goal("typing", 30, urlRule("keybr.com"))], dayActivity, DATE);

    expect(JSON.stringify(dayActivity)).toBe(original);
  });

  it("keeps deterministic overlap attribution during inferred browser context", () => {
    const goals = [
      goal("z-goal", 30, urlRule("keybr.com")),
      goal("a-goal", 30, urlRule("keybr.com"))
    ];
    const result = calculateDailyProgress(goals, activity({
      windowEvents: [event(0, 120, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result.find((item) => item.goalId === "a-goal")?.activeSeconds).toBe(120);
    expect(result.find((item) => item.goalId === "z-goal")?.activeSeconds).toBe(0);
  });

  it("keeps AFK exclusion during inferred browser context", () => {
    const typing = goal("typing", 30, urlRule("keybr.com"));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 90, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )],
      afkEvents: [event(30, 60, { status: "afk" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(30);
  });

  it("keeps count-while-AFK behavior during inferred browser context", () => {
    const typing = goal("typing", 30, urlRule("keybr.com", "primary", true));
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 90, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )],
      afkEvents: [event(30, 60, { status: "afk" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(90);
  });

  it("lets an inferred Primary refresh the existing continuation lease", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 120, { app: "Firefox", title: "Stepik - Mozilla Firefox" }),
        event(120, 600, { app: "Terminal", title: "Shell" })
      ],
      browserEvents: [event(
        0,
        30,
        { url: "https://stepik.org/lesson/1", title: "Stepik" },
        DATE,
        "aw-watcher-web-firefox_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(720);
  });

  it("never attributes inferred browser context before trackingStartedAt", () => {
    const typing = {
      ...goal("typing", 30, urlRule("keybr.com")),
      trackingStartedAt: timestamp(60)
    };
    const result = calculateDailyProgress([typing], activity({
      windowEvents: [event(0, 130, { app: "Google-chrome", title: "Practice - Google Chrome" })],
      browserEvents: [event(
        0,
        30,
        { url: "https://www.keybr.com/", title: "Practice" },
        DATE,
        "aw-watcher-web-chrome_fedora"
      )]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(70);
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

  it("counts continuation only inside the primary lease", () => {
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
    expect(result[0]?.activeSeconds).toBe(1_200);
  });

  it("does not let a long continuous continuation refresh context", () => {
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
    expect(result[0]?.activeSeconds).toBe(900);
  });

  it("counts Stepik then Konsole only until the original ten-minute lease expires", () => {
    const devops = goal("devops", 90, [
      urlRule("stepik.org"),
      {
        id: "continuation-konsole",
        role: "continuation",
        field: "application",
        operator: "contains",
        value: "konsole"
      }
    ]);
    const result = calculateDailyProgress([devops], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 1_500, { app: "org.kde.konsole", title: "Shell" })
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

  it("does not let continuation preserve context across an interruption", () => {
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
    expect(result[0]?.activeSeconds).toBe(900);
  });

  it("refreshes the lease when a new primary segment matches", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 300, { app: "Terminal" }),
        event(600, 300, { app: "Firefox", title: "Stepik" }),
        event(900, 600, { app: "Terminal" })
      ],
      browserEvents: [
        event(
          0,
          300,
          { url: "https://stepik.org/lesson/1", title: "Stepik" },
          DATE,
          "aw-watcher-web-firefox_host"
        ),
        event(
          600,
          300,
          { url: "https://stepik.org/lesson/2", title: "Stepik" },
          DATE,
          "aw-watcher-web-firefox_host"
        )
      ]
    }), DATE);
    expect(result[0]?.activeSeconds).toBe(1_500);
  });

  it("clips a continuation event at the exact lease boundary", () => {
    const result = calculateDailyProgress([contextGoal()], activity({
      windowEvents: [
        event(0, 300, { app: "Firefox", title: "Stepik" }),
        event(300, 900, { app: "Terminal" })
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

  it("clips 23:58 to 00:02 and does not carry its context across midnight", () => {
    const midnight = getLocalDateRange(DATE).end.getTime();
    const devopsActivity = activity({
      windowEvents: [
        {
          timestamp: new Date(midnight - 120_000).toISOString(),
          duration: 120,
          data: { app: "Firefox", title: "Stepik" }
        },
        {
          timestamp: new Date(midnight).toISOString(),
          duration: 120,
          data: { app: "Terminal" }
        }
      ],
      browserEvents: [{
        timestamp: new Date(midnight - 120_000).toISOString(),
        duration: 120,
        data: { url: "https://stepik.org/lesson/1", title: "Stepik" },
        sourceBucketId: "aw-watcher-web-firefox_host"
      }]
    });

    expect(calculateDailyProgress([contextGoal()], devopsActivity, DATE)[0]?.activeSeconds).toBe(120);
    expect(calculateDailyProgress([contextGoal()], devopsActivity, "2026-08-17")[0]?.activeSeconds).toBe(0);
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

  it("clips a matching event at the exact tracking start", () => {
    const tracked = {
      ...goal("typing", 30, appRule("kitty")),
      trackingStartedAt: timestamp(300)
    };
    const result = calculateDailyProgress([tracked], activity({
      windowEvents: [event(0, 600, { app: "kitty" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(300);
  });

  it("keeps legacy goals historically active", () => {
    const result = calculateDailyProgress([goal("typing", 30, appRule("kitty"))], activity({
      windowEvents: [event(0, 600, { app: "kitty" })]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(600);
  });

  it("does not let a new deterministic winner steal pre-creation overlap", () => {
    const oldGoal = goal("z-old", 30, appRule("kitty"));
    const newGoal = {
      ...goal("a-new", 30, appRule("kitty")),
      trackingStartedAt: timestamp(600)
    };
    const result = calculateDailyProgress([oldGoal, newGoal], activity({
      windowEvents: [event(0, 1_200, { app: "kitty" })]
    }), DATE);

    expect(result.find((item) => item.goalId === "z-old")?.activeSeconds).toBe(600);
    expect(result.find((item) => item.goalId === "a-new")?.activeSeconds).toBe(600);
  });

  it("does not create continuation context from a pre-start Primary", () => {
    const tracked = {
      ...goal("study", 30, [appRule("Primary"), appRule("Continuation", "continuation")]),
      trackingStartedAt: timestamp(300)
    };
    const result = calculateDailyProgress([tracked], activity({
      windowEvents: [
        event(0, 240, { app: "Primary" }),
        event(360, 240, { app: "Continuation" })
      ]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(0);
  });

  it("lets a Primary spanning creation establish post-start context", () => {
    const tracked = {
      ...goal("study", 30, [appRule("Primary"), appRule("Continuation", "continuation")]),
      trackingStartedAt: timestamp(300)
    };
    const result = calculateDailyProgress([tracked], activity({
      windowEvents: [
        event(240, 180, { app: "Primary" }),
        event(420, 120, { app: "Continuation" })
      ]
    }), DATE);

    expect(result[0]?.activeSeconds).toBe(240);
  });
});
