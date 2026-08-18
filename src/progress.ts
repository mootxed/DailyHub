import { getLocalDateRange } from "./date";
import { getTrackingStartMs, isGoalTrackingActiveAt } from "./goal-lifecycle";
import { goalMatches, pickMatchingPrimaryGoal } from "./matcher";
import type { ActivityContext, ActivityEvent, DailyGoal, DayActivity, GoalProgress } from "./models";

interface TimedEvent {
  event: ActivityEvent;
  startMs: number;
  endMs: number;
}

interface BrowserEventIndex {
  events: TimedEvent[];
}

interface GoalContext {
  goalId: string;
  lastPrimaryTimestamp: number;
}

const BROWSER_CONTEXT_GRACE_MS = 120_000;

function parseEvents(
  events: ActivityEvent[],
  rangeStart: number,
  rangeEnd: number,
  preservePointEvents = false
): TimedEvent[] {
  return events.flatMap((event) => {
    const eventStart = new Date(event.timestamp).getTime();
    if (!Number.isFinite(eventStart)) return [];

    if (preservePointEvents && Number.isFinite(event.duration) && event.duration === 0) {
      return eventStart >= rangeStart && eventStart < rangeEnd
        ? [{ event, startMs: eventStart, endMs: eventStart }]
        : [];
    }

    const duration = Number.isFinite(event.duration) ? Math.max(0, event.duration) : 0;
    const startMs = Math.max(rangeStart, eventStart);
    const endMs = Math.min(rangeEnd, eventStart + duration * 1000);
    return endMs > startMs ? [{ event, startMs, endMs }] : [];
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

function latestEventAtOrBefore(events: TimedEvent[], timestamp: number): TimedEvent | undefined {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const event = events[middle];
    if (event !== undefined && event.startMs <= timestamp) low = middle + 1;
    else high = middle;
  }
  return events[low - 1];
}

function earliestEventAfter(events: TimedEvent[], timestamp: number): TimedEvent | undefined {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const event = events[middle];
    if (event !== undefined && event.startMs <= timestamp) low = middle + 1;
    else high = middle;
  }
  return events[low];
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

function browserSourceKey(event: TimedEvent): string | undefined {
  const identity = normalizeIdentity(browserIdentity(event) ?? "");
  return identity.length > 0 && identity !== "unknown" ? identity : undefined;
}

function indexBrowserEvents(events: TimedEvent[]): BrowserEventIndex {
  return { events };
}

const CHROMIUM_APPLICATIONS = ["chrome", "chromium", "edge", "vivaldi"];
const FIREFOX_APPLICATIONS = ["firefox", "librewolf", "waterfox", "floorp"];
const BROWSER_APPLICATIONS = [...CHROMIUM_APPLICATIONS, ...FIREFOX_APPLICATIONS, "brave", "opera", "safari", "browser"];

function containsAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function browserApplicationMatches(
  windowEvent: TimedEvent | undefined,
  browserEvent: TimedEvent | undefined
): boolean {
  if (windowEvent === undefined || browserEvent === undefined) return false;
  const application = normalizeIdentity(stringData(windowEvent, "app") ?? "");
  const sourceBrowser = browserSourceKey(browserEvent);
  if (application.length === 0) return false;
  if (sourceBrowser === undefined) return containsAny(application, BROWSER_APPLICATIONS);
  if (application.includes(sourceBrowser)) return true;

  if (sourceBrowser.includes("chrome") || sourceBrowser.includes("chromium")) {
    return containsAny(application, CHROMIUM_APPLICATIONS);
  }
  if (sourceBrowser.includes("firefox")) return containsAny(application, FIREFOX_APPLICATIONS);
  return false;
}

function browserTitleMatchesWindow(windowEvent: TimedEvent, browserEvent: TimedEvent): boolean {
  const windowTitle = stringData(windowEvent, "title")?.trim().toLocaleLowerCase() ?? "";
  const browserTitle = stringData(browserEvent, "title")?.trim().toLocaleLowerCase() ?? "";
  return windowTitle.length > 0
    && browserTitle.length > 0
    && (windowTitle.includes(browserTitle) || browserTitle.includes(windowTitle));
}

function findBrowserContextAt(
  browserEventIndex: BrowserEventIndex,
  windowEvent: TimedEvent | undefined,
  timestamp: number
): TimedEvent | undefined {
  const latestEvidence = latestEventAtOrBefore(browserEventIndex.events, timestamp);
  if (latestEvidence === undefined) return undefined;
  // A web watcher reports its own current tab; foreground-window focus is irrelevant here.
  if (latestEvidence.endMs > timestamp) {
    return latestEvidence;
  }

  const graceEnd = latestEvidence.endMs + BROWSER_CONTEXT_GRACE_MS;
  if (browserSourceKey(latestEvidence) === undefined
    || timestamp < latestEvidence.endMs
    || timestamp >= graceEnd) {
    return undefined;
  }

  const nextEvidence = earliestEventAfter(browserEventIndex.events, timestamp);
  // Reconstruct only a bounded, subsequently confirmed heartbeat gap. The existing
  // foreground/title check remains useful as optional corroboration at the live tail.
  const gapIsConfirmed = nextEvidence !== undefined && nextEvidence.startMs <= graceEnd;
  const foregroundCorroborates = windowEvent !== undefined
    && browserApplicationMatches(windowEvent, latestEvidence)
    && browserTitleMatchesWindow(windowEvent, latestEvidence);
  return gapIsConfirmed || foregroundCorroborates ? latestEvidence : undefined;
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
  const browserEvents = parseEvents(activity.browserEvents, rangeStart, rangeEnd, true);
  const browserEventIndex = indexBrowserEvents(browserEvents);
  const afkEvents = parseEvents(activity.afkEvents, rangeStart, rangeEnd);
  const boundaries = new Set<number>([rangeStart, rangeEnd]);

  for (const timed of [...windowEvents, ...browserEvents, ...afkEvents]) {
    boundaries.add(timed.startMs);
    boundaries.add(timed.endMs);
  }
  for (const browserEvent of browserEvents) {
    const graceEnd = browserEvent.endMs + BROWSER_CONTEXT_GRACE_MS;
    if (graceEnd > rangeStart && graceEnd < rangeEnd) boundaries.add(graceEnd);
  }
  for (const goal of goals) {
    const trackingStartMs = getTrackingStartMs(goal);
    if (trackingStartMs !== undefined && trackingStartMs > rangeStart && trackingStartMs < rangeEnd) {
      boundaries.add(trackingStartMs);
    }
  }

  const secondsByGoal = new Map(goals.map((goal) => [goal.id, 0]));
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const timeline = [...boundaries].sort((left, right) => left - right);
  let currentContext: GoalContext | undefined;

  for (let index = 0; index < timeline.length - 1; index += 1) {
    const start = timeline[index];
    const end = timeline[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;

    const windowEvent = eventAt(windowEvents, start);
    const browserEvent = findBrowserContextAt(browserEventIndex, windowEvent, start);
    if (windowEvent === undefined && browserEvent === undefined) continue;

    const activityContext = contextAt(windowEvent, browserEvent);
    const duringAfk = isAfk(eventAt(afkEvents, start));
    const eligibleGoals = goals.filter((goal) => isGoalTrackingActiveAt(goal, start));
    const primaryGoal = pickMatchingPrimaryGoal(eligibleGoals, activityContext, duringAfk);
    if (primaryGoal !== undefined) {
      secondsByGoal.set(primaryGoal.id, (secondsByGoal.get(primaryGoal.id) ?? 0) + (end - start) / 1000);
      currentContext = { goalId: primaryGoal.id, lastPrimaryTimestamp: end };
      continue;
    }

    if (duringAfk) continue;

    if (currentContext !== undefined) {
      const contextGoal = goalsById.get(currentContext.goalId);
      const timeoutMs = (contextGoal?.contextTimeoutMinutes ?? 0) * 60_000;
      const leaseEnd = currentContext.lastPrimaryTimestamp + timeoutMs;
      if (contextGoal === undefined || start >= leaseEnd) {
        currentContext = undefined;
      } else if (goalMatches(contextGoal, activityContext, "continuation")) {
        const countedEnd = Math.min(end, leaseEnd);
        secondsByGoal.set(
          contextGoal.id,
          (secondsByGoal.get(contextGoal.id) ?? 0) + (countedEnd - start) / 1000
        );
        if (end >= leaseEnd) currentContext = undefined;
      }
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
