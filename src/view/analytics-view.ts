import { getGoalColor } from "../activity-chart";
import { getHeatmapLevel, type GoalRangeStats, type RangeAnalytics } from "../analytics";
import { formatDuration } from "../dashboard";
import { getLocalDateRange } from "../date";
import type { DailyGoal } from "../models";
import type { DailyComputerActivity } from "../activity-models";

export function getActivityHeatmapLevel(seconds: number): number {
  if (seconds <= 0) return 0;
  if (seconds < 60 * 60) return 1;
  if (seconds < 2 * 60 * 60) return 2;
  if (seconds < 4 * 60 * 60) return 3;
  if (seconds < 6 * 60 * 60) return 4;
  return 5;
}

export function renderActivityHeatmap(
  container: HTMLElement,
  days: DailyComputerActivity[],
  selectedDateKey: string,
  selectDate: (dateKey: string) => void
): void {
  const scroll = container.createDiv({ cls: "daily-hub-heatmap-scroll" });
  const firstDate = days[0] === undefined ? undefined : getLocalDateRange(days[0].dateKey).start;
  const firstWeekday = firstDate === undefined ? 0 : (firstDate.getDay() + 6) % 7;
  const weekCount = Math.max(1, Math.ceil((firstWeekday + days.length) / 7));
  const heatmap = scroll.createDiv({
    cls: "daily-hub-heatmap",
    attr: {
      role: "grid",
      "aria-label": "30-day active computer time heatmap",
      style: `--dh-heatmap-weeks: ${weekCount}`
    }
  });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((label, index) => {
    heatmap.createEl("span", {
      text: label,
      cls: "daily-hub-heatmap-weekday",
      attr: { style: `grid-column: 1; grid-row: ${index + 2}` }
    });
  });
  const months = new Set<string>();
  days.forEach((day, index) => {
    const date = getLocalDateRange(day.dateKey).start;
    const column = Math.floor((firstWeekday + index) / 7) + 2;
    const month = `${date.getFullYear()}-${date.getMonth()}`;
    if ((index === 0 || date.getDate() <= 7) && !months.has(month)) {
      months.add(month);
      heatmap.createEl("span", {
        text: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date),
        cls: "daily-hub-heatmap-month",
        attr: { style: `grid-column: ${column}; grid-row: 1` }
      });
    }
    const row = ((date.getDay() + 6) % 7) + 2;
    const selected = day.dateKey === selectedDateKey;
    const level = getActivityHeatmapLevel(day.activeComputerSeconds);
    const dateLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    const state = day.available ? formatDuration(day.activeComputerSeconds) : "Unavailable";
    const button = heatmap.createEl("button", {
      text: day.available ? "" : "—",
      cls: `daily-hub-heatmap-cell${day.available ? ` is-level-${level}` : " is-unavailable"}${selected ? " is-selected" : ""}`,
      attr: {
        role: "gridcell",
        title: `${dateLabel}\n${state} active computer time`,
        "aria-label": `${dateLabel}: ${state} active computer time`,
        style: `grid-column: ${column}; grid-row: ${row}`,
        ...(selected ? { "aria-current": "date" } : {})
      }
    });
    button.addEventListener("click", () => selectDate(day.dateKey));
  });
}

