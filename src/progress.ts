import { getLocalDateRange } from "./date";
import { getTrackingStartMs, isGoalTrackingActiveAt } from "./goal-lifecycle";
import { getConfigRevisionBoundaries, getGoalAt } from "./goal-config-history";
import { goalMatches, pickMatchingPrimaryGoal } from "./matcher";
import type { ActivityContext, ActivityEvent, ActivityWatchStatus, DailyGoal, DayActivity, GoalProgress } from "./models";

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

export interface TrackingSegment {
  goalId: string;
  startMs: number;
  endMs: number;
}

export interface LiveTrackingState {
  goal: DailyGoal | undefined;
  currentSessionStartMs: number | undefined;
  currentSessionSeconds: number;
}

export type TrackingDiagnosticReason = "tracking-now" | "paused" | "not-tracking-yet"
  | "afk-blocked" | "primary-mismatch" | "watcher-unavailable" | "overlap-lost"
  | "no-current-activity";

export interface GoalTrackingDiagnostic {
  goalId: string;
  primaryMatched: boolean;
  reason: TrackingDiagnosticReason;
}

export interface TrackingDiagnostics {
  winnerGoalId: string | undefined;
  context: ActivityContext;
  afk: boolean;
  browserEvidenceAgeSeconds: number | undefined;
  candidates: GoalTrackingDiagnostic[];
}

export const BROWSER_CONTEXT_GRACE_MS = 120_000;
export const LIVE_EVENT_FRESHNESS_MS = 15_000;

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

function extendFreshTail(events: ActivityEvent[], timestampMs: number): ActivityEvent[] {
  let freshestIndex: number | undefined;
  let freshestEnd = Number.NEGATIVE_INFINITY;
  events.forEach((event, index) => {
    const startMs = Date.parse(event.timestamp);
    const duration = Number.isFinite(event.duration) ? Math.max(0, event.duration) : 0;
    const endMs = startMs + duration * 1000;
    if (duration > 0 && startMs <= timestampMs && endMs > freshestEnd) {
      freshestIndex = index;
      freshestEnd = endMs;
    }
  });
  if (freshestIndex === undefined
    || freshestEnd >= timestampMs
    || timestampMs - freshestEnd > LIVE_EVENT_FRESHNESS_MS) return events;
  return events.map((event, index) => index === freshestIndex
    ? { ...event, duration: event.duration + (timestampMs - freshestEnd) / 1000 }
    : event);
}

function liveActivityAt(activity: DayActivity, timestampMs: number): DayActivity {
  return {
    windowEvents: extendFreshTail(activity.windowEvents, timestampMs),
    browserEvents: extendFreshTail(activity.browserEvents, timestampMs),
    afkEvents: extendFreshTail(activity.afkEvents, timestampMs)
  };
}

