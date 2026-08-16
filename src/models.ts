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

export interface DailyGoal {
  id: string;
  name: string;
  targetMinutes: number;
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

export const DATA_SCHEMA_VERSION = 4;
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
  const rule = { id: createId(), field: "url" as const, operator: "contains" as const, value: "" };
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

export function createEmptyGoal(): DailyGoal {
  return {
    id: createId(),
    name: "",
    targetMinutes: 30,
    rules: [createEmptyRule()],
    contextTimeoutMinutes: DEFAULT_CONTEXT_TIMEOUT_MINUTES,
    enabled: true
  };
}
