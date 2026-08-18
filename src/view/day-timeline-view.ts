import type { DailyComputerActivity } from "../activity-models";
import { getGoalColor } from "../activity-chart";
import { formatDuration } from "../dashboard";
import type { ActivityCategory } from "../models";

export type DayTimelineMode = "apps" | "categories";

export interface DayTimelineViewOptions {
  activity: DailyComputerActivity;
  categories: ActivityCategory[];
  mode: DayTimelineMode;
  setMode: (mode: DayTimelineMode) => void;
}

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

export function renderDayTimelineView(container: HTMLElement, options: DayTimelineViewOptions): void {
  const section = container.createDiv({ cls: "daily-hub-day-timeline daily-hub-panel" });
  const heading = section.createDiv({ cls: "daily-hub-section-heading daily-hub-section-heading-with-tabs" });
  const copy = heading.createDiv();
  copy.createEl("div", { text: "Today", cls: "daily-hub-kicker" });
  copy.createEl("h2", { text: "Activity timeline", cls: "daily-hub-section-title" });
  const tabs = heading.createDiv({ cls: "daily-hub-segmented-control", attr: { role: "tablist" } });
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

  const categories = new Map(options.categories.map((category) => [category.id, category]));
  const start = options.activity.segments[0]?.startMs ?? 0;
  const end = options.activity.segments.at(-1)?.endMs ?? start;
  const span = Math.max(end - start, 1);
  const scroll = section.createDiv({ cls: "daily-hub-day-timeline-scroll" });
  const axis = scroll.createDiv({ cls: "daily-hub-day-timeline-axis" });
  axis.createEl("span", { text: clock(start) });
  axis.createEl("span", { text: clock(end) });
  const track = scroll.createDiv({
    cls: "daily-hub-day-timeline-track",
    attr: { role: "img", "aria-label": "Sequential foreground computer activity" }
  });
  for (const segment of options.activity.segments) {
    const category = segment.categoryId === undefined ? undefined : categories.get(segment.categoryId);
    const label = options.mode === "categories" ? category?.name ?? "Uncategorized" : segment.displayApplication;
    const color = options.mode === "categories"
      ? getGoalColor(`category:${segment.categoryId ?? "uncategorized"}`, category?.colorIndex)
      : getGoalColor(`application:${segment.application}`);
    const block = track.createDiv({
      cls: "daily-hub-day-timeline-segment",
      attr: {
        title: `${label}\n${clock(segment.startMs)}–${clock(segment.endMs)}\n${formatDuration((segment.endMs - segment.startMs) / 1000)}`,
        "aria-label": `${label}, ${clock(segment.startMs)} to ${clock(segment.endMs)}`,
        style: `left: ${((segment.startMs - start) / span) * 100}%; width: ${((segment.endMs - segment.startMs) / span) * 100}%; --dh-activity-color: ${color}`
      }
    });
    if ((segment.endMs - segment.startMs) / span > 0.06) block.createSpan({ text: label });
  }
  section.createEl("p", {
    text: "Gaps show AFK or time without foreground-window evidence.",
    cls: "daily-hub-muted daily-hub-timeline-note"
  });
}
