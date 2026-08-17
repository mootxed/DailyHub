import type { DailyGoal, DayActivity, GoalProgress } from "./models";
import { calculateDailyProgress } from "./progress";

export interface DayActivityInput {
  dateKey: string;
  future: boolean;
  activity: DayActivity | undefined;
}

export interface DayProgressResult {
  dateKey: string;
  future: boolean;
  progress: GoalProgress[] | undefined;
}

export function calculateRangeProgress(
  goals: DailyGoal[],
  days: DayActivityInput[]
): DayProgressResult[] {
  return days.map((day) => ({
    dateKey: day.dateKey,
    future: day.future,
    progress: day.future || day.activity === undefined
      ? undefined
      : calculateDailyProgress(goals, day.activity, day.dateKey)
  }));
}
