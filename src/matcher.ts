import type { ActivityContext, DailyGoal, GoalRule } from "./models";

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

export function goalMatches(goal: DailyGoal, activity: ActivityContext): boolean {
  return goal.enabled && goal.rules.some((rule) => ruleMatches(rule, activity));
}

export function pickMatchingGoal(goals: DailyGoal[], activity: ActivityContext): DailyGoal | undefined {
  let selected: DailyGoal | undefined;
  for (const goal of goals) {
    if (goalMatches(goal, activity) && (selected === undefined || goal.id.localeCompare(selected.id) < 0)) {
      selected = goal;
    }
  }
  return selected;
}
