import { getLocalDateRange } from "./date";
import type { DailyGoal } from "./models";

export function isValidTrackingStartedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function getTrackingStartMs(goal: Pick<DailyGoal, "trackingStartedAt">): number | undefined {
  return isValidTrackingStartedAt(goal.trackingStartedAt)
    ? Date.parse(goal.trackingStartedAt)
    : undefined;
}

export function isGoalTrackingActiveAt(
  goal: Pick<DailyGoal, "trackingStartedAt">,
  timestampMs: number
): boolean {
  const trackingStartMs = getTrackingStartMs(goal);
  return trackingStartMs === undefined || timestampMs >= trackingStartMs;
}

export function hasGoalTrackingStartedByDate(
  goal: Pick<DailyGoal, "trackingStartedAt">,
  dateKey: string
): boolean {
  const trackingStartMs = getTrackingStartMs(goal);
  return trackingStartMs === undefined || getLocalDateRange(dateKey).end.getTime() > trackingStartMs;
}

export function startGoalTracking(goal: DailyGoal, startedAt: Date): DailyGoal {
  return isValidTrackingStartedAt(goal.trackingStartedAt)
    ? goal
    : { ...goal, trackingStartedAt: startedAt.toISOString() };
}
