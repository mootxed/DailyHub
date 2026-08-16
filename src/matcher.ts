import type { ActivityContext, DailyGoal, GoalRule, GoalRuleRole } from "./models";

const fieldValues: Record<GoalRule["field"], (activity: ActivityContext) => string | undefined> = {
  url: (activity) => activity.url,
  application: (activity) => activity.application,
  windowTitle: (activity) => activity.windowTitle
};

export function ruleMatches(rule: GoalRule, activity: ActivityContext): boolean {
  const candidate = fieldValues[rule.field](activity)?.trim().toLocaleLowerCase();
  const expected = rule.value.trim().toLocaleLowerCase();
  if (candidate === undefined || expected.length === 0) return false;

  return rule.operator === "equals" ? candidate === expected : candidate.includes(expected);
}

export function goalMatches(
  goal: DailyGoal,
  activity: ActivityContext,
  role: GoalRuleRole = "primary"
): boolean {
  return goal.enabled && goal.rules.some((rule) => rule.role === role && ruleMatches(rule, activity));
}

export function pickMatchingGoal(
  goals: DailyGoal[],
  activity: ActivityContext,
  role: GoalRuleRole = "primary"
): DailyGoal | undefined {
  let selected: DailyGoal | undefined;
  for (const goal of goals) {
    if (goalMatches(goal, activity, role)
      && (selected === undefined || goal.id.localeCompare(selected.id) < 0)) {
      selected = goal;
    }
  }
  return selected;
}

export function pickMatchingPrimaryGoal(
  goals: DailyGoal[],
  activity: ActivityContext,
  duringAfk: boolean
): DailyGoal | undefined {
  let selected: DailyGoal | undefined;
  for (const goal of goals) {
    const matches = goal.enabled && goal.rules.some((rule) => rule.role === "primary"
      && (!duringAfk || rule.countDuringAfk)
      && ruleMatches(rule, activity));
    if (matches && (selected === undefined || goal.id.localeCompare(selected.id) < 0)) {
      selected = goal;
    }
  }
  return selected;
}
