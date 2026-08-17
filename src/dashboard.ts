import type { DailyGoal, GoalProgress } from "./models";

export interface DailySummary {
  totalActiveSeconds: number;
  completedGoals: number;
  goalCount: number;
}

export function summarizeDay(goals: DailyGoal[], progress: GoalProgress[]): DailySummary {
  const enabledIds = new Set(goals.filter((goal) => goal.enabled).map((goal) => goal.id));
  let totalActiveSeconds = 0;
  let completedGoals = 0;

  for (const item of progress) {
    if (!enabledIds.has(item.goalId)) continue;
    totalActiveSeconds += item.activeSeconds;
    if (item.completed) completedGoals += 1;
  }

  return { totalActiveSeconds, completedGoals, goalCount: enabledIds.size };
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.floor(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainingMinutes === 0) return `${hours} h`;
  return `${hours} h ${remainingMinutes} min`;
}
