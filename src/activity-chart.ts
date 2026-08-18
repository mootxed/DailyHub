import type { DailyGoal, GoalProgress } from "./models";
import { hasGoalTrackingStartedByDate } from "./goal-lifecycle";

export const GOAL_COLOR_COUNT = 8;

export interface ActivityChartDayInput {
  dateKey: string;
  future: boolean;
  progress: GoalProgress[] | undefined;
}

export interface ActivityChartPoint {
  dateKey: string;
  seconds: number | null;
  missingReason?: "not-tracked" | "unavailable" | "future";
}

export interface ActivityChartSeries {
  goalId: string;
  goalName: string;
  color: string;
  points: ActivityChartPoint[];
}

export interface TimeScale {
  maximumSeconds: number;
  stepSeconds: number;
  ticks: number[];
}

const TIME_STEPS_SECONDS = [
  5 * 60,
  15 * 60,
  30 * 60,
  60 * 60,
  2 * 60 * 60,
  4 * 60 * 60,
  6 * 60 * 60,
  12 * 60 * 60
];

export function buildActivityChartSeries(
  goals: DailyGoal[],
  days: ActivityChartDayInput[]
): ActivityChartSeries[] {
  return goals.filter((goal) => goal.enabled).map((goal) => ({
    goalId: goal.id,
    goalName: goal.name,
    color: getGoalColor(goal.id, goal.colorIndex),
    points: days.map((day) => {
      if (!hasGoalTrackingStartedByDate(goal, day.dateKey)) {
        return { dateKey: day.dateKey, seconds: null, missingReason: "not-tracked" };
      }
      if (day.future) return { dateKey: day.dateKey, seconds: null, missingReason: "future" };
      if (day.progress === undefined) {
        return { dateKey: day.dateKey, seconds: null, missingReason: "unavailable" };
      }
      return {
        dateKey: day.dateKey,
        seconds: day.progress.find((item) => item.goalId === goal.id)?.activeSeconds ?? 0
      };
    })
  }));
}

export function getGoalColorIndex(goalId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < goalId.length; index += 1) {
    hash ^= goalId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % GOAL_COLOR_COUNT;
}

export function getGoalColor(goalId: string, colorIndex?: number): string {
  const resolved = colorIndex !== undefined && Number.isInteger(colorIndex)
    && colorIndex >= 0 && colorIndex < GOAL_COLOR_COUNT
    ? colorIndex
    : getGoalColorIndex(goalId);
  return `var(--dh-goal-color-${resolved + 1})`;
}

export function filterActivityChartSeries(
  series: ActivityChartSeries[],
  hiddenGoalIds: ReadonlySet<string>
): ActivityChartSeries[] {
  return series.filter((item) => !hiddenGoalIds.has(item.goalId));
}

export function getActivityChartSegments(points: ActivityChartPoint[]): ActivityChartPoint[][] {
  const segments: ActivityChartPoint[][] = [];
  let current: ActivityChartPoint[] = [];
  for (const point of points) {
    if (point.seconds === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function getMaximumChartSeconds(series: ActivityChartSeries[]): number {
  return series.reduce((maximum, item) => Math.max(
    maximum,
    ...item.points.map((point) => point.seconds ?? 0)
  ), 0);
}

export function getNiceTimeScale(maximumSeconds: number, targetTickCount = 5): TimeScale {
  const safeMaximum = Math.max(0, maximumSeconds);
  const desiredStep = safeMaximum / Math.max(1, targetTickCount);
  const stepSeconds = TIME_STEPS_SECONDS.find((step) => step >= desiredStep)
    ?? Math.ceil(desiredStep / (12 * 60 * 60)) * 12 * 60 * 60;
  const maximum = Math.max(stepSeconds, Math.ceil(safeMaximum / stepSeconds) * stepSeconds);
  const ticks = Array.from(
    { length: Math.floor(maximum / stepSeconds) + 1 },
    (_, index) => index * stepSeconds
  );
  return { maximumSeconds: maximum, stepSeconds, ticks };
}

export function formatChartDuration(seconds: number): string {
  const roundedMinutes = Math.round(Math.max(0, seconds) / 60);
  if (roundedMinutes === 0) return "0h";
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
