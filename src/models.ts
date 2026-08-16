export type RuleField = "url" | "application" | "windowTitle";
export type MatchOperator = "contains" | "equals";

export interface GoalRule {
  id: string;
  field: RuleField;
  operator: MatchOperator;
  value: string;
}

export interface DailyGoal {
  id: string;
  name: string;
  targetMinutes: number;
  rules: GoalRule[];
  enabled: boolean;
}

export interface DailyHubSettings {
  activityWatchUrl: string;
  afkThresholdSeconds: number;
  refreshIntervalSeconds: number;
  completionNotifications: boolean;
}

export interface DailyHubData {
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
  browserWatcherAvailable: boolean;
  message: string;
}

export const DEFAULT_SETTINGS: DailyHubSettings = {
  activityWatchUrl: "http://localhost:5600",
  afkThresholdSeconds: 60,
  refreshIntervalSeconds: 60,
  completionNotifications: true
};

export const DEFAULT_DATA: DailyHubData = {
  settings: DEFAULT_SETTINGS,
  goals: [],
  notifiedCompletions: []
};

export function createId(): string {
  return globalThis.crypto.randomUUID();
}

export function createEmptyRule(): GoalRule {
  return { id: createId(), field: "url", operator: "contains", value: "" };
}

export function createEmptyGoal(): DailyGoal {
  return {
    id: createId(),
    name: "",
    targetMinutes: 30,
    rules: [createEmptyRule()],
    enabled: true
  };
}
