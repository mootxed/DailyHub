import type {
  ActivityBreakdownItem,
  ComputerActivityRange,
  ComputerActivitySegment,
  DailyComputerActivity
} from "./activity-models";
import { getLocalDateRange, toLocalDateKey } from "./date";
import type {
  ActivityCategory,
  ActivityCategoryRule,
  ActivityEvent,
  DayActivity
} from "./models";

interface TimedEvent {
  event: ActivityEvent;
  startMs: number;
  endMs: number;
}

const BROWSER_GROUPS = [
  ["chrome", "chromium", "googlechrome", "edge", "brave", "vivaldi", "opera"],
  ["firefox", "librewolf", "waterfox", "floorp"],
  ["safari"]
] as const;
const DISPLAY_APPLICATIONS = new Map<string, string>([
  ["googlechrome", "Google Chrome"],
  ["googlechromestable", "Google Chrome"],
  ["chrome", "Chrome"],
  ["chromium", "Chromium"],
  ["firefox", "Firefox"],
  ["mozilla firefox", "Firefox"],
  ["code", "Visual Studio Code"],
  ["visual studio code", "Visual Studio Code"],
  ["kitty", "Kitty"],
  ["obsidian", "Obsidian"],
  ["md.obsidian", "Obsidian"],
  ["org.vinegarhq.sober", "Sober"]
]);
const BUNDLE_PREFIXES = new Set(["app", "com", "dev", "io", "md", "net", "org"]);
const WINDOW_HEARTBEAT_GAP_MS = 15_000;

