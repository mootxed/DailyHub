import type { ActivityBreakdownItem, DailyComputerActivity } from "../activity-models";
import { getIdentityColor } from "../identity-color";
import type { ActivityCategory } from "../models";
import {
  buildTimelineLanes,
  formatActivityDuration,
  formatCompactActivityDuration,
  getTimelineNowMarkerPosition,
  getVisibleTimelineRange,
  type TimelineLane,
  type TimelinePresentationSegment
} from "../timeline-presentation";

export type DayTimelineMode = "apps" | "categories";

export interface DayTimelineViewOptions {
  activity: DailyComputerActivity;
  categories: ActivityCategory[];
  mode: DayTimelineMode;
  isToday: boolean;
  setMode: (mode: DayTimelineMode) => void;
  openDetails?: (item: ActivityBreakdownItem, mode: DayTimelineMode) => void;
}

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function segmentTooltip(segment: TimelinePresentationSegment, mode: DayTimelineMode): string {
  const domain = mode === "apps" && segment.domain !== undefined ? `\n${segment.domain}` : "";
  return `${segment.label}${domain}\n${clock(segment.startMs)}–${clock(segment.endMs)}\n${formatActivityDuration((segment.endMs - segment.startMs) / 1_000)}`;
}

function laneItem(lane: TimelineLane, totalSeconds: number): ActivityBreakdownItem {
  const children = lane.id === "other" ? lane.sourceItems.map((item) => ({
    ...item,
    percentage: totalSeconds > 0 ? item.seconds / totalSeconds : 0
  })) : undefined;
  return {
    id: lane.id,
    label: lane.label,
    seconds: lane.seconds,
    percentage: totalSeconds > 0 ? lane.seconds / totalSeconds : 0,
    ...(children === undefined ? {} : { children })
  };
}

function laneColors(
  lanes: TimelineLane[],
  mode: DayTimelineMode,
  categories: ActivityCategory[]
): Map<string, string> {
  const result = new Map<string, string>();
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  for (const lane of lanes) {
    result.set(lane.id, getIdentityColor(
      mode === "apps" ? "app" : "category",
      lane.id,
      mode === "categories" ? categoriesById.get(lane.id)?.colorIndex : undefined
    ));
  }
  return result;
}

