import {
  DATA_SCHEMA_VERSION,
  DEFAULT_CONTEXT_TIMEOUT_MINUTES,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  type DailyGoal,
  type DailyHubData,
  type GoalRule,
  type GoalRuleRole,
  type MatchOperator,
  type RuleField
} from "./models";

const RULE_FIELDS = new Set<RuleField>(["url", "application", "windowTitle"]);
const MATCH_OPERATORS = new Set<MatchOperator>(["contains", "equals"]);
const RULE_ROLES = new Set<GoalRuleRole>(["primary", "continuation"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRule(value: unknown): GoalRule | undefined {
  if (!isRecord(value)
    || !nonEmptyString(value.id)
    || (value.role !== undefined && !RULE_ROLES.has(value.role as GoalRuleRole))
    || !RULE_FIELDS.has(value.field as RuleField)
    || !MATCH_OPERATORS.has(value.operator as MatchOperator)
    || !nonEmptyString(value.value)) {
    return undefined;
  }

  return {
    id: value.id,
    role: value.role === undefined ? "primary" : value.role as GoalRuleRole,
    field: value.field as RuleField,
    operator: value.operator as MatchOperator,
    value: value.value
  };
}

function parseGoal(value: unknown): DailyGoal | undefined {
  if (!isRecord(value)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.name)
    || typeof value.targetMinutes !== "number"
    || !Number.isFinite(value.targetMinutes)
    || value.targetMinutes <= 0
    || typeof value.enabled !== "boolean"
    || !Array.isArray(value.rules)) {
    return undefined;
  }

  const rules = value.rules.flatMap((rule) => {
    const parsed = parseRule(rule);
    return parsed === undefined ? [] : [parsed];
  });
  if (rules.length === 0) return undefined;

  return {
    id: value.id,
    name: value.name,
    targetMinutes: value.targetMinutes,
    enabled: value.enabled,
    rules,
    contextTimeoutMinutes: typeof value.contextTimeoutMinutes === "number"
      && Number.isFinite(value.contextTimeoutMinutes)
      && value.contextTimeoutMinutes > 0
      ? value.contextTimeoutMinutes
      : DEFAULT_CONTEXT_TIMEOUT_MINUTES
  };
}

function parseGoals(value: unknown): DailyGoal[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((candidate) => {
    const goal = parseGoal(candidate);
    if (goal === undefined || ids.has(goal.id)) return [];
    ids.add(goal.id);
    return [goal];
  });
}

export function normalizeData(value: unknown): DailyHubData {
  if (!isRecord(value)) return structuredClone(DEFAULT_DATA);
  const settings = isRecord(value.settings) ? value.settings : {};
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    settings: {
      activityWatchUrl: nonEmptyString(settings.activityWatchUrl)
        ? settings.activityWatchUrl
        : DEFAULT_SETTINGS.activityWatchUrl,
      refreshIntervalSeconds: typeof settings.refreshIntervalSeconds === "number"
        && Number.isFinite(settings.refreshIntervalSeconds)
        && settings.refreshIntervalSeconds >= 10
        ? settings.refreshIntervalSeconds
        : DEFAULT_SETTINGS.refreshIntervalSeconds,
      completionNotifications: typeof settings.completionNotifications === "boolean"
        ? settings.completionNotifications
        : DEFAULT_SETTINGS.completionNotifications
    },
    goals: parseGoals(value.goals),
    notifiedCompletions: Array.isArray(value.notifiedCompletions)
      ? value.notifiedCompletions.filter((item): item is string => typeof item === "string")
      : []
  };
}

export function requiresDataMigration(value: unknown): boolean {
  return !isRecord(value)
    || value.schemaVersion !== DATA_SCHEMA_VERSION
    || (isRecord(value.settings) && "afkThresholdSeconds" in value.settings);
}
