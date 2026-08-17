import type { DailyGoal, GoalProgress } from "./models";
import type { DayProgressResult } from "./range-progress";

export interface DayAnalytics {
  dateKey: string;
  available: boolean;
  totalSeconds: number | undefined;
  completedGoals: number | undefined;
  goalCount: number | undefined;
  progressRatio: number | undefined;
}

export interface GoalRangeStats {
  goalId: string;
  goalName: string;
  targetMinutes: number;
  totalSeconds: number;
  completedDays: number;
  availableDays: number;
  currentStreak: number;
  bestStreak: number;
  completionRate: number | undefined;
  streakMayBeIncomplete: boolean;
}

export interface RangeAnalytics {
  totalSeconds: number;
  averageSeconds: number | undefined;
  activeDays: number;
  availableDays: number;
  completedGoals: number;
  goalOpportunities: number;
  completionRate: number | undefined;
  goals: GoalRangeStats[];
  days: DayAnalytics[];
}

interface GoalDay {
  available: boolean;
  completed: boolean;
  activeSeconds: number;
}

function enabledProgress(
  progress: GoalProgress[],
  enabledIds: Set<string>
): GoalProgress[] {
  return progress.filter((item) => enabledIds.has(item.goalId));
}

function dayAnalytics(day: DayProgressResult, enabledIds: Set<string>): DayAnalytics {
  if (day.future || day.progress === undefined) {
    return {
      dateKey: day.dateKey,
      available: false,
      totalSeconds: undefined,
      completedGoals: undefined,
      goalCount: undefined,
      progressRatio: undefined
    };
  }

  const progress = enabledProgress(day.progress, enabledIds);
  const totalSeconds = progress.reduce((total, item) => total + item.activeSeconds, 0);
  const completedGoals = progress.filter((item) => item.completed).length;
  const goalCount = enabledIds.size;
  return {
    dateKey: day.dateKey,
    available: true,
    totalSeconds,
    completedGoals,
    goalCount,
    progressRatio: goalCount === 0
      ? undefined
      : progress.reduce((total, item) => total + Math.min(Math.max(item.progressRatio, 0), 1), 0) / goalCount
  };
}

function goalDays(goalId: string, days: DayProgressResult[]): GoalDay[] {
  return days.map((day) => {
    if (day.future || day.progress === undefined) {
      return { available: false, completed: false, activeSeconds: 0 };
    }
    const progress = day.progress.find((item) => item.goalId === goalId);
    return {
      available: true,
      completed: progress?.completed === true,
      activeSeconds: progress?.activeSeconds ?? 0
    };
  });
}

function bestStreak(days: GoalDay[]): number {
  let best = 0;
  let current = 0;
  for (const day of days) {
    current = day.available && day.completed ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

function currentStreak(days: GoalDay[]): number {
  if (days.length === 0) return 0;
  let index = days.length - 1;
  const today = days[index];
  if (!today?.available) return 0;
  if (!today.completed) index -= 1;

  let streak = 0;
  while (index >= 0) {
    const day = days[index];
    if (day === undefined || !day.available || !day.completed) break;
    streak += 1;
    index -= 1;
  }
  return streak;
}

function buildGoalStats(goal: DailyGoal, days: DayProgressResult[]): GoalRangeStats {
  const tracked = goalDays(goal.id, days);
  const availableDays = tracked.filter((day) => day.available).length;
  const completedDays = tracked.filter((day) => day.available && day.completed).length;
  return {
    goalId: goal.id,
    goalName: goal.name,
    targetMinutes: goal.targetMinutes,
    totalSeconds: tracked.reduce((total, day) => total + day.activeSeconds, 0),
    completedDays,
    availableDays,
    currentStreak: currentStreak(tracked),
    bestStreak: bestStreak(tracked),
    completionRate: availableDays === 0 ? undefined : completedDays / availableDays,
    streakMayBeIncomplete: tracked.some((day) => !day.available)
  };
}

export function getHeatmapLevel(progressRatio: number): number {
  const ratio = Math.min(Math.max(progressRatio, 0), 1);
  if (ratio === 0) return 0;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  if (ratio < 1) return 4;
  return 5;
}

export function calculateRangeAnalytics(
  goals: DailyGoal[],
  progressDays: DayProgressResult[]
): RangeAnalytics {
  const enabledGoals = goals.filter((goal) => goal.enabled);
  const enabledIds = new Set(enabledGoals.map((goal) => goal.id));
  const days = progressDays.map((day) => dayAnalytics(day, enabledIds));
  const available = days.filter((day) => day.available);
  const totalSeconds = available.reduce((total, day) => total + (day.totalSeconds ?? 0), 0);
  const completedGoals = available.reduce((total, day) => total + (day.completedGoals ?? 0), 0);
  const goalOpportunities = available.reduce((total, day) => total + (day.goalCount ?? 0), 0);

  return {
    totalSeconds,
    averageSeconds: available.length === 0 ? undefined : totalSeconds / available.length,
    activeDays: available.filter((day) => (day.totalSeconds ?? 0) > 0).length,
    availableDays: available.length,
    completedGoals,
    goalOpportunities,
    completionRate: goalOpportunities === 0 ? undefined : completedGoals / goalOpportunities,
    goals: enabledGoals.map((goal) => buildGoalStats(goal, progressDays)),
    days
  };
}
