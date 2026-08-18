import type { DailyGoal, GoalProgress } from "./models";
import { hasGoalTrackingStartedByDate } from "./goal-lifecycle";
import {
  applyScheduleToProgress,
  getEffectiveGoalDay,
  type EffectiveGoalDaySource,
  type PlannedGoalProgress
} from "./schedule";

export interface DailySummary {
  totalActiveSeconds: number;
  completedGoals: number;
  trackedGoalCount: number;
  goalCount: number;
}

export interface DayPlanGoal extends PlannedGoalProgress {
  name: string;
  remainingSeconds: number;
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
  trackingStarted: boolean;
  scheduled: boolean;
  skipped: boolean;
  targetMinutes: number;
  source: EffectiveGoalDaySource;
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

export function summarizeDay(
  goals: DailyGoal[],
  progress: GoalProgress[],
  dateKey: string
): DailySummary {
  const enabledIds = new Set(goals.filter((goal) => goal.enabled).map((goal) => goal.id));
  const planned = applyScheduleToProgress(goals, progress, dateKey);
  return {
    totalActiveSeconds: planned.reduce(
      (total, item) => total + (enabledIds.has(item.goalId) ? item.activeSeconds : 0),
      0
    ),
    completedGoals: planned.filter((item) => item.scheduled && item.completed).length,
    trackedGoalCount: planned.filter((item) => enabledIds.has(item.goalId) && item.trackingStarted).length,
    goalCount: planned.filter((item) => item.scheduled).length
  };
}

export function getDayPlan(
  goals: DailyGoal[],
  progress: GoalProgress[],
  dateKey: string
): DayPlanGoal[] {
  const names = new Map(goals.map((goal) => [goal.id, goal.name]));
  return applyScheduleToProgress(goals, progress, dateKey).flatMap((item) => (
    item.scheduled
      ? [{
        ...item,
        name: names.get(item.goalId) ?? item.goalId,
        remainingSeconds: Math.max(item.targetMinutes * 60 - item.activeSeconds, 0)
      }]
      : []
  ));
}

export function getRemainingGoals(
  goals: DailyGoal[],
  progress: GoalProgress[],
  dateKey: string
): RemainingGoal[] {
  return getDayPlan(goals, progress, dateKey).flatMap((item) => (
    item.remainingSeconds > 0
      ? [{ goalId: item.goalId, name: item.name, remainingSeconds: item.remainingSeconds }]
      : []
  ));
}

export function getTotalRemainingSeconds(
  goals: DailyGoal[],
  progress: GoalProgress[],
  dateKey: string
): number {
  return getDayPlan(goals, progress, dateKey)
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
    const effective = getEffectiveGoalDay(goal, day.dateKey);
    const raw = day.progress?.find((progress) => progress.goalId === goal.id);
    const available = effective.trackingStarted && !day.future && day.progress !== undefined;
    const activeSeconds = available ? raw?.activeSeconds ?? 0 : undefined;
    const completed = available && effective.scheduled
      ? (activeSeconds ?? 0) >= effective.targetMinutes * 60
      : undefined;
    if (available) totalSeconds += activeSeconds ?? 0;
    if (available && effective.scheduled) {
      trackedDays += 1;
      if (completed === true) completedDays += 1;
    }
    return {
      dateKey: day.dateKey,
      future: day.future,
      available,
      ...effective,
      activeSeconds,
      completed
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
    const trackedGoals = enabledGoals.filter((goal) => hasGoalTrackingStartedByDate(goal, day.dateKey));
    if (trackedGoals.length === 0) continue;
    elapsedDays += 1;
    if (day.progress === undefined) {
      unavailableDays += 1;
      continue;
    }
    const summary = summarizeDay(trackedGoals, day.progress, day.dateKey);
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

export interface DashboardPresentationState {
  hasGoals: boolean;
  defaultActivityChartMode: "goals" | "apps" | "sites";
  defaultHeatmapMode: "completion" | "activity";
  showGoalAnalytics: boolean;
}

export function getDashboardPresentationState(
  enabledGoalCount: number,
  hasSiteActivity = false
): DashboardPresentationState {
  const hasGoals = enabledGoalCount > 0;
  return {
    hasGoals,
    defaultActivityChartMode: hasGoals ? "goals" : hasSiteActivity ? "sites" : "apps",
    defaultHeatmapMode: hasGoals ? "completion" : "activity",
    showGoalAnalytics: hasGoals
  };
}
