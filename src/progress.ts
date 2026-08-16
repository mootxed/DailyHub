import { getLocalDateRange } from "./date";
import { pickMatchingGoal } from "./matcher";
import type { ActivityContext, ActivityEvent, DailyGoal, DayActivity, GoalProgress } from "./models";

interface TimedEvent {
  event: ActivityEvent;
  startMs: number;
  endMs: number;
}

function parseEvents(events: ActivityEvent[], rangeStart: number, rangeEnd: number): TimedEvent[] {
  return events.flatMap((event) => {
    const eventStart = new Date(event.timestamp).getTime();
    const duration = Number.isFinite(event.duration) ? Math.max(0, event.duration) : 0;
    const startMs = Math.max(rangeStart, eventStart);
    const endMs = Math.min(rangeEnd, eventStart + duration * 1000);
    return Number.isFinite(eventStart) && endMs > startMs ? [{ event, startMs, endMs }] : [];
  }).sort((left, right) => left.startMs - right.startMs);
}

function eventAt(
  events: TimedEvent[],
  timestamp: number,
  predicate: (event: TimedEvent) => boolean = () => true
): TimedEvent | undefined {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const event = events[middle];
    if (event !== undefined && event.startMs <= timestamp) low = middle + 1;
    else high = middle;
  }

  for (let index = low - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.endMs > timestamp && predicate(event)) return event;
  }
  return undefined;
}

function stringData(event: TimedEvent | undefined, key: string): string | undefined {
  const value = event?.event.data[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function browserIdentity(event: TimedEvent): string | undefined {
  const match = /^aw-watcher-web-([^_]+)/i.exec(event.event.sourceBucketId ?? "");
  return match?.[1];
}

const CHROMIUM_APPLICATIONS = ["chrome", "chromium", "edge", "vivaldi"];
const FIREFOX_APPLICATIONS = ["firefox", "librewolf", "waterfox", "floorp"];
const BROWSER_APPLICATIONS = [...CHROMIUM_APPLICATIONS, ...FIREFOX_APPLICATIONS, "brave", "opera", "safari", "browser"];

function containsAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function browserIsActive(windowEvent: TimedEvent | undefined, browserEvent: TimedEvent | undefined): boolean {
  if (windowEvent === undefined || browserEvent === undefined) return false;
  const application = normalizeIdentity(stringData(windowEvent, "app") ?? "");
  const sourceBrowser = normalizeIdentity(browserIdentity(browserEvent) ?? "");
  if (application.length > 0 && sourceBrowser.length > 0 && application.includes(sourceBrowser)) return true;

  if (sourceBrowser.includes("chrome") || sourceBrowser.includes("chromium")) {
    return containsAny(application, CHROMIUM_APPLICATIONS);
  }
  if (sourceBrowser.includes("firefox")) return containsAny(application, FIREFOX_APPLICATIONS);
  if (sourceBrowser.length > 0 && sourceBrowser !== "unknown") return false;

  const windowTitle = stringData(windowEvent, "title")?.trim().toLocaleLowerCase() ?? "";
  const browserTitle = stringData(browserEvent, "title")?.trim().toLocaleLowerCase() ?? "";
  return containsAny(application, BROWSER_APPLICATIONS)
    && windowTitle.length > 0
    && browserTitle.length > 0
    && (windowTitle.includes(browserTitle) || browserTitle.includes(windowTitle));
}

function contextAt(windowEvent: TimedEvent | undefined, browserEvent: TimedEvent | undefined): ActivityContext {
  return {
    application: stringData(windowEvent, "app"),
    windowTitle: stringData(windowEvent, "title"),
    url: stringData(browserEvent, "url")
  };
}

function isAfk(event: TimedEvent | undefined): boolean {
  if (event === undefined) return false;
  return stringData(event, "status")?.trim().toLocaleLowerCase() === "afk";
}

export function calculateDailyProgress(
  goals: DailyGoal[],
  activity: DayActivity,
  date: Date | string
): GoalProgress[] {
  const range = getLocalDateRange(date);
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const windowEvents = parseEvents(activity.windowEvents, rangeStart, rangeEnd);
  const browserEvents = parseEvents(activity.browserEvents, rangeStart, rangeEnd);
  const afkEvents = parseEvents(activity.afkEvents, rangeStart, rangeEnd);
  const boundaries = new Set<number>([rangeStart, rangeEnd]);

  for (const timed of [...windowEvents, ...browserEvents, ...afkEvents]) {
    boundaries.add(timed.startMs);
    boundaries.add(timed.endMs);
  }

  const secondsByGoal = new Map(goals.map((goal) => [goal.id, 0]));
  const timeline = [...boundaries].sort((left, right) => left - right);

  for (let index = 0; index < timeline.length - 1; index += 1) {
    const start = timeline[index];
    const end = timeline[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;

    const windowEvent = eventAt(windowEvents, start);
    const browserEvent = eventAt(browserEvents, start, (event) => browserIsActive(windowEvent, event));
    if (windowEvent === undefined && browserEvent === undefined) continue;
    if (isAfk(eventAt(afkEvents, start))) continue;

    const goal = pickMatchingGoal(goals, contextAt(windowEvent, browserEvent));
    if (goal !== undefined) {
      secondsByGoal.set(goal.id, (secondsByGoal.get(goal.id) ?? 0) + (end - start) / 1000);
    }
  }

  return goals.map((goal) => {
    const activeSeconds = secondsByGoal.get(goal.id) ?? 0;
    const actualMinutes = activeSeconds / 60;
    return {
      goalId: goal.id,
      activeSeconds,
      actualMinutes,
      targetMinutes: goal.targetMinutes,
      completed: actualMinutes >= goal.targetMinutes,
      progressRatio: goal.targetMinutes > 0 ? Math.min(actualMinutes / goal.targetMinutes, 1) : 0
    };
  });
}

export function getGoalProgress(
  goalId: string,
  goals: DailyGoal[],
  activity: DayActivity,
  date: Date | string
): GoalProgress | undefined {
  return calculateDailyProgress(goals, activity, date).find(
    (progress) => progress.goalId === goalId
  );
}
