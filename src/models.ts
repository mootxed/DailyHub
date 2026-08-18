export type RuleField = "url" | "application" | "windowTitle";
export type MatchOperator = "contains" | "equals";
export type GoalRuleRole = "primary" | "continuation";

interface GoalRuleBase {
  id: string;
  field: RuleField;
  operator: MatchOperator;
  value: string;
}

export interface PrimaryGoalRule extends GoalRuleBase {
  role: "primary";
  countDuringAfk: boolean;
}

export interface ContinuationGoalRule extends GoalRuleBase {
  role: "continuation";
}

export type GoalRule = PrimaryGoalRule | ContinuationGoalRule;

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
] as const;

export type Weekday = typeof WEEKDAYS[number];

export interface GoalScheduleDay {
  enabled: boolean;
  targetMinutes: number;
}

export type GoalSchedule = Record<Weekday, GoalScheduleDay>;

export type GoalDayOverride =
  | { kind: "target"; targetMinutes: number }
  | { kind: "skip" };

export interface GoalTrackingPause {
  startedAt: string;
  endedAt?: string;
}

export interface GoalConfigRevision {
  effectiveFrom: string;
  targetMinutes: number;
  schedule: GoalSchedule;
  rules: GoalRule[];
  contextTimeoutMinutes: number;
}

export interface DailyGoal {
  id: string;
  name: string;
  targetMinutes: number;
  /** Present on normalized data; optional here so legacy in-memory goals remain adaptable. */
  schedule?: GoalSchedule;
  overrides?: Record<string, GoalDayOverride>;
  /** Missing on legacy goals whose original tracking start is unknown. */
  trackingStartedAt?: string;
  /** Persisted intervals during which matching activity must not be counted. */
  trackingPauses?: GoalTrackingPause[];
  /** Curated identity color. Undefined keeps the stable id-derived fallback. */
  colorIndex?: number;
  /** Tracking-sensitive configuration ordered by effectiveFrom. */
  configHistory?: GoalConfigRevision[];
  rules: GoalRule[];
  contextTimeoutMinutes: number;
  enabled: boolean;
}

export interface DailyHubSettings {
  activityWatchUrl: string;
  refreshIntervalSeconds: number;
  completionNotifications: boolean;
}

export interface DailyHubData {
  schemaVersion: number;
  settings: DailyHubSettings;
  goals: DailyGoal[];
  notifiedCompletions: string[];
}

export interface ActivityContext {
  application?: string;
  windowTitle?: string;
  url?: string;
}

export interface ActivityEvent {
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
  sourceBucketId?: string;
}

export interface DayActivity {
  windowEvents: ActivityEvent[];
  browserEvents: ActivityEvent[];
  afkEvents: ActivityEvent[];
}

export interface GoalProgress {
  goalId: string;
  activeSeconds: number;
  actualMinutes: number;
  targetMinutes: number;
  completed: boolean;
  progressRatio: number;
}

export type ActivityWatchStatusKind = "connected" | "offline";

export interface ActivityWatchStatus {
  kind: ActivityWatchStatusKind;
  windowWatcherAvailable: boolean;
  browserWatcherAvailable: boolean;
  afkWatcherAvailable: boolean;
  message: string;
}

export interface ActivityWatchSnapshot {
  status: ActivityWatchStatus;
  activity: DayActivity;
}

export const DATA_SCHEMA_VERSION = 8;
export const DEFAULT_CONTEXT_TIMEOUT_MINUTES = 10;

export const DEFAULT_SETTINGS: DailyHubSettings = {
  activityWatchUrl: "http://localhost:5600",
  refreshIntervalSeconds: 60,
  completionNotifications: true
};

export const DEFAULT_DATA: DailyHubData = {
  schemaVersion: DATA_SCHEMA_VERSION,
  settings: DEFAULT_SETTINGS,
  goals: [],
  notifiedCompletions: []
};

export function createId(): string {
  return globalThis.crypto.randomUUID();
}

export function createEmptyRule(role: GoalRuleRole = "primary"): GoalRule {
  const rule = {
    id: createId(),
    field: role === "primary" ? "url" as const : "application" as const,
    operator: "contains" as const,
    value: ""
  };
  return role === "primary"
    ? { ...rule, role, countDuringAfk: false }
    : { ...rule, role };
}

export function updateGoalEnabled(goals: DailyGoal[], goalId: string, enabled: boolean): boolean {
  const goal = goals.find((candidate) => candidate.id === goalId);
  if (goal === undefined) return false;
  goal.enabled = enabled;
  return true;
}

export function deleteGoalData(data: DailyHubData, goalId: string): boolean {
  if (!data.goals.some((goal) => goal.id === goalId)) return false;
  data.goals = data.goals.filter((goal) => goal.id !== goalId);
  data.notifiedCompletions = data.notifiedCompletions.filter((key) => !key.endsWith(`:${goalId}`));
  return true;
}

export function createDefaultSchedule(targetMinutes: number): GoalSchedule {
  return Object.fromEntries(WEEKDAYS.map((weekday) => [
    weekday,
    { enabled: true, targetMinutes }
  ])) as GoalSchedule;
}

export function createEmptyGoal(): DailyGoal {
  return {
    id: createId(),
    name: "",
    targetMinutes: 30,
    schedule: createDefaultSchedule(30),
    overrides: {},
    trackingPauses: [],
    rules: [createEmptyRule()],
    contextTimeoutMinutes: DEFAULT_CONTEXT_TIMEOUT_MINUTES,
    enabled: true
  };
}
