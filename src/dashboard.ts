import type { DailyGoal, GoalProgress } from "./models";

export interface DailySummary {
  totalActiveSeconds: number;
  completedGoals: number;
  goalCount: number;
}

export interface RemainingGoal {
  goalId: string;
  name: string;
  remainingSeconds: number;
}

export interface WeekDayProgress {
  dateKey: string;
  future: boolean;
  progress: GoalProgress[] | undefined;
}

export interface GoalDayStats {
  dateKey: string;
  future: boolean;
  available: boolean;
  activeSeconds: number | undefined;
  completed: boolean | undefined;
}

export interface GoalWeekStats {
  goalId: string;
  goalName: string;
  targetMinutes: number;
  totalSeconds: number;
  completedDays: number;
  trackedDays: number;
  selectedDay: GoalDayStats | undefined;
  days: GoalDayStats[];
}

export interface WeeklyAnalytics {
  totalActiveSeconds: number;
  dailyAverageSeconds: number | undefined;
  completedGoals: number;
  goalOpportunities: number;
  elapsedDays: number;
  unavailableDays: number;
  goals: GoalWeekStats[];
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

export function getRemainingGoals(goals: DailyGoal[], progress: GoalProgress[]): RemainingGoal[] {
  const progressByGoal = new Map(progress.map((item) => [item.goalId, item]));
  return goals.flatMap((goal) => {
    if (!goal.enabled) return [];
    const activeSeconds = progressByGoal.get(goal.id)?.activeSeconds ?? 0;
    const remainingSeconds = Math.max(goal.targetMinutes * 60 - activeSeconds, 0);
    return remainingSeconds > 0 ? [{ goalId: goal.id, name: goal.name, remainingSeconds }] : [];
  });
}

export function getTotalRemainingSeconds(goals: DailyGoal[], progress: GoalProgress[]): number {
  return getRemainingGoals(goals, progress)
    .reduce((total, goal) => total + goal.remainingSeconds, 0);
}

function buildGoalWeekStats(
  goal: DailyGoal,
  days: WeekDayProgress[],
  selectedDateKey: string
): GoalWeekStats {
  let totalSeconds = 0;
  let completedDays = 0;
  let trackedDays = 0;
  const goalDays = days.map((day): GoalDayStats => {
    const item = day.progress?.find((progress) => progress.goalId === goal.id);
    const available = !day.future && day.progress !== undefined;
    if (available) {
      trackedDays += 1;
      totalSeconds += item?.activeSeconds ?? 0;
      if (item?.completed === true) completedDays += 1;
    }
    return {
      dateKey: day.dateKey,
      future: day.future,
      available,
      activeSeconds: available ? item?.activeSeconds ?? 0 : undefined,
      completed: available ? item?.completed ?? false : undefined
    };
  });
  return {
    goalId: goal.id,
    goalName: goal.name,
    targetMinutes: goal.targetMinutes,
    totalSeconds,
    completedDays,
    trackedDays,
    selectedDay: goalDays.find((day) => day.dateKey === selectedDateKey),
    days: goalDays
  };
}

export function summarizeWeek(
  goals: DailyGoal[],
  days: WeekDayProgress[],
  selectedDateKey: string
): WeeklyAnalytics {
  const enabledGoals = goals.filter((goal) => goal.enabled);
  let totalActiveSeconds = 0;
  let completedGoals = 0;
  let goalOpportunities = 0;
  let elapsedDays = 0;
  let unavailableDays = 0;

  for (const day of days) {
    if (day.future) continue;
    elapsedDays += 1;
    if (day.progress === undefined) {
      unavailableDays += 1;
      continue;
    }
    const summary = summarizeDay(enabledGoals, day.progress);
    totalActiveSeconds += summary.totalActiveSeconds;
    completedGoals += summary.completedGoals;
    goalOpportunities += summary.goalCount;
  }

  const goalStats = enabledGoals.map((goal) => buildGoalWeekStats(goal, days, selectedDateKey));
  goalStats.sort((left, right) => (
    right.totalSeconds - left.totalSeconds
    || left.goalName.localeCompare(right.goalName)
    || left.goalId.localeCompare(right.goalId)
  ));

  return {
    totalActiveSeconds,
    dailyAverageSeconds: elapsedDays > 0 && unavailableDays === 0
      ? totalActiveSeconds / elapsedDays
      : undefined,
    completedGoals,
    goalOpportunities,
    elapsedDays,
    unavailableDays,
    goals: goalStats
  };
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.floor(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainingMinutes === 0) return `${hours} h`;
  return `${hours} h ${remainingMinutes} min`;
}

export function formatRemainingDuration(totalSeconds: number): string {
  return formatDuration(Math.ceil(Math.max(0, totalSeconds) / 60) * 60);
}
