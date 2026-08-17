import { summarizeWeek, type GoalWeekStats, type WeekDayProgress } from "./dashboard";
import type { DailyGoal } from "./models";
import {
  calculateRangeProgress,
  type DayActivityInput
} from "./range-progress";

export type WeekDayActivity = DayActivityInput;

export function calculateWeekProgress(
  goals: DailyGoal[],
  days: WeekDayActivity[]
): WeekDayProgress[] {
  return calculateRangeProgress(goals, days);
}

export function calculateGoalWeekStats(
  goals: DailyGoal[],
  goalId: string,
  days: WeekDayActivity[],
  selectedDateKey: string
): GoalWeekStats | undefined {
  return summarizeWeek(
    goals,
    calculateWeekProgress(goals, days),
    selectedDateKey
  ).goals.find((goal) => goal.goalId === goalId);
}
