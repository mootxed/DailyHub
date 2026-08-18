import { describe, expect, it } from "vitest";
import {
  calculateComputerActivity,
  calculateComputerActivityRange,
  displayApplicationName,
  normalizeDomain,
  resolveComputerActivityTimeline
} from "../src/activity-analysis";
import { getLocalDateRange } from "../src/date";
import type { ActivityCategory, ActivityEvent, DayActivity } from "../src/models";

const DATE = "2026-08-16";

function event(
  offsetSeconds: number,
  duration: number,
  data: Record<string, unknown>,
  sourceBucketId?: string,
  date = DATE
): ActivityEvent {
  return {
    timestamp: new Date(getLocalDateRange(date).start.getTime() + offsetSeconds * 1000).toISOString(),
    duration,
    data,
    sourceBucketId
  };
}

function activity(overrides: Partial<DayActivity> = {}): DayActivity {
  return { windowEvents: [], browserEvents: [], afkEvents: [], ...overrides };
}

const categories: ActivityCategory[] = [{
  id: "development",
  name: "Development",
  rules: [
    { id: "terminal", field: "application", operator: "equals", value: "Terminal" },
    { id: "github", field: "domain", operator: "equals", value: "github.com" }
  ]
}, {
  id: "communication",
  name: "Communication",
  rules: [{ id: "discord", field: "application", operator: "equals", value: "Discord" }]
}];