export function renderDayTimelineView(container: HTMLElement, options: DayTimelineViewOptions): void {
  const section = container.createDiv({ cls: "daily-hub-day-timeline daily-hub-panel" });
  const heading = section.createDiv({ cls: "daily-hub-section-heading daily-hub-section-heading-with-tabs" });
  const copy = heading.createDiv();
  copy.createEl("div", { text: "Today", cls: "daily-hub-kicker" });
  copy.createEl("h2", { text: "Activity timeline", cls: "daily-hub-section-title" });
  const tabs = heading.createDiv({
    cls: "daily-hub-segmented-control",
    attr: { role: "tablist", "aria-label": "Timeline mode" }
  });
  for (const mode of ["apps", "categories"] as const) {
    const selected = options.mode === mode;
    const button = tabs.createEl("button", {
      text: mode === "apps" ? "Apps" : "Categories",
      cls: selected ? "is-selected" : "",
      attr: { type: "button", role: "tab", "aria-selected": String(selected) }
    });
    button.addEventListener("click", () => options.setMode(mode));
  }
  if (!options.activity.available) {
    section.createEl("p", { text: "Computer activity unavailable.", cls: "daily-hub-muted" });
    return;
  }
  if (options.activity.segments.length === 0) {
    section.createEl("p", { text: "No active computer time recorded for this day.", cls: "daily-hub-muted" });
    return;
  }

  const first = Math.min(...options.activity.segments.map((segment) => segment.startMs));
  const last = Math.max(...options.activity.segments.map((segment) => segment.endMs));
  const nowMs = Date.now();
  const visibleLast = options.isToday ? Math.max(last, nowMs) : last;
  const maxEndMs = options.isToday ? nowMs + 10 * 60_000 : undefined;
  const range = getVisibleTimelineRange(first, visibleLast, maxEndMs);
  const span = range.endMs - range.startMs;
  const presentation = buildTimelineLanes(options.activity.segments, options.mode, options.categories);
  const colors = laneColors(presentation.lanes, options.mode, options.categories);
  const scroll = section.createDiv({ cls: "daily-hub-day-timeline-scroll" });
  const content = scroll.createDiv({ cls: "daily-hub-day-timeline-content" });
  const position = (timestamp: number): number => ((timestamp - range.startMs) / span) * 100;
  const nowPosition = getTimelineNowMarkerPosition(range, nowMs, options.isToday);

  const axis = content.createDiv({ cls: "daily-hub-day-timeline-axis" });
  axis.createSpan({ cls: "daily-hub-day-timeline-axis-spacer", attr: { "aria-hidden": "true" } });
  const tickTrack = axis.createDiv();
  for (const tick of range.ticks) {
    tickTrack.createEl("span", { text: clock(tick), attr: { style: `left: ${position(tick)}%` } });
  }
  if (nowPosition !== undefined) {
    tickTrack.createDiv({
      text: "Now",
      cls: "daily-hub-day-timeline-now-label",
      attr: { "aria-hidden": "true", style: `left: ${nowPosition}%` }
    });
  }

  const lanes = content.createDiv({ cls: "daily-hub-day-timeline-body" });
  const grid = lanes.createDiv({ cls: "daily-hub-day-timeline-grid", attr: { "aria-hidden": "true" } });
  for (const tick of range.ticks) grid.createDiv({ attr: { style: `left: ${position(tick)}%` } });
  if (nowPosition !== undefined) {
    grid.createDiv({
      cls: "daily-hub-day-timeline-now-line",
      attr: { style: `left: ${nowPosition}%` }
    });
  }
  for (const lane of presentation.lanes) {
    const row = lanes.createDiv({ cls: "daily-hub-day-timeline-row" });
    const color = colors.get(lane.id) ?? getIdentityColor(options.mode === "apps" ? "app" : "category", lane.id);
    row.style.setProperty("--dh-activity-color", color);
    const label = row.createDiv({
      cls: "daily-hub-day-timeline-label",
      attr: { title: `${lane.label}: ${formatActivityDuration(lane.seconds)}` }
    });
    label.createSpan({ cls: "daily-hub-day-timeline-swatch", attr: { "aria-hidden": "true" } });
    label.createEl("strong", { text: lane.label });
    label.createEl("span", {
      text: formatCompactActivityDuration(lane.seconds),
      cls: "daily-hub-day-timeline-duration"
    });
    const track = row.createDiv({
      cls: "daily-hub-day-timeline-lane",
      attr: { role: "group", "aria-label": `${lane.label}, ${formatActivityDuration(lane.seconds)}` }
    });
    const details = laneItem(lane, options.activity.activeComputerSeconds);
    for (const segment of lane.segments) {
      const title = segmentTooltip(segment, options.mode);
      const block = track.createEl("button", {
        cls: "daily-hub-day-timeline-segment",
        attr: {
          type: "button",
          title,
          "aria-label": title.replaceAll("\n", ", "),
          style: `left: ${position(segment.startMs)}%; width: ${((segment.endMs - segment.startMs) / span) * 100}%`
        }
      });
      block.createSpan({ cls: "daily-hub-day-timeline-segment-fill", attr: { "aria-hidden": "true" } });
      if (options.openDetails === undefined) block.disabled = true;
      else block.addEventListener("click", () => options.openDetails?.(details, options.mode));
    }
  }
  section.createEl("p", {
    text: "Blank space = AFK or missing activity.",
    cls: "daily-hub-muted daily-hub-timeline-note"
  });
}
