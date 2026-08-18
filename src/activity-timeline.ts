import { getLocalDateRange } from "./date";
import type { DailyGoal, DayActivity } from "./models";
import { resolveTrackingTimeline, type TrackingSegment } from "./progress";

export const GOAL_COLOR_COUNT = 8;

export interface ActivityTimelineDayInput {
  dateKey: string;
  activity?: DayActivity;
}

export interface ActivityTimelineDay {
  dateKey: string;
  available: boolean;
  segments: TrackingSegment[];
}

export interface TimelineSegmentPosition {
  leftPercent: number;
  widthPercent: number;
}

function mergeAdjacentSegments(segments: TrackingSegment[]): TrackingSegment[] {
  const merged: TrackingSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous?.goalId === segment.goalId
      && previous.endMs === segment.startMs) {
      previous.endMs = segment.endMs;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function buildActivityTimeline(
  goals: DailyGoal[],
  days: ActivityTimelineDayInput[]
): ActivityTimelineDay[] {
  return days.map((day) => {
    if (day.activity === undefined) {
      return { dateKey: day.dateKey, available: false, segments: [] };
    }
    const range = getLocalDateRange(day.dateKey);
    return {
      dateKey: day.dateKey,
      available: true,
      segments: mergeAdjacentSegments(resolveTrackingTimeline(
        goals,
        day.activity,
        range.start.getTime(),
        range.end.getTime()
      ))
    };
  });
}

export function getGoalColorIndex(goalId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < goalId.length; index += 1) {
    hash ^= goalId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % GOAL_COLOR_COUNT;
}

export function getGoalColor(goalId: string): string {
  return `var(--dh-goal-color-${getGoalColorIndex(goalId) + 1})`;
}

export function getTimelineSegmentPosition(
  segment: TrackingSegment,
  dateKey: string
): TimelineSegmentPosition {
  const range = getLocalDateRange(dateKey);
  const startMs = range.start.getTime();
  const durationMs = range.end.getTime() - startMs;
  return {
    leftPercent: ((segment.startMs - startMs) / durationMs) * 100,
    widthPercent: ((segment.endMs - segment.startMs) / durationMs) * 100
  };
}