export function calculateDailyProgress(
  goals: DailyGoal[],
  activity: DayActivity,
  date: Date | string
): GoalProgress[] {
  const range = getLocalDateRange(date);
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const segments = resolveTrackingTimeline(goals, activity, rangeStart, rangeEnd);
  const secondsByGoal = new Map(goals.map((goal) => [goal.id, 0]));
  for (const segment of segments) {
    secondsByGoal.set(
      segment.goalId,
      (secondsByGoal.get(segment.goalId) ?? 0) + (segment.endMs - segment.startMs) / 1000
    );
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

export function resolveTrackingTimeline(
  goals: DailyGoal[],
  activity: DayActivity,
  rangeStart: number,
  rangeEnd: number
): TrackingSegment[] {
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return [];
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
    for (const pause of goal.trackingPauses ?? []) {
      const pauseStartMs = Date.parse(pause.startedAt);
      const pauseEndMs = pause.endedAt === undefined ? undefined : Date.parse(pause.endedAt);
      if (Number.isFinite(pauseStartMs) && pauseStartMs > rangeStart && pauseStartMs < rangeEnd) {
        boundaries.add(pauseStartMs);
      }
      if (pauseEndMs !== undefined
        && Number.isFinite(pauseEndMs)
        && pauseEndMs > rangeStart
        && pauseEndMs < rangeEnd) {
        boundaries.add(pauseEndMs);
      }
    }
    for (const boundary of getConfigRevisionBoundaries(goal, rangeStart, rangeEnd)) {
      boundaries.add(boundary);
    }
  }

  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const timeline = [...boundaries].sort((left, right) => left - right);
  const segments: TrackingSegment[] = [];
  let currentContext: GoalContext | undefined;

  for (let index = 0; index < timeline.length - 1; index += 1) {
    const start = timeline[index];
    const end = timeline[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;

    if (currentContext !== undefined) {
      const contextGoal = goalsById.get(currentContext.goalId);
      if (contextGoal === undefined || !isGoalTrackingActiveAt(contextGoal, start)) {
        currentContext = undefined;
      }
    }

    const windowEvent = eventAt(windowEvents, start);
    const browserEvent = findBrowserContextAt(browserEventIndex, windowEvent, start);
    if (windowEvent === undefined && browserEvent === undefined) continue;

    const activityContext = contextAt(windowEvent, browserEvent);
    const duringAfk = isAfk(eventAt(afkEvents, start));
    const eligibleGoals = goals
      .filter((goal) => isGoalTrackingActiveAt(goal, start))
      .map((goal) => getGoalAt(goal, start));
    const primaryGoal = pickMatchingPrimaryGoal(eligibleGoals, activityContext, duringAfk);
    if (primaryGoal !== undefined) {
      segments.push({ goalId: primaryGoal.id, startMs: start, endMs: end });
      currentContext = { goalId: primaryGoal.id, lastPrimaryTimestamp: end };
      continue;
    }

    if (duringAfk) continue;

    if (currentContext !== undefined) {
      const storedContextGoal = goalsById.get(currentContext.goalId);
      const contextGoal = storedContextGoal === undefined ? undefined : getGoalAt(storedContextGoal, start);
      const timeoutMs = (contextGoal?.contextTimeoutMinutes ?? 0) * 60_000;
      const leaseEnd = currentContext.lastPrimaryTimestamp + timeoutMs;
      if (contextGoal === undefined || start >= leaseEnd) {
        currentContext = undefined;
      } else if (goalMatches(contextGoal, activityContext, "continuation")) {
        const countedEnd = Math.min(end, leaseEnd);
        segments.push({ goalId: contextGoal.id, startMs: start, endMs: countedEnd });
        if (end >= leaseEnd) currentContext = undefined;
      }
    }
  }
  return segments;
}

export function resolveTrackingAt(
  goals: DailyGoal[],
  activity: DayActivity,
  timestampMs: number,
  lookbackStartMs: number
): DailyGoal | undefined {
  return resolveLiveTrackingState(goals, activity, timestampMs, lookbackStartMs).goal;
}

export function resolveLiveTrackingState(
  goals: DailyGoal[],
  activity: DayActivity,
  timestampMs: number,
  lookbackStartMs: number
): LiveTrackingState {
  const liveActivity = liveActivityAt(activity, timestampMs);
  const segments = resolveTrackingTimeline(goals, liveActivity, lookbackStartMs, timestampMs);
  const segment = segments.at(-1);
  if (segment?.endMs !== timestampMs) {
    return { goal: undefined, currentSessionStartMs: undefined, currentSessionSeconds: 0 };
  }
  let sessionStart = segment.startMs;
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const previous = segments[index];
    if (previous?.goalId !== segment.goalId || previous.endMs !== sessionStart) break;
    sessionStart = previous.startMs;
  }
  return {
    goal: goals.find((goal) => goal.id === segment.goalId),
    currentSessionStartMs: sessionStart,
    currentSessionSeconds: Math.max(0, (timestampMs - sessionStart) / 1000)
  };
}

export function resolveTrackingAtDetailed(
  goals: DailyGoal[],
  activity: DayActivity,
  timestampMs: number,
  lookbackStartMs: number,
  status?: ActivityWatchStatus
): TrackingDiagnostics {
  const liveActivity = liveActivityAt(activity, timestampMs);
  const live = resolveLiveTrackingState(goals, activity, timestampMs, lookbackStartMs);
  const sample = Math.max(lookbackStartMs, timestampMs - 1);
  const windowEvents = parseEvents(liveActivity.windowEvents, lookbackStartMs, timestampMs + 1);
  const browserEvents = parseEvents(liveActivity.browserEvents, lookbackStartMs, timestampMs + 1, true);
  const afkEvents = parseEvents(liveActivity.afkEvents, lookbackStartMs, timestampMs + 1);
  const windowEvent = eventAt(windowEvents, sample);
  const browserEvidence = findBrowserContextAt(indexBrowserEvents(browserEvents), windowEvent, sample);
  const context = contextAt(windowEvent, browserEvidence);
  const afk = isAfk(eventAt(afkEvents, sample));
  const resolvedGoals = goals.map((goal) => getGoalAt(goal, sample));
  const primaryWinner = pickMatchingPrimaryGoal(
    resolvedGoals.filter((goal) => isGoalTrackingActiveAt(goal, sample)), context, afk
  );
  const noActivity = windowEvent === undefined && browserEvidence === undefined;
  const candidates = goals.map((storedGoal): GoalTrackingDiagnostic => {
    const goal = getGoalAt(storedGoal, sample);
    const primaryMatched = goalMatches(goal, context, "primary");
    const watcherUnavailable = status !== undefined && goal.rules.some((rule) => (
      rule.field === "url" ? !status.browserWatcherAvailable
        : !status.windowWatcherAvailable
    ));
    let reason: TrackingDiagnosticReason;
    if (live.goal?.id === goal.id) reason = "tracking-now";
    else if (!isGoalTrackingActiveAt(storedGoal, sample)) {
      reason = getTrackingStartMs(storedGoal) !== undefined && sample < (getTrackingStartMs(storedGoal) ?? 0)
        ? "not-tracking-yet" : "paused";
    } else if (watcherUnavailable) reason = "watcher-unavailable";
    else if (noActivity) reason = "no-current-activity";
    else if (afk && primaryMatched) reason = "afk-blocked";
    else if (primaryMatched && primaryWinner?.id !== goal.id) reason = "overlap-lost";
    else reason = "primary-mismatch";
    return { goalId: goal.id, primaryMatched, reason };
  });
  const latestBrowser = latestEventAtOrBefore(browserEvents, timestampMs);
  return {
    winnerGoalId: live.goal?.id,
    context,
    afk,
    browserEvidenceAgeSeconds: latestBrowser === undefined
      ? undefined
      : Math.max(0, (timestampMs - latestBrowser.startMs) / 1000),
    candidates
  };
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