export function renderCalendarHeatmap(
  container: HTMLElement,
  analytics: RangeAnalytics,
  selectedDateKey: string,
  selectDate: (dateKey: string) => void
): void {
  const scroll = container.createDiv({ cls: "daily-hub-heatmap-scroll" });
  const firstDate = analytics.days[0] === undefined
    ? undefined
    : getLocalDateRange(analytics.days[0].dateKey).start;
  const firstWeekday = firstDate === undefined ? 0 : (firstDate.getDay() + 6) % 7;
  const weekCount = Math.max(1, Math.ceil((firstWeekday + analytics.days.length) / 7));
  const heatmap = scroll.createDiv({
    cls: "daily-hub-heatmap",
    attr: {
      role: "grid",
      "aria-label": "30-day calendar goal completion heatmap",
      style: `--dh-heatmap-weeks: ${weekCount}`
    }
  });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((label, index) => {
    heatmap.createEl("span", {
      text: label,
      cls: "daily-hub-heatmap-weekday",
      attr: { style: `grid-column: 1; grid-row: ${index + 2}` }
    });
  });

  const monthColumns = new Set<string>();
  const occupiedMonthColumns = new Set<number>();
  analytics.days.forEach((day, index) => {
    const date = getLocalDateRange(day.dateKey).start;
    const week = Math.floor((firstWeekday + index) / 7);
    const column = week + 2;
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    if ((index === 0 || date.getDate() <= 7) && !monthColumns.has(monthKey)) {
      monthColumns.add(monthKey);
      let monthColumn = column;
      while (occupiedMonthColumns.has(monthColumn) && monthColumn < weekCount + 1) monthColumn += 1;
      occupiedMonthColumns.add(monthColumn);
      heatmap.createEl("span", {
        text: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date),
        cls: "daily-hub-heatmap-month",
        attr: { style: `grid-column: ${monthColumn}; grid-row: 1` }
      });
    }

    const row = ((date.getDay() + 6) % 7) + 2;
    const dateLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "short", month: "short", day: "numeric"
    }).format(date);
    const selected = day.dateKey === selectedDateKey;
    const notTracked = day.trackedGoalCount === 0;
    const restDay = !notTracked && day.goalCount === 0;
    const ratio = day.progressRatio;
    const available = day.available && ratio !== undefined;
    const state = notTracked ? "Not tracked"
      : restDay ? "Rest"
      : available ? `${formatDuration(day.totalSeconds ?? 0)}; ${day.completedGoals ?? 0} / ${day.goalCount} completed; ${Math.round(ratio * 100)}%`
      : "Unavailable";
    const button = heatmap.createEl("button", {
      text: available ? "" : restDay ? "·" : "—",
      cls: `daily-hub-heatmap-cell${available ? ` is-level-${getHeatmapLevel(ratio)}` : notTracked ? " is-not-tracked" : restDay ? " is-rest" : " is-unavailable"}${selected ? " is-selected" : ""}`,
      attr: {
        role: "gridcell",
        "aria-label": `${dateLabel}: ${state}`,
        title: `${dateLabel}\n${state}`,
        style: `grid-column: ${column}; grid-row: ${row}`,
        ...(selected ? { "aria-current": "date" } : {})
      }
    });
    button.addEventListener("click", () => selectDate(day.dateKey));
  });
}

export function renderGoalConsistencyView(
  container: HTMLElement,
  goals: GoalRangeStats[],
  configuredGoals: DailyGoal[]
): void {
  const configuredById = new Map(configuredGoals.map((goal) => [goal.id, goal]));
  const list = container.createDiv({ cls: "daily-hub-consistency" });
  for (const goal of goals) {
    const card = list.createDiv({ cls: "daily-hub-consistency-card" });
    card.style.setProperty(
      "--dh-goal-color",
      getGoalColor(goal.goalId, configuredById.get(goal.goalId)?.colorIndex)
    );
    card.createEl("strong", { text: goal.goalName, cls: "daily-hub-consistency-title" });
    const metrics = card.createDiv({ cls: "daily-hub-consistency-metrics" });
    for (const [value, label] of [
      [formatDuration(goal.totalSeconds), "total"],
      [`${goal.completedDays} / ${goal.availableDays}`, "completed"],
      [String(goal.currentStreak), "streak"],
      [String(goal.bestStreak), "best"]
    ]) {
      const metric = metrics.createDiv({ cls: "daily-hub-consistency-metric" });
      metric.createEl("strong", { text: value });
      metric.createEl("span", { text: label });
    }
  }
}