function stringValue(event: ActivityEvent | undefined, key: string): string | undefined {
  const value = event?.data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseEvents(events: ActivityEvent[], rangeStart: number, rangeEnd: number): TimedEvent[] {
  return events.flatMap((event): TimedEvent[] => {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || !Number.isFinite(event.duration) || event.duration <= 0) return [];
    const startMs = Math.max(timestamp, rangeStart);
    const endMs = Math.min(timestamp + event.duration * 1000, rangeEnd);
    return endMs > startMs ? [{ event, startMs, endMs }] : [];
  }).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function eventAt(events: TimedEvent[], timestamp: number): TimedEvent | undefined {
  let result: TimedEvent | undefined;
  for (const event of events) {
    if (event.startMs > timestamp) break;
    if (event.endMs > timestamp && (result === undefined || event.startMs >= result.startMs)) result = event;
  }
  return result;
}

function hasAfkEvidence(events: TimedEvent[], startMs: number, endMs: number): boolean {
  return events.some((event) => event.startMs < endMs && event.endMs > startMs
    && stringValue(event.event, "status")?.toLocaleLowerCase() === "afk");
}

function bridgeWindowHeartbeatGaps(windows: TimedEvent[], afk: TimedEvent[]): TimedEvent[] {
  const bridged = windows.map((event) => ({ ...event }));
  for (let index = 0; index < bridged.length - 1; index += 1) {
    const current = bridged[index];
    const next = bridged[index + 1];
    if (current === undefined || next === undefined) continue;
    const gap = next.startMs - current.endMs;
    if (gap <= 0 || gap > WINDOW_HEARTBEAT_GAP_MS || hasAfkEvidence(afk, current.endMs, next.startMs)) continue;
    if (stringValue(current.event, "app") !== stringValue(next.event, "app")
      || stringValue(current.event, "title") !== stringValue(next.event, "title")) continue;
    current.endMs = next.startMs;
  }
  return bridged;
}

function browserSource(event: TimedEvent): string | undefined {
  const match = /^aw-watcher-web-([^_]+)/i.exec(event.event.sourceBucketId ?? "");
  return match?.[1]?.toLocaleLowerCase();
}

export function isBrowserApplication(application: string): boolean {
  const identity = normalizeIdentity(application);
  return BROWSER_GROUPS.some((group) => group.some((name) => identity.includes(normalizeIdentity(name))))
    || identity === "browser";
}

function browserMatchesApplication(application: string, browserEvent: TimedEvent): boolean {
  if (!isBrowserApplication(application)) return false;
  const source = browserSource(browserEvent);
  if (source === undefined || source === "unknown") return true;
  const appIdentity = normalizeIdentity(application);
  const sourceIdentity = normalizeIdentity(source);
  if (appIdentity.includes(sourceIdentity) || sourceIdentity.includes(appIdentity)) return true;
  return BROWSER_GROUPS.some((group) => (
    group.some((name) => appIdentity.includes(normalizeIdentity(name)))
      && group.some((name) => sourceIdentity.includes(normalizeIdentity(name)))
  ));
}

function browserEventAt(events: TimedEvent[], timestamp: number, application: string): TimedEvent | undefined {
  let result: TimedEvent | undefined;
  for (const event of events) {
    if (event.startMs > timestamp) break;
    if (event.endMs > timestamp && browserMatchesApplication(application, event)
      && (result === undefined || event.startMs > result.startMs)) result = event;
  }
  return result;
}

export function normalizeDomain(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

export function displayApplicationName(application: string): string {
  const trimmed = application.trim();
  if (trimmed.length === 0) return "Unknown application";
  const direct = DISPLAY_APPLICATIONS.get(trimmed.toLocaleLowerCase());
  if (direct !== undefined) return direct;
  const identity = normalizeIdentity(trimmed);
  const normalized = DISPLAY_APPLICATIONS.get(identity);
  if (normalized !== undefined) return normalized;
  const components = trimmed.split(".").filter((component) => component.length > 0);
  const candidate = components.length > 1 && BUNDLE_PREFIXES.has(components[0]?.toLocaleLowerCase() ?? "")
    ? components.at(-1) ?? trimmed
    : trimmed;
  return candidate.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function ruleMatches(rule: ActivityCategoryRule, segment: ComputerActivitySegment): boolean {
  const candidate = rule.field === "application"
    ? segment.application
    : rule.field === "domain"
      ? segment.domain
      : segment.windowTitle;
  if (candidate === undefined) return false;
  const actual = candidate.trim().toLocaleLowerCase();
  const expected = rule.value.trim().toLocaleLowerCase();
  if (expected.length === 0) return false;
  return rule.operator === "equals" ? actual === expected : actual.includes(expected);
}

export function classifyActivitySegment(
  segment: ComputerActivitySegment,
  categories: ActivityCategory[]
): ActivityCategory | undefined {
  return categories.find((category) => category.rules.some((rule) => ruleMatches(rule, segment)));
}

function sameSegment(left: ComputerActivitySegment, right: ComputerActivitySegment): boolean {
  return left.endMs === right.startMs
    && left.application === right.application
    && left.windowTitle === right.windowTitle
    && left.browser === right.browser
    && left.domain === right.domain
    && left.categoryId === right.categoryId;
}

function mergeAdjacent(segments: ComputerActivitySegment[]): ComputerActivitySegment[] {
  const merged: ComputerActivitySegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous !== undefined && sameSegment(previous, segment)) previous.endMs = segment.endMs;
    else merged.push({ ...segment });
  }
  return merged;
}

function aggregate(
  values: { id: string; label: string; seconds: number }[],
  denominator: number
): ActivityBreakdownItem[] {
  const grouped = new Map<string, { label: string; seconds: number }>();
  for (const value of values) {
    const current = grouped.get(value.id);
    if (current === undefined) grouped.set(value.id, { label: value.label, seconds: value.seconds });
    else current.seconds += value.seconds;
  }
  return [...grouped].map(([id, value]) => ({
    id,
    label: value.label,
    seconds: value.seconds,
    percentage: denominator > 0 ? value.seconds / denominator : 0
  })).sort((left, right) => right.seconds - left.seconds || left.label.localeCompare(right.label));
}

function withDomainBreakdowns(
  applications: ActivityBreakdownItem[],
  segments: ComputerActivitySegment[],
  denominator: number
): ActivityBreakdownItem[] {
  return applications.map((application) => {
    const domains = aggregate(segments.flatMap((segment) => {
      if (segment.application !== application.id || segment.domain === undefined) return [];
      return [{ id: segment.domain, label: segment.domain, seconds: (segment.endMs - segment.startMs) / 1000 }];
    }), denominator);
    return domains.length === 0 ? application : { ...application, domainBreakdown: domains };
  });
}

export function resolveComputerActivityTimeline(
  activity: DayActivity,
  rangeStart: number,
  rangeEnd: number,
  categories: ActivityCategory[] = []
): ComputerActivitySegment[] {
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return [];
  const browsers = parseEvents(activity.browserEvents, rangeStart, rangeEnd);
  const afk = parseEvents(activity.afkEvents, rangeStart, rangeEnd);
  const windows = bridgeWindowHeartbeatGaps(parseEvents(activity.windowEvents, rangeStart, rangeEnd), afk);
  const boundaries = new Set<number>([rangeStart, rangeEnd]);
  for (const event of [...windows, ...browsers, ...afk]) {
    boundaries.add(event.startMs);
    boundaries.add(event.endMs);
  }
  const timeline = [...boundaries].sort((left, right) => left - right);
  const segments: ComputerActivitySegment[] = [];
  for (let index = 0; index < timeline.length - 1; index += 1) {
    const startMs = timeline[index];
    const endMs = timeline[index + 1];
    if (startMs === undefined || endMs === undefined || endMs <= startMs) continue;
    const windowEvent = eventAt(windows, startMs);
    if (windowEvent === undefined) continue;
    const afkEvent = eventAt(afk, startMs);
    if (stringValue(afkEvent?.event, "status")?.toLocaleLowerCase() === "afk") continue;
    const application = stringValue(windowEvent.event, "app") ?? "Unknown application";
    const browserEvent = browserEventAt(browsers, startMs, application);
    const browser = browserEvent === undefined ? undefined : browserSource(browserEvent);
    const domain = browserEvent === undefined ? undefined : normalizeDomain(stringValue(browserEvent.event, "url"));
    const base: ComputerActivitySegment = {
      startMs,
      endMs,
      application,
      displayApplication: displayApplicationName(application),
      ...(stringValue(windowEvent.event, "title") === undefined
        ? {} : { windowTitle: stringValue(windowEvent.event, "title") }),
      ...(browser === undefined ? {} : { browser }),
      ...(domain === undefined ? {} : { domain })
    };
    const category = classifyActivitySegment(base, categories);
    segments.push(category === undefined ? base : { ...base, categoryId: category.id });
  }
  return mergeAdjacent(segments);
}

export function calculateComputerActivity(
  activity: DayActivity,
  date: Date | string,
  categories: ActivityCategory[] = [],
  available = true
): DailyComputerActivity {
  const range = getLocalDateRange(date);
  const segments = available
    ? resolveComputerActivityTimeline(activity, range.start.getTime(), range.end.getTime(), categories)
    : [];
  const activeComputerSeconds = segments.reduce((total, segment) => (
    total + (segment.endMs - segment.startMs) / 1000
  ), 0);
  const applications = aggregate(segments.map((segment) => ({
    id: segment.application,
    label: segment.displayApplication,
    seconds: (segment.endMs - segment.startMs) / 1000
  })), activeComputerSeconds);
  const sites = aggregate(segments.flatMap((segment) => segment.domain === undefined ? [] : [{
    id: segment.domain,
    label: segment.domain,
    seconds: (segment.endMs - segment.startMs) / 1000
  }]), activeComputerSeconds);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const categoryBreakdown = aggregate(segments.map((segment) => {
    const category = segment.categoryId === undefined ? undefined : categoriesById.get(segment.categoryId);
    return {
      id: category?.id ?? "uncategorized",
      label: category?.name ?? "Uncategorized",
      seconds: (segment.endMs - segment.startMs) / 1000
    };
  }), activeComputerSeconds);
  const browserForegroundSeconds = segments.reduce((total, segment) => (
    total + (isBrowserApplication(segment.application) ? (segment.endMs - segment.startMs) / 1000 : 0)
  ), 0);
  return {
    dateKey: range.key,
    available,
    activeComputerSeconds,
    browserForegroundSeconds,
    segments,
    applications: withDomainBreakdowns(applications, segments, activeComputerSeconds),
    sites,
    categories: categoryBreakdown
  };
}

export function calculateComputerActivityRange(days: DailyComputerActivity[]): ComputerActivityRange {
  const available = days.filter((day) => day.available);
  const totalSeconds = available.reduce((total, day) => total + day.activeComputerSeconds, 0);
  const activeDays = available.filter((day) => day.activeComputerSeconds > 0).length;
  const applications = aggregate(available.flatMap((day) => day.applications.map((item) => ({
    id: item.id, label: item.label, seconds: item.seconds
  }))), totalSeconds);
  const categories = aggregate(available.flatMap((day) => day.categories.map((item) => ({
    id: item.id, label: item.label, seconds: item.seconds
  }))), totalSeconds);
  return {
    totalSeconds,
    averageSeconds: available.length === 0 ? undefined : totalSeconds / available.length,
    activeDays,
    availableDays: available.length,
    days,
    applications,
    categories,
    topApplication: applications[0],
    topCategory: categories.find((item) => item.id !== "uncategorized") ?? categories[0]
  };
}

export function activityForUnavailableDate(date: Date | string): DailyComputerActivity {
  const dateKey = toLocalDateKey(getLocalDateRange(date).start);
  return {
    dateKey,
    available: false,
    activeComputerSeconds: 0,
    browserForegroundSeconds: 0,
    segments: [],
    applications: [],
    sites: [],
    categories: []
  };
}
