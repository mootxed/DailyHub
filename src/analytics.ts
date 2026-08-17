import type { DailyGoal } from "./models";
import type { DayProgressResult } from "./range-progress";
import { applyScheduleToProgress, getEffectiveGoalDay } from "./schedule";

export interface DayAnalytics {
  dateKey: string;
  available: boolean;
  totalSeconds: number | undefined;
  completedGoals: number | undefined;
  goalCount: number;
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
  scheduled: boolean;
  available: boolean;
  completed: boolean;
  activeSeconds: number;
}

function dayAnalytics(day: DayProgressResult, goals: DailyGoal[]): DayAnalytics {
  const scheduledGoals = goals.filter((goal) => getEffectiveGoalDay(goal, day.dateKey).scheduled).length;
  if (day.future || day.progress === undefined) {
    return {
      dateKey: day.dateKey,
      available: false,
      totalSeconds: undefined,
      completedGoals: undefined,
      goalCount: scheduledGoals,
      progressRatio: undefined
    };
  }

  const planned = applyScheduleToProgress(goals, day.progress, day.dateKey);
  const totalSeconds = planned.reduce((total, item) => total + item.activeSeconds, 0);
  const scheduled = planned.filter((item) => item.scheduled);
  const completedGoals = scheduled.filter((item) => item.completed).length;
  return {
    dateKey: day.dateKey,
    available: true,
    totalSeconds,
    completedGoals,
    goalCount: scheduled.length,
    progressRatio: scheduled.length === 0
      ? undefined
      : scheduled.reduce(
        (total, item) => total + Math.min(Math.max(item.progressRatio ?? 0, 0), 1),
        0
      ) / scheduled.length
  };
}

function goalDays(goal: DailyGoal, days: DayProgressResult[]): GoalDay[] {
  return days.map((day) => {
    const effective = getEffectiveGoalDay(goal, day.dateKey);
    const raw = day.progress?.find((item) => item.goalId === goal.id);
    const available = !day.future && day.progress !== undefined;
    const activeSeconds = available ? raw?.activeSeconds ?? 0 : 0;
    return {
      scheduled: effective.scheduled,
      available,
      completed: effective.scheduled && available && activeSeconds >= effective.targetMinutes * 60,
      activeSeconds
    };
  });
}

function bestStreak(days: GoalDay[]): number {
  let best = 0;
  let current = 0;
  for (const day of days) {
    if (!day.scheduled) continue;
    current = day.available && day.completed ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

function currentStreak(days: GoalDay[]): number {
  let index = days.length - 1;
  while (index >= 0 && days[index]?.scheduled === false) index -= 1;
  if (index < 0) return 0;

  const last = days[index];
  if (!last?.available) return 0;
  if (!last.completed) {
    if (index !== days.length - 1) return 0;
    index -= 1;
  }

  let streak = 0;
  while (index >= 0) {
    const day = days[index];
    if (day === undefined) break;
    index -= 1;
    if (!day.scheduled) continue;
    if (!day.available || !day.completed) break;
    streak += 1;
  }
  return streak;
}

function buildGoalStats(goal: DailyGoal, days: DayProgressResult[]): GoalRangeStats {
  const tracked = goalDays(goal, days);
  const opportunities = tracked.filter((day) => day.scheduled && day.available);
  const completedDays = opportunities.filter((day) => day.completed).length;
  return {
    goalId: goal.id,
    goalName: goal.name,
    targetMinutes: goal.targetMinutes,
    totalSeconds: tracked.reduce((total, day) => total + day.activeSeconds, 0),
    completedDays,
    availableDays: opportunities.length,
    currentStreak: currentStreak(tracked),
    bestStreak: bestStreak(tracked),
    completionRate: opportunities.length === 0 ? undefined : completedDays / opportunities.length,
    streakMayBeIncomplete: tracked.some((day) => day.scheduled && !day.available)
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
  const days = progressDays.map((day) => dayAnalytics(day, enabledGoals));
  const available = days.filter((day) => day.available);
  const totalSeconds = available.reduce((total, day) => total + (day.totalSeconds ?? 0), 0);
  const completedGoals = available.reduce((total, day) => total + (day.completedGoals ?? 0), 0);
  const goalOpportunities = available.reduce((total, day) => total + day.goalCount, 0);

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
