import {
  DATA_SCHEMA_VERSION,
  DEFAULT_CONTEXT_TIMEOUT_MINUTES,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  WEEKDAYS,
  type DailyGoal,
  type DailyHubData,
  type GoalDayOverride,
  type GoalConfigRevision,
  type GoalRule,
  type GoalRuleRole,
  type GoalSchedule,
  type GoalTrackingPause,
  type MatchOperator,
  type RuleField
} from "./models";
import { configRevisionFromGoal, LEGACY_CONFIG_EFFECTIVE_FROM } from "./goal-config-history";
import { getLocalDateRange } from "./date";
import { isValidTrackingStartedAt } from "./goal-lifecycle";
import { isValidTargetMinutes } from "./schedule";

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

  const rule = {
    id: value.id,
    field: value.field as RuleField,
    operator: value.operator as MatchOperator,
    value: value.value
  };
  const role = value.role === undefined ? "primary" : value.role as GoalRuleRole;
  return role === "primary"
    ? { ...rule, role, countDuringAfk: value.countDuringAfk === true }
    : { ...rule, role };
}

function parseSchedule(value: unknown, targetMinutes: number): GoalSchedule {
  const schedule = isRecord(value) ? value : {};
  return Object.fromEntries(WEEKDAYS.map((weekday) => {
    const day = isRecord(schedule[weekday]) ? schedule[weekday] : {};
    const enabled = typeof day.enabled === "boolean" ? day.enabled : true;
    return [weekday, {
      enabled,
      targetMinutes: isValidTargetMinutes(day.targetMinutes) ? day.targetMinutes : targetMinutes
    }];
  })) as GoalSchedule;
}

function validDateKey(value: string): boolean {
  try {
    return getLocalDateRange(value).key === value;
  } catch {
    return false;
  }
}

function parseOverrides(value: unknown): Record<string, GoalDayOverride> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap<[string, GoalDayOverride]>(([dateKey, candidate]) => {
    if (!validDateKey(dateKey) || !isRecord(candidate)) return [];
    if (candidate.kind === "skip") return [[dateKey, { kind: "skip" } satisfies GoalDayOverride]];
    if (candidate.kind === "target" && isValidTargetMinutes(candidate.targetMinutes)) {
      return [[dateKey, { kind: "target", targetMinutes: candidate.targetMinutes } satisfies GoalDayOverride]];
    }
    return [];
  }));
}

function parseTrackingPauses(value: unknown): GoalTrackingPause[] {
  if (!Array.isArray(value)) return [];
  const pauses = value.flatMap((candidate): GoalTrackingPause[] => {
    if (!isRecord(candidate) || !isValidTrackingStartedAt(candidate.startedAt)) return [];
    if (candidate.endedAt !== undefined && !isValidTrackingStartedAt(candidate.endedAt)) return [];
    const startMs = Date.parse(candidate.startedAt);
    const endMs = candidate.endedAt === undefined ? undefined : Date.parse(candidate.endedAt);
    if (endMs !== undefined && endMs < startMs) return [];
    return [{
      startedAt: new Date(startMs).toISOString(),
      ...(endMs === undefined ? {} : { endedAt: new Date(endMs).toISOString() })
    }];
  }).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));

  const normalized: GoalTrackingPause[] = [];
  for (const pause of pauses) {
    const previous = normalized.at(-1);
    if (previous === undefined) {
      normalized.push(pause);
      continue;
    }
    if (previous.endedAt === undefined) continue;
    if (Date.parse(pause.startedAt) <= Date.parse(previous.endedAt)) {
      if (pause.endedAt === undefined) delete previous.endedAt;
      else if (Date.parse(pause.endedAt) > Date.parse(previous.endedAt)) previous.endedAt = pause.endedAt;
      continue;
    }
    normalized.push(pause);
  }
  return normalized;
}

function parseConfigHistory(value: unknown): GoalConfigRevision[] {
  if (!Array.isArray(value)) return [];
  const revisions = value.flatMap((candidate): GoalConfigRevision[] => {
    if (!isRecord(candidate)
      || !isValidTrackingStartedAt(candidate.effectiveFrom)
      || !isValidTargetMinutes(candidate.targetMinutes)
      || !Array.isArray(candidate.rules)
      || typeof candidate.contextTimeoutMinutes !== "number"
      || !Number.isFinite(candidate.contextTimeoutMinutes)
      || candidate.contextTimeoutMinutes <= 0) return [];
    const rules = candidate.rules.flatMap((rule) => {
      const parsed = parseRule(rule);
      return parsed === undefined ? [] : [parsed];
    });
    if (!rules.some((rule) => rule.role === "primary")) return [];
    return [{
      effectiveFrom: new Date(Date.parse(candidate.effectiveFrom)).toISOString(),
      targetMinutes: candidate.targetMinutes,
      schedule: parseSchedule(candidate.schedule, candidate.targetMinutes),
      rules,
      contextTimeoutMinutes: candidate.contextTimeoutMinutes
    }];
  }).sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom));
  const deduped = new Map(revisions.map((revision) => [revision.effectiveFrom, revision]));
  return [...deduped.values()];
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
  if (!rules.some((rule) => rule.role === "primary")) return undefined;

  const goal: DailyGoal = {
    id: value.id,
    name: value.name,
    targetMinutes: value.targetMinutes,
    schedule: parseSchedule(value.schedule, value.targetMinutes),
    overrides: parseOverrides(value.overrides),
    trackingPauses: parseTrackingPauses(value.trackingPauses),
    ...(typeof value.colorIndex === "number"
      && Number.isInteger(value.colorIndex)
      && value.colorIndex >= 0
      && value.colorIndex < 8
      ? { colorIndex: value.colorIndex }
      : {}),
    ...(isValidTrackingStartedAt(value.trackingStartedAt)
      ? { trackingStartedAt: value.trackingStartedAt }
      : {}),
    enabled: value.enabled,
    rules,
    contextTimeoutMinutes: typeof value.contextTimeoutMinutes === "number"
      && Number.isFinite(value.contextTimeoutMinutes)
      && value.contextTimeoutMinutes > 0
      ? value.contextTimeoutMinutes
      : DEFAULT_CONTEXT_TIMEOUT_MINUTES
  };
  const history = parseConfigHistory(value.configHistory);
  goal.configHistory = history.length > 0
    ? history
    : [configRevisionFromGoal(goal, goal.trackingStartedAt ?? LEGACY_CONFIG_EFFECTIVE_FROM)];
  return goal;
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
