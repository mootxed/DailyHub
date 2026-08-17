import { summarizeWeek, type GoalWeekStats, type WeekDayProgress } from "./dashboard";
import type { DailyGoal, DayActivity } from "./models";
import { calculateDailyProgress } from "./progress";

export interface WeekDayActivity {
  dateKey: string;
  future: boolean;
  activity: DayActivity | undefined;
}

export function calculateWeekProgress(
  goals: DailyGoal[],
  days: WeekDayActivity[]
): WeekDayProgress[] {
  return days.map((day) => ({
    dateKey: day.dateKey,
    future: day.future,
    progress: day.future || day.activity === undefined
      ? undefined
      : calculateDailyProgress(goals, day.activity, day.dateKey)
  }));
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
