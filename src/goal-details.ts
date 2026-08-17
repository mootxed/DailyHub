import { Modal, setIcon } from "obsidian";
import type { GoalRangeStats } from "./analytics";
import { formatDuration, formatRemainingDuration, type GoalWeekStats } from "./dashboard";
import { getLocalDateRange, isToday } from "./date";
import type DailyHubPlugin from "./main";

export interface GoalDetailsStats {
  week: GoalWeekStats;
  range: GoalRangeStats | undefined;
}

type GoalStatsLoader = (force: boolean) => Promise<GoalDetailsStats>;

export class GoalDetailsModal extends Modal {
  private stats: GoalDetailsStats;

  constructor(
    plugin: DailyHubPlugin,
    private readonly selectedDateKey: string,
    initialStats: GoalDetailsStats,
    private readonly loadStats: GoalStatsLoader
  ) {
    super(plugin.app);
    this.stats = initialStats;
  }

  override onOpen(): void {
    this.render();
    if (this.stats.range === undefined) void this.refresh(undefined, false);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(error?: string): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("daily-hub-goal-details");
    const week = this.stats.week;
    this.titleEl.setText(week.goalName);

    const toolbar = container.createDiv({ cls: "daily-hub-details-toolbar" });
    toolbar.createEl("span", { text: this.weekLabel(), cls: "daily-hub-muted" });
    const refresh = toolbar.createEl("button", {
      cls: "daily-hub-icon-button",
      attr: { "aria-label": `Refresh ${week.goalName} details`, title: "Refresh details" }
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => { void this.refresh(refresh, true); });

    if (error !== undefined) {
      container.createEl("p", { text: error, cls: "daily-hub-warning", attr: { role: "status" } });
    }

    const selected = container.createDiv({ cls: "daily-hub-details-selected" });
    selected.createEl("h3", { text: isToday(this.selectedDateKey) ? "Today" : "Selected day" });
    selected.createEl("div", {
      text: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
        .format(getLocalDateRange(this.selectedDateKey).start),
      cls: "daily-hub-muted"
    });
    const selectedDay = week.selectedDay;
    if (selectedDay !== undefined && !selectedDay.trackingStarted) {
      selected.createEl("strong", {
        text: "Not tracked yet",
        cls: "daily-hub-details-value daily-hub-rest-day"
      });
    } else if (selectedDay !== undefined && !selectedDay.scheduled) {
      selected.createEl("strong", {
        text: selectedDay.skipped ? "Skipped" : "Rest day",
        cls: "daily-hub-details-value daily-hub-rest-day"
      });
      if (selectedDay.available && (selectedDay.activeSeconds ?? 0) > 0) {
        selected.createEl("div", {
          text: `${formatDuration(selectedDay.activeSeconds ?? 0)} activity`,
          cls: "daily-hub-muted"
        });
      }
    } else if (selectedDay?.future === true) {
      selected.createEl("strong", {
        text: `Planned: ${selectedDay.targetMinutes} min`,
        cls: "daily-hub-details-value"
      });
    } else if (selectedDay?.available !== true || selectedDay.activeSeconds === undefined) {
      selected.createEl("strong", { text: "—", cls: "daily-hub-details-value" });
    } else {
      const minutes = Math.floor(selectedDay.activeSeconds / 60);
      selected.createEl("strong", {
        text: `${minutes} / ${selectedDay.targetMinutes} min`,
        cls: "daily-hub-details-value"
      });
      const remainingSeconds = Math.max(selectedDay.targetMinutes * 60 - selectedDay.activeSeconds, 0);
      selected.createEl("div", {
        text: selectedDay.completed === true
          ? "Goal complete ✓"
          : `${formatRemainingDuration(remainingSeconds)} remaining`,
        cls: selectedDay.completed === true ? "daily-hub-complete" : "daily-hub-muted"
      });
    }

    const weekly = container.createDiv({ cls: "daily-hub-details-weekly" });
    const total = weekly.createDiv();
    total.createEl("span", { text: "This week", cls: "daily-hub-muted" });
    total.createEl("strong", { text: formatDuration(week.totalSeconds) });
    const completion = weekly.createDiv();
    completion.createEl("span", { text: "Completed on", cls: "daily-hub-muted" });
    completion.createEl("strong", { text: `${week.completedDays} / ${week.trackedDays} opportunities` });

    this.renderRange(container);

    const days = container.createDiv({ cls: "daily-hub-details-days" });
    for (const day of week.days) {
      const row = days.createDiv({ cls: "daily-hub-details-day" });
      row.createEl("span", {
        text: new Intl.DateTimeFormat(undefined, { weekday: "short" })
          .format(getLocalDateRange(day.dateKey).start)
      });
      const value = !day.trackingStarted
        ? "Not tracked"
        : !day.scheduled
        ? day.skipped ? "Skipped" : "Rest"
        : day.future
          ? `Planned ${day.targetMinutes} min`
          : day.activeSeconds === undefined
            ? `— / ${day.targetMinutes} min`
            : `${formatDuration(day.activeSeconds)} / ${day.targetMinutes} min`;
      row.createEl("strong", { text: value, cls: !day.scheduled ? "daily-hub-rest-day" : undefined });
      row.createEl("span", {
        text: day.completed === true ? "✓" : "",
        cls: "daily-hub-complete",
        attr: { "aria-label": day.completed === true ? "Completed" : "" }
      });
    }
  }

  private renderRange(container: HTMLElement): void {
    const section = container.createDiv({ cls: "daily-hub-details-range" });
    section.createEl("h3", { text: "Last 30 days" });
    const range = this.stats.range;
    if (range === undefined) {
      section.createEl("p", { text: "Loading analytics…", cls: "daily-hub-muted", attr: { role: "status" } });
      return;
    }

    const metrics = section.createDiv({ cls: "daily-hub-details-range-grid" });
    const values: [string, string][] = [
      ["Total", formatDuration(range.totalSeconds)],
      ["Completed days", `${range.completedDays} / ${range.availableDays} scheduled`],
      ["Completion rate", range.completionRate === undefined ? "—" : `${Math.round(range.completionRate * 100)}%`],
      ["Current streak", `${range.currentStreak} days`],
      ["Best streak", `${range.bestStreak} days`]
    ];
    for (const [label, value] of values) {
      const metric = metrics.createDiv();
      metric.createEl("span", { text: label, cls: "daily-hub-muted" });
      metric.createEl("strong", { text: value });
    }
    if (range.streakMayBeIncomplete) {
      section.createEl("p", { text: "Streaks may be incomplete because some activity data is unavailable.", cls: "daily-hub-muted" });
    }
  }

  private async refresh(button: HTMLButtonElement | undefined, force: boolean): Promise<void> {
    if (button !== undefined) {
      button.disabled = true;
      button.addClass("is-loading");
    }
    try {
      this.stats = await this.loadStats(force);
      this.render();
    } catch {
      this.render("Could not refresh goal details");
    }
  }

  private weekLabel(): string {
    const first = this.stats.week.days[0];
    const last = this.stats.week.days[this.stats.week.days.length - 1];
    if (first === undefined || last === undefined) return "Selected week";
    const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    return `${formatter.format(getLocalDateRange(first.dateKey).start)}–${formatter.format(
      getLocalDateRange(last.dateKey).start
    )}`;
  }
}
