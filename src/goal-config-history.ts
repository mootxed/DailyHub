import { createDefaultSchedule, WEEKDAYS, type DailyGoal, type GoalConfigRevision, type GoalRule, type GoalSchedule } from "./models";

export const LEGACY_CONFIG_EFFECTIVE_FROM = "1970-01-01T00:00:00.000Z";

function cloneSchedule(schedule: GoalSchedule): GoalSchedule {
  return Object.fromEntries(WEEKDAYS.map((weekday) => [weekday, { ...schedule[weekday] }])) as GoalSchedule;
}

function cloneRules(rules: GoalRule[]): GoalRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function configRevisionFromGoal(goal: DailyGoal, effectiveFrom: string): GoalConfigRevision {
  return {
    effectiveFrom: new Date(effectiveFrom).toISOString(),
    targetMinutes: goal.targetMinutes,
    schedule: cloneSchedule(goal.schedule ?? createDefaultSchedule(goal.targetMinutes)),
    rules: cloneRules(goal.rules),
    contextTimeoutMinutes: goal.contextTimeoutMinutes
  };
}

export function cloneConfigRevision(revision: GoalConfigRevision): GoalConfigRevision {
  return {
    ...revision,
    schedule: cloneSchedule(revision.schedule),
    rules: cloneRules(revision.rules)
  };
}

export function getGoalConfigAt(goal: DailyGoal, timestampMs: number): GoalConfigRevision {
  const history = goal.configHistory ?? [];
  let resolved: GoalConfigRevision | undefined;
  for (const revision of history) {
    if (Date.parse(revision.effectiveFrom) <= timestampMs) resolved = revision;
    else break;
  }
  return resolved === undefined
    ? configRevisionFromGoal(goal, goal.trackingStartedAt ?? LEGACY_CONFIG_EFFECTIVE_FROM)
    : cloneConfigRevision(resolved);
}

export function getGoalAt(goal: DailyGoal, timestampMs: number): DailyGoal {
  const config = getGoalConfigAt(goal, timestampMs);
  return {
    ...goal,
    targetMinutes: config.targetMinutes,
    schedule: config.schedule,
    rules: config.rules,
    contextTimeoutMinutes: config.contextTimeoutMinutes
  };
}

function comparableConfig(goal: DailyGoal): Omit<GoalConfigRevision, "effectiveFrom"> {
  const revision = configRevisionFromGoal(goal, LEGACY_CONFIG_EFFECTIVE_FROM);
  return {
    targetMinutes: revision.targetMinutes,
    schedule: revision.schedule,
    rules: revision.rules,
    contextTimeoutMinutes: revision.contextTimeoutMinutes
  };
}

export function hasTrackingConfigChanged(previous: DailyGoal, next: DailyGoal): boolean {
  return JSON.stringify(comparableConfig(previous)) !== JSON.stringify(comparableConfig(next));
}

export function withRecordedConfigRevision(
  previous: DailyGoal,
  next: DailyGoal,
  effectiveAt: Date | number | string = new Date()
): DailyGoal {
  if (!hasTrackingConfigChanged(previous, next)) {
    return { ...next, configHistory: structuredClone(previous.configHistory ?? []) };
  }
  const timestamp = effectiveAt instanceof Date ? effectiveAt.getTime()
    : typeof effectiveAt === "number" ? effectiveAt
    : Date.parse(effectiveAt);
  if (!Number.isFinite(timestamp)) return next;
  const revision = configRevisionFromGoal(next, new Date(timestamp).toISOString());
  const history = (previous.configHistory ?? [
    configRevisionFromGoal(previous, previous.trackingStartedAt ?? LEGACY_CONFIG_EFFECTIVE_FROM)
  ]).map(cloneConfigRevision);
  const withoutSameTimestamp = history.filter((item) => item.effectiveFrom !== revision.effectiveFrom);
  return {
    ...next,
    configHistory: [...withoutSameTimestamp, revision]
      .sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
  };
}

export function getConfigRevisionBoundaries(goal: DailyGoal, rangeStart: number, rangeEnd: number): number[] {
  return (goal.configHistory ?? [])
    .map((revision) => Date.parse(revision.effectiveFrom))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > rangeStart && timestamp < rangeEnd);
}
