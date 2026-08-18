import { getLocalDateRange } from "./date";
import type { DailyGoal, GoalTrackingPause } from "./models";
import { configRevisionFromGoal } from "./goal-config-history";

export function isValidTrackingStartedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function getTrackingStartMs(goal: Pick<DailyGoal, "trackingStartedAt">): number | undefined {
  return isValidTrackingStartedAt(goal.trackingStartedAt)
    ? Date.parse(goal.trackingStartedAt)
    : undefined;
}

export function isGoalTrackingActiveAt(
  goal: Pick<DailyGoal, "trackingStartedAt" | "trackingPauses">,
  timestampMs: number
): boolean {
  const trackingStartMs = getTrackingStartMs(goal);
  return (trackingStartMs === undefined || timestampMs >= trackingStartMs)
    && !isGoalPausedAt(goal, timestampMs);
}

function pauseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function canonicalTimestamp(value: Date | number | string): string | undefined {
  const timestamp = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
    : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function isGoalPausedAt(
  goal: Pick<DailyGoal, "trackingPauses">,
  timestampMs: number
): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  return (goal.trackingPauses ?? []).some((pause) => {
    const startMs = pauseTimestamp(pause.startedAt);
    const endMs = pauseTimestamp(pause.endedAt);
    return startMs !== undefined
      && timestampMs >= startMs
      && (pause.endedAt === undefined || (endMs !== undefined && timestampMs < endMs));
  });
}

export function isGoalPaused(goal: Pick<DailyGoal, "trackingPauses">, at = new Date()): boolean {
  return isGoalPausedAt(goal, at.getTime());
}

export function pauseGoal(
  goal: DailyGoal,
  at: Date | number | string = new Date()
): boolean {
  const startedAt = canonicalTimestamp(at);
  if (startedAt === undefined) return false;
  if (isGoalPausedAt(goal, Date.parse(startedAt))) return false;
  const pauses = goal.trackingPauses ?? [];
  if (pauses.some((pause) => pause.endedAt === undefined)) return false;
  goal.trackingPauses = [...pauses, { startedAt }];
  return true;
}

export function resumeGoal(
  goal: DailyGoal,
  at: Date | number | string = new Date()
): boolean {
  const endedAt = canonicalTimestamp(at);
  if (endedAt === undefined) return false;
  const pauses = goal.trackingPauses ?? [];
  const openIndex = pauses.findIndex((pause) => pause.endedAt === undefined);
  const openPause = pauses[openIndex];
  if (openIndex < 0 || openPause === undefined) return false;
  const startMs = pauseTimestamp(openPause.startedAt);
  if (startMs === undefined || Date.parse(endedAt) < startMs) return false;
  goal.trackingPauses = pauses.map((pause, index): GoalTrackingPause => (
    index === openIndex ? { ...pause, endedAt } : pause
  ));
  return true;
}

export function hasGoalTrackingStartedByDate(
  goal: Pick<DailyGoal, "trackingStartedAt">,
  dateKey: string
): boolean {
  const trackingStartMs = getTrackingStartMs(goal);
  return trackingStartMs === undefined || getLocalDateRange(dateKey).end.getTime() > trackingStartMs;
}

export function startGoalTracking(goal: DailyGoal, startedAt: Date): DailyGoal {
  if (isValidTrackingStartedAt(goal.trackingStartedAt)) return goal;
  const trackingStartedAt = startedAt.toISOString();
  const started = { ...goal, trackingStartedAt };
  return {
    ...started,
    configHistory: [configRevisionFromGoal(started, trackingStartedAt)]
  };
}
