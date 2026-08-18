import type { ComputerActivitySegment } from "./activity-models";
import type { ActivityCategory } from "./models";

export type TimelinePresentationMode = "apps" | "categories";

export interface TimelineRange {
  startMs: number;
  endMs: number;
  stepMs: number;
  ticks: number[];
}

export interface TimelinePresentationSegment extends ComputerActivitySegment {
  laneId: string;
  label: string;
  mergeKey: string;
}

export interface TimelineLane {
  id: string;
  label: string;
  seconds: number;
  segments: TimelinePresentationSegment[];
  sourceItems: { id: string; label: string; seconds: number }[];
}

export interface TimelinePresentation {
  lanes: TimelineLane[];
  overviewSegments: TimelinePresentationSegment[];
}

const TIMELINE_STEPS_MS = [5, 10, 15, 30, 60, 120, 180].map((minutes) => minutes * 60_000);

export function getNiceTimelineTickStep(spanMs: number, targetIntervals = 6): number {
  const desired = Math.max(0, spanMs) / Math.max(1, targetIntervals);
  return TIMELINE_STEPS_MS.find((step) => step >= desired) ?? 3 * 60 * 60_000;
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function floorToLocalStep(timestamp: number, stepMs: number): number {
  const dayStart = localDayStart(timestamp);
  return dayStart + Math.floor((timestamp - dayStart) / stepMs) * stepMs;
}

function ceilToLocalStep(timestamp: number, stepMs: number): number {
  const floor = floorToLocalStep(timestamp, stepMs);
  return floor === timestamp ? timestamp : floor + stepMs;
}

export function getVisibleTimelineRange(firstMs: number, lastMs: number, maxEndMs?: number): TimelineRange {
  const safeLast = Math.max(firstMs, lastMs);
  const stepMs = getNiceTimelineTickStep(safeLast - firstMs);
  const startMs = floorToLocalStep(firstMs, stepMs);
  const roundedEndMs = Math.max(startMs + stepMs, ceilToLocalStep(safeLast, stepMs));
  const endMs = maxEndMs === undefined
    ? roundedEndMs
    : Math.max(startMs + stepMs, Math.min(roundedEndMs, Math.max(safeLast, maxEndMs)));
  const ticks: number[] = [];
  for (let timestamp = startMs; timestamp <= endMs; timestamp += stepMs) ticks.push(timestamp);
  return { startMs, endMs, stepMs, ticks };
}

export function formatActivityDuration(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  if (safeSeconds > 0 && safeSeconds < 60) return `${Math.max(1, Math.round(safeSeconds))} sec`;
  const roundedSeconds = Math.round(safeSeconds);
  const hours = Math.floor(roundedSeconds / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const remainder = roundedSeconds % 60;
  if (hours > 0) return remainder > 0
    ? `${hours} h ${minutes} min ${remainder} sec`
    : minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return remainder > 0 ? `${minutes} min ${remainder} sec` : `${minutes} min`;
}

export function formatCompactActivityDuration(seconds: number): string {
  const roundedSeconds = Math.round(Math.max(0, seconds));
  const hours = Math.floor(roundedSeconds / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const remainder = roundedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${hours}h`;
  if (minutes > 0) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${remainder}s`;
}

export function coalesceTimelineSegments(
  segments: TimelinePresentationSegment[],
  toleranceMs = 2_000
): TimelinePresentationSegment[] {
  const merged: TimelinePresentationSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    const gap = previous === undefined ? Number.POSITIVE_INFINITY : segment.startMs - previous.endMs;
    if (previous?.mergeKey === segment.mergeKey && gap >= 0 && gap <= toleranceMs) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
    } else merged.push({ ...segment });
  }
  return merged;
}

export function buildTimelineLanes(
  segments: ComputerActivitySegment[],
  mode: TimelinePresentationMode,
  categories: ActivityCategory[],
  topCount = 4
): TimelinePresentation {
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const totals = new Map<string, { label: string; seconds: number }>();
  const resolved = segments.map((segment) => {
    const id = mode === "apps" ? segment.application : segment.categoryId ?? "uncategorized";
    const label = mode === "apps"
      ? segment.displayApplication
      : categoriesById.get(segment.categoryId ?? "")?.name ?? "Uncategorized";
    const seconds = (segment.endMs - segment.startMs) / 1_000;
    const total = totals.get(id);
    if (total === undefined) totals.set(id, { label, seconds });
    else total.seconds += seconds;
    return { segment, id, label };
  });
  const ranked = [...totals].sort((left, right) => (
    right[1].seconds - left[1].seconds || left[1].label.localeCompare(right[1].label)
  ));
  const visible = ranked.slice(0, Math.max(1, topCount));
  const visibleIds = new Set(visible.map(([id]) => id));
  const hasOther = ranked.length > visible.length;
  const lanes: TimelineLane[] = visible.map(([id, value]) => ({
    id,
    label: value.label,
    seconds: value.seconds,
    segments: [],
    sourceItems: [{ id, label: value.label, seconds: value.seconds }]
  }));
  if (hasOther) {
    const sourceItems = ranked.slice(visible.length).map(([id, value]) => ({ id, ...value }));
    lanes.push({
      id: "other",
      label: "Other",
      seconds: sourceItems.reduce((sum, item) => sum + item.seconds, 0),
      segments: [],
      sourceItems
    });
  }
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
  const overviewSegments: TimelinePresentationSegment[] = [];
  for (const item of resolved) {
    const laneId = visibleIds.has(item.id) ? item.id : "other";
    const presentation: TimelinePresentationSegment = {
      ...item.segment,
      laneId,
      label: item.label,
      mergeKey: mode === "apps" ? `${item.id}\u0000${item.segment.domain ?? ""}` : item.id
    };
    lanesById.get(laneId)?.segments.push(presentation);
    overviewSegments.push(presentation);
  }
  for (const lane of lanes) lane.segments = coalesceTimelineSegments(lane.segments);
  return { lanes, overviewSegments: coalesceTimelineSegments(overviewSegments) };
}