describe("computer activity analysis", () => {
  it("creates a mutually exclusive foreground timeline", () => {
    const result = calculateComputerActivity(activity({ windowEvents: [
      event(0, 600, { app: "Chrome" }),
      event(600, 1_200, { app: "Obsidian" }),
      event(1_800, 600, { app: "Terminal" })
    ] }), DATE);
    expect(result.activeComputerSeconds).toBe(2_400);
    expect(result.applications.map((item) => [item.label, item.seconds])).toEqual([
      ["Obsidian", 1_200], ["Chrome", 600], ["Terminal", 600]
    ]);
    expect(result.applications.reduce((sum, item) => sum + item.seconds, 0)).toBe(result.activeComputerSeconds);
  });

  it("always excludes AFK time from computer activity", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 3_600, { app: "Chrome" })],
      afkEvents: [event(1_200, 1_200, { status: "afk" })]
    }), DATE);
    expect(result.activeComputerSeconds).toBe(2_400);
  });

  it("does not treat a background browser tab as foreground site activity", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 1_800, { app: "Obsidian" })],
      browserEvents: [event(0, 1_800, { url: "https://youtube.com/watch?v=private" }, "aw-watcher-web-chrome_host")]
    }), DATE);
    expect(result.activeComputerSeconds).toBe(1_800);
    expect(result.applications).toMatchObject([{ label: "Obsidian", seconds: 1_800 }]);
    expect(result.sites).toEqual([]);
  });

  it("enriches foreground browser time without adding parallel time", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 1_800, { app: "Google Chrome" })],
      browserEvents: [event(0, 1_800, { url: "https://www.youtube.com/watch?v=private" }, "aw-watcher-web-chrome_host")]
    }), DATE);
    expect(result.activeComputerSeconds).toBe(1_800);
    expect(result.sites).toMatchObject([{ id: "youtube.com", seconds: 1_800 }]);
  });

  it("uses active browser evidence when legacy events have no source bucket id", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 300, { app: "Firefox" })],
      browserEvents: [event(0, 300, { url: "https://example.com/private" })]
    }), DATE);
    expect(result.sites).toMatchObject([{ id: "example.com", seconds: 300 }]);
  });

  it("bridges only short confirmed gaps between identical window heartbeats", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 60, { app: "Obsidian", title: "Note" }), event(70, 60, { app: "Obsidian", title: "Note" })]
    }), DATE);
    expect(result.activeComputerSeconds).toBe(130);

    const withAfk = calculateComputerActivity(activity({
      windowEvents: [event(0, 60, { app: "Obsidian", title: "Note" }), event(70, 60, { app: "Obsidian", title: "Note" })],
      afkEvents: [event(60, 10, { status: "afk" })]
    }), DATE);
    expect(withAfk.activeComputerSeconds).toBe(120);
  });

  it("tracks domain switches inside one foreground browser application", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 1_800, { app: "Chrome" })],
      browserEvents: [
        event(0, 600, { url: "https://github.com/a" }, "aw-watcher-web-chrome_host"),
        event(600, 600, { url: "https://youtube.com/a" }, "aw-watcher-web-chrome_host"),
        event(1_200, 600, { url: "https://github.com/b" }, "aw-watcher-web-chrome_host")
      ]
    }), DATE);
    expect(result.applications).toMatchObject([{ seconds: 1_800 }]);
    expect(result.sites.map((item) => [item.id, item.seconds])).toEqual([
      ["github.com", 1_200], ["youtube.com", 600]
    ]);
    expect(result.sites.reduce((sum, item) => sum + item.seconds, 0))
      .toBeLessThanOrEqual(result.browserForegroundSeconds);
  });

  it("never mixes Chrome and Firefox watcher contexts", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 600, { app: "Chrome" })],
      browserEvents: [
        event(0, 600, { url: "https://github.com" }, "aw-watcher-web-chrome_host"),
        event(0, 600, { url: "https://youtube.com" }, "aw-watcher-web-firefox_host")
      ]
    }), DATE);
    expect(result.sites).toMatchObject([{ id: "github.com", seconds: 600 }]);
  });

  it("classifies once in category order and preserves Uncategorized", () => {
    const overlapping: ActivityCategory[] = [{
      id: "first", name: "First", rules: [{ id: "one", field: "application", operator: "contains", value: "term" }]
    }, {
      id: "second", name: "Second", rules: [{ id: "two", field: "application", operator: "equals", value: "Terminal" }]
    }];
    const result = calculateComputerActivity(activity({ windowEvents: [
      event(0, 600, { app: "Terminal" }), event(600, 300, { app: "Unknown" })
    ] }), DATE, overlapping);
    expect(result.categories.map((item) => [item.id, item.seconds])).toEqual([
      ["first", 600], ["uncategorized", 300]
    ]);
    expect(result.categories.reduce((sum, item) => sum + item.seconds, 0)).toBe(result.activeComputerSeconds);
  });

  it("uses application and domain category rules deterministically", () => {
    const result = calculateComputerActivity(activity({
      windowEvents: [event(0, 600, { app: "Chrome" }), event(600, 300, { app: "Discord" })],
      browserEvents: [event(0, 600, { url: "https://github.com/repo" }, "aw-watcher-web-chrome_host")]
    }), DATE, categories);
    expect(result.categories.map((item) => [item.label, item.seconds])).toEqual([
      ["Development", 600], ["Communication", 300]
    ]);
  });

  it("returns deleted-category activity to Uncategorized without changing totals", () => {
    const source = activity({ windowEvents: [event(0, 600, { app: "Terminal" })] });
    const before = calculateComputerActivity(source, DATE, categories);
    const after = calculateComputerActivity(source, DATE, categories.filter((category) => category.id !== "development"));
    expect(before.categories).toMatchObject([{ id: "development", seconds: 600 }]);
    expect(after.categories).toMatchObject([{ id: "uncategorized", seconds: 600 }]);
    expect(after.activeComputerSeconds).toBe(before.activeComputerSeconds);
  });

  it("clips segments at local midnight", () => {
    const start = getLocalDateRange(DATE).start.getTime();
    const timeline = resolveComputerActivityTimeline(activity({
      windowEvents: [{
        timestamp: new Date(start - 120_000).toISOString(), duration: 12 * 60, data: { app: "Obsidian" }
      }]
    }), start, start + 24 * 60 * 60_000);
    expect(timeline).toMatchObject([{ startMs: start, endMs: start + 600_000 }]);
  });

  it("aggregates range totals and top activity", () => {
    const first = calculateComputerActivity(activity({ windowEvents: [event(0, 600, { app: "Obsidian" })] }), DATE);
    const second = calculateComputerActivity(activity({ windowEvents: [event(0, 300, { app: "Obsidian" }, undefined, "2026-08-17")] }), "2026-08-17");
    const range = calculateComputerActivityRange([first, second]);
    expect(range).toMatchObject({ totalSeconds: 900, averageSeconds: 450, activeDays: 2, availableDays: 2 });
    expect(range.topApplication).toMatchObject({ label: "Obsidian", seconds: 900 });
  });

  it("normalizes domains and presentation names safely", () => {
    expect(normalizeDomain("https://WWW.Example.com/path?q=private")).toBe("example.com");
    expect(normalizeDomain("not a url")).toBeUndefined();
    expect(normalizeDomain("file:///private/path")).toBeUndefined();
    expect(displayApplicationName("google-chrome")).toBe("Google Chrome");
    expect(displayApplicationName("my_custom-app")).toBe("My Custom App");
  });
});
