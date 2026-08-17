import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  formatDuration,
  formatRemainingDuration,
  getRemainingGoals,
  getTotalRemainingSeconds,
  summarizeDay,
  summarizeWeek,
  type GoalWeekStats,
  type WeeklyAnalytics
} from "./dashboard";
import {
  addLocalDays,
  getDateNavigator,
  getLocalDateRange,
  getLocalWeek,
  isFutureDate,
  isToday,
  toLocalDateKey
} from "./date";
import { GoalEditorModal } from "./goal-editor";
import { GoalDetailsModal } from "./goal-details";
import type DailyHubPlugin from "./main";
import type { ActivityWatchSnapshot, ActivityWatchStatus, DailyGoal, GoalProgress } from "./models";
import { calculateDailyProgress } from "./progress";

export const DAILY_HUB_VIEW_TYPE = "daily-hub-view";
const ACTIVITYWATCH_DOWNLOAD_URL = "https://activitywatch.net/downloads/";
const BROWSER_WATCHER_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-browser";
const OFFLINE_STATUS: ActivityWatchStatus = {
  kind: "offline",
  windowWatcherAvailable: false,
  browserWatcherAvailable: false,
  afkWatcherAvailable: false,
  message: "ActivityWatch not found"
};

interface WeekDayData {
  key: string;
  date: Date;
  future: boolean;
  progress: GoalProgress[] | undefined;
}

export class DailyHubView extends ItemView {
  private readonly plugin: DailyHubPlugin;
  private refreshSequence = 0;
  private selectedDateKey = toLocalDateKey(new Date());
  private hasRendered = false;
  private refreshButton: HTMLButtonElement | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: DailyHubPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DAILY_HUB_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Daily Hub";
  }

  override getIcon(): string {
    return "calendar-check";
  }

  override async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(force = false): Promise<void> {
    const sequence = ++this.refreshSequence;
    const today = new Date();
    const todayKey = toLocalDateKey(today);
    const weekDates = getLocalWeek(this.selectedDateKey);
    const weekKeys = weekDates.map(toLocalDateKey);

    if (force) {
      this.plugin.invalidateActivitySnapshots(new Set([todayKey, this.selectedDateKey, ...weekKeys]));
    }
    if (!this.hasRendered) this.renderLoading();
    else this.setRefreshing(true);

    const requestedKeys = new Set([todayKey]);
    for (const key of weekKeys) {
      if (!isFutureDate(key, today)) requestedKeys.add(key);
    }

    const keys = [...requestedKeys];
    const results = await Promise.allSettled(keys.map((key) => this.plugin.getActivitySnapshot(key)));
    if (sequence !== this.refreshSequence) return;

    const snapshots = new Map<string, ActivityWatchSnapshot>();
    results.forEach((result, index) => {
      const key = keys[index];
      if (key !== undefined && result.status === "fulfilled") snapshots.set(key, result.value);
    });

    const selectedFuture = isFutureDate(this.selectedDateKey, today);
    const selectedSnapshot = selectedFuture ? undefined : snapshots.get(this.selectedDateKey);
    const selectedProgress = calculateDailyProgress(
      this.plugin.data.goals,
      selectedSnapshot?.activity ?? { windowEvents: [], browserEvents: [], afkEvents: [] },
      this.selectedDateKey
    );
    const week = weekDates.map((date): WeekDayData => {
      const key = toLocalDateKey(date);
      const future = isFutureDate(key, today);
      const snapshot = snapshots.get(key);
      return {
        key,
        date,
        future,
        progress: future || snapshot === undefined || snapshot.status.kind === "offline"
          ? undefined
          : calculateDailyProgress(this.plugin.data.goals, snapshot.activity, key)
      };
    });

    const weeklyAnalytics = summarizeWeek(
      this.plugin.data.goals,
      week.map((day) => ({ dateKey: day.key, future: day.future, progress: day.progress })),
      this.selectedDateKey
    );

    const status = selectedFuture
      ? snapshots.get(todayKey)?.status ?? OFFLINE_STATUS
      : selectedSnapshot?.status ?? { ...OFFLINE_STATUS, message: "Selected day unavailable" };
    this.renderDashboard(
      getLocalDateRange(this.selectedDateKey).start,
      today,
      status,
      selectedProgress,
      week,
      weeklyAnalytics,
      selectedFuture,
      selectedSnapshot?.status.kind === "connected"
    );
    this.hasRendered = true;

    const todaySnapshot = snapshots.get(todayKey);
    if (todaySnapshot !== undefined) {
      const todayProgress = isToday(this.selectedDateKey, today)
        ? selectedProgress
        : calculateDailyProgress(this.plugin.data.goals, todaySnapshot.activity, todayKey);
      await this.plugin.notifyNewCompletions(todayKey, todayProgress);
    }
  }

  private renderLoading(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("daily-hub-view");
    container.createEl("h1", { text: "Daily Hub" });
    const loading = container.createDiv({ cls: "daily-hub-loading", attr: { role: "status" } });
    loading.createDiv({ cls: "daily-hub-loading-line" });
    loading.createDiv({ cls: "daily-hub-loading-line is-short" });
    loading.createEl("span", { text: "Loading activity…", cls: "daily-hub-muted" });
  }

  private setRefreshing(refreshing: boolean): void {
    this.refreshButton?.toggleClass("is-loading", refreshing);
    this.refreshButton?.setAttribute("aria-busy", String(refreshing));
    if (this.refreshButton !== undefined) this.refreshButton.disabled = refreshing;
  }

  private renderDashboard(
    date: Date,
    today: Date,
    status: ActivityWatchStatus,
    progress: GoalProgress[],
    week: WeekDayData[],
    weeklyAnalytics: WeeklyAnalytics,
    future: boolean,
    selectedAvailable: boolean
  ): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("daily-hub-view");

    const header = container.createDiv({ cls: "daily-hub-header" });
    header.createEl("h1", { text: "Daily Hub" });
    const headerActions = header.createDiv({ cls: "daily-hub-header-actions" });
    this.refreshButton = headerActions.createEl("button", {
      cls: "daily-hub-icon-button",
      attr: { "aria-label": "Refresh Daily Hub", title: "Refresh" }
    });
    setIcon(this.refreshButton, "refresh-cw");
    this.refreshButton.addEventListener("click", () => { void this.refresh(true); });
    const add = headerActions.createEl("button", { text: "Add goal", cls: "mod-cta" });
    add.addEventListener("click", () => new GoalEditorModal(this.plugin).open());

    this.renderDateNavigator(container, today);

    const dayHeader = container.createDiv({ cls: "daily-hub-day-header" });
    const dayTitle = dayHeader.createDiv();
    if (isToday(this.selectedDateKey, today)) {
      dayTitle.createEl("div", { text: "Today", cls: "daily-hub-kicker" });
    }
    dayTitle.createEl("h2", {
      text: new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric"
      }).format(date),
      cls: "daily-hub-date"
    });

    const daySummary = summarizeDay(this.plugin.data.goals, progress);
    const summary = container.createDiv({ cls: "daily-hub-summary", attr: { "aria-label": "Daily summary" } });
    const studied = summary.createDiv({ cls: "daily-hub-summary-item" });
    studied.createEl("strong", {
      text: selectedAvailable ? formatDuration(daySummary.totalActiveSeconds) : "—"
    });
    studied.createEl("span", { text: "studied" });
    const completed = summary.createDiv({ cls: "daily-hub-summary-item" });
    completed.createEl("strong", {
      text: selectedAvailable ? `${daySummary.completedGoals} / ${daySummary.goalCount}` : "—"
    });
    completed.createEl("span", { text: "goals completed" });
    if (selectedAvailable && daySummary.goalCount > 0 && daySummary.completedGoals === daySummary.goalCount) {
      container.createEl("div", { text: "All goals completed ✓", cls: "daily-hub-all-complete" });
    }

    this.renderStatus(container, status);
    if (isToday(this.selectedDateKey, today)) {
      this.renderRemainingToday(container, progress, selectedAvailable);
    }
    container.createEl("h2", { text: "Goals", cls: "daily-hub-section-title" });

    const enabledGoals = this.plugin.data.goals.filter((goal) => goal.enabled);
    if (enabledGoals.length === 0) {
      const empty = container.createDiv({ cls: "daily-hub-empty" });
      empty.createEl("h3", { text: "No daily goals yet" });
      empty.createEl("p", { text: "Add a goal and match it to an app, window title, or browser URL." });
      const emptyAdd = empty.createEl("button", { text: "Add your first goal", cls: "mod-cta" });
      emptyAdd.addEventListener("click", () => new GoalEditorModal(this.plugin).open());
    } else {
      const goals = container.createDiv({ cls: "daily-hub-goals" });
      const progressByGoal = new Map(progress.map((item) => [item.goalId, item]));
      const weekByGoal = new Map(weeklyAnalytics.goals.map((item) => [item.goalId, item]));
      for (const goal of enabledGoals) {
        const goalProgress = progressByGoal.get(goal.id);
        const goalWeek = weekByGoal.get(goal.id);
        if (goalProgress !== undefined && goalWeek !== undefined) {
          this.renderGoal(goals, goal, goalProgress, goalWeek, selectedAvailable, future);
        }
      }
    }

    this.renderWeek(container, week, weeklyAnalytics);
  }

  private renderDateNavigator(container: HTMLElement, today: Date): void {
    const wrapper = container.createDiv({ cls: "daily-hub-date-navigation" });
    const previous = wrapper.createEl("button", {
      cls: "daily-hub-date-arrow daily-hub-icon-button",
      attr: { "aria-label": "Previous week", title: "Previous week" }
    });
    setIcon(previous, "chevron-left");
    previous.addEventListener("click", () => this.selectDate(toLocalDateKey(addLocalDays(this.selectedDateKey, -7))));

    const days = wrapper.createDiv({ cls: "daily-hub-date-days" });
    for (const item of getDateNavigator(this.selectedDateKey, today)) {
      const button = days.createEl("button", {
        cls: `daily-hub-date-button${item.selected ? " is-selected" : ""}${item.today ? " is-today" : ""}`,
        attr: {
          "aria-label": new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(item.date),
          ...(item.selected ? { "aria-current": "date" } : {})
        }
      });
      button.createEl("span", {
        text: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(item.date),
        cls: "daily-hub-date-weekday"
      });
      button.createEl("strong", { text: String(item.date.getDate()) });
      if (item.today) button.createEl("span", { text: "Today", cls: "daily-hub-today-indicator" });
      button.addEventListener("click", () => this.selectDate(item.key));
    }

    const next = wrapper.createEl("button", {
      cls: "daily-hub-date-arrow daily-hub-icon-button",
      attr: { "aria-label": "Next week", title: "Next week" }
    });
    setIcon(next, "chevron-right");
    next.addEventListener("click", () => this.selectDate(toLocalDateKey(addLocalDays(this.selectedDateKey, 7))));

    if (!isToday(this.selectedDateKey, today)) {
      const todayButton = container.createEl("button", { text: "Today", cls: "daily-hub-today-button" });
      todayButton.addEventListener("click", () => this.selectDate(toLocalDateKey(today)));
    }
  }

  private selectDate(dateKey: string): void {
    if (dateKey === this.selectedDateKey) return;
    this.selectedDateKey = dateKey;
    void this.refresh();
  }

  private renderRemainingToday(
    container: HTMLElement,
    progress: GoalProgress[],
    selectedAvailable: boolean
  ): void {
    const section = container.createDiv({ cls: "daily-hub-remaining" });
    section.createEl("h2", { text: "Remaining today", cls: "daily-hub-section-title" });
    if (!selectedAvailable) {
      section.createEl("p", { text: "Remaining time unavailable", cls: "daily-hub-muted" });
      return;
    }

    const remaining = getRemainingGoals(this.plugin.data.goals, progress);
    if (remaining.length === 0) {
      section.createEl("p", { text: "Nothing left for today ✓", cls: "daily-hub-all-complete" });
      return;
    }

    const list = section.createDiv({ cls: "daily-hub-remaining-list" });
    for (const item of remaining) {
      const row = list.createDiv({ cls: "daily-hub-remaining-row" });
      row.createEl("span", { text: item.name });
      row.createEl("strong", { text: formatRemainingDuration(item.remainingSeconds) });
    }
    const total = section.createDiv({ cls: "daily-hub-remaining-total" });
    total.createEl("span", { text: "Total" });
    total.createEl("strong", {
      text: formatRemainingDuration(getTotalRemainingSeconds(this.plugin.data.goals, progress))
    });
  }

  private renderWeek(
    container: HTMLElement,
    week: WeekDayData[],
    analytics: WeeklyAnalytics
  ): void {
    const section = container.createDiv({ cls: "daily-hub-week" });
    section.createEl("h2", { text: "This week", cls: "daily-hub-section-title" });

    const summary = section.createDiv({ cls: "daily-hub-week-summary", attr: { "aria-label": "Weekly summary" } });
    const total = summary.createDiv({ cls: "daily-hub-summary-item" });
    total.createEl("strong", { text: formatDuration(analytics.totalActiveSeconds) });
    total.createEl("span", { text: analytics.unavailableDays > 0 ? "total (partial)" : "total" });
    const average = summary.createDiv({ cls: "daily-hub-summary-item" });
    average.createEl("strong", {
      text: analytics.dailyAverageSeconds === undefined ? "—" : formatDuration(analytics.dailyAverageSeconds)
    });
    average.createEl("span", { text: "daily average" });
    const completed = summary.createDiv({ cls: "daily-hub-summary-item" });
    completed.createEl("strong", { text: `${analytics.completedGoals} / ${analytics.goalOpportunities}` });
    completed.createEl("span", { text: "completed goals" });

    const days = section.createDiv({ cls: "daily-hub-week-days" });

    for (const day of week) {
      const selected = day.key === this.selectedDateKey;
      const button = days.createEl("button", {
        cls: `daily-hub-week-day${selected ? " is-selected" : ""}`,
        attr: {
          "aria-label": new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(day.date),
          ...(selected ? { "aria-current": "date" } : {})
        }
      });
      button.createEl("span", {
        text: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day.date),
        cls: "daily-hub-weekday"
      });
      button.createEl("strong", { text: String(day.date.getDate()) });
      const daySummary = day.progress === undefined
        ? undefined
        : summarizeDay(this.plugin.data.goals, day.progress);
      if (daySummary === undefined) {
        button.createEl("span", { text: "—", cls: "daily-hub-week-stat" });
      } else {
        button.createEl("span", {
          text: formatDuration(daySummary.totalActiveSeconds),
          cls: "daily-hub-week-stat"
        });
        button.createEl("span", {
          text: `${daySummary.completedGoals}/${daySummary.goalCount}`,
          cls: "daily-hub-week-stat daily-hub-muted"
        });
      }
      button.addEventListener("click", () => this.selectDate(day.key));
    }

    this.renderGoalBreakdown(section, analytics.goals);
  }

  private renderGoalBreakdown(container: HTMLElement, goals: GoalWeekStats[]): void {
    container.createEl("h3", { text: "Goal breakdown", cls: "daily-hub-subsection-title" });
    const breakdown = container.createDiv({ cls: "daily-hub-goal-breakdown" });
    const maximum = Math.max(...goals.map((goal) => goal.totalSeconds), 1);
    for (const goal of goals) {
      const item = breakdown.createDiv({ cls: "daily-hub-breakdown-item" });
      const heading = item.createDiv({ cls: "daily-hub-breakdown-heading" });
      heading.createEl("strong", { text: goal.goalName });
      heading.createEl("span", { text: formatDuration(goal.totalSeconds) });
      const track = item.createDiv({ cls: "daily-hub-breakdown-track" });
      track.createDiv({
        cls: "daily-hub-breakdown-bar",
        attr: { style: `width: ${(goal.totalSeconds / maximum) * 100}%` }
      });
    }
  }

  private renderStatus(container: HTMLElement, status: ActivityWatchStatus): void {
    const statusBar = container.createDiv({
      cls: `daily-hub-status is-${status.kind}`,
      attr: { role: "status" }
    });
    const statusText = statusBar.createDiv({ cls: "daily-hub-status-copy" });
    statusText.createEl("strong", {
      text: `${status.kind === "connected" ? "●" : "⚠"} ${status.message}`
    });

    if (status.kind === "offline") {
      statusText.createEl("div", {
        text: "Start ActivityWatch, then refresh.",
        cls: "daily-hub-muted"
      });
      const actions = statusBar.createDiv({ cls: "daily-hub-status-actions" });
      this.externalLinkButton(actions, "Install ActivityWatch", ACTIVITYWATCH_DOWNLOAD_URL, true);
      this.externalLinkButton(actions, "Installation instructions", ACTIVITYWATCH_DOWNLOAD_URL);
      return;
    }

    if (!status.windowWatcherAvailable) {
      statusText.createEl("div", {
        text: "⚠ Window watcher unavailable. Application, window-title, and URL rules require it.",
        cls: "daily-hub-warning"
      });
    }
    if (!status.browserWatcherAvailable) {
      statusText.createEl("div", {
        text: "⚠ Browser watcher unavailable. URL rules cannot match.",
        cls: "daily-hub-warning"
      });
      this.externalLinkButton(statusBar, "Browser watcher instructions", BROWSER_WATCHER_URL);
    }
    if (!status.afkWatcherAvailable) {
      statusText.createEl("div", {
        text: "⚠ AFK watcher unavailable. Idle time cannot be excluded.",
        cls: "daily-hub-warning"
      });
    }
  }

  private externalLinkButton(container: HTMLElement, label: string, url: string, primary = false): void {
    const button = container.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined });
    button.addEventListener("click", () => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  private renderGoal(
    container: HTMLElement,
    goal: DailyGoal,
    progress: GoalProgress,
    week: GoalWeekStats,
    selectedAvailable: boolean,
    future: boolean
  ): void {
    const card = container.createDiv({ cls: "daily-hub-goal" });
    const heading = card.createDiv({ cls: "daily-hub-goal-heading" });
    heading.createEl("h3", { text: goal.name });
    const actions = heading.createDiv({ cls: "daily-hub-goal-actions" });
    const details = actions.createEl("button", { text: "Details", cls: "daily-hub-details-button" });
    details.addEventListener("click", () => {
      const selectedDateKey = this.selectedDateKey;
      new GoalDetailsModal(
        this.plugin,
        goal,
        selectedDateKey,
        week,
        (force) => this.loadGoalWeekStats(goal, selectedDateKey, force)
      ).open();
    });
    const edit = actions.createEl("button", {
      cls: "daily-hub-icon-button",
      attr: { "aria-label": `Edit ${goal.name}`, title: `Edit ${goal.name}` }
    });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => new GoalEditorModal(this.plugin, goal).open());

    if (!selectedAvailable) {
      card.createEl("div", {
        text: future ? "— Future day" : "— Activity unavailable",
        cls: "daily-hub-muted daily-hub-no-activity"
      });
      return;
    }

    const bar = card.createEl("progress", {
      cls: "daily-hub-progress",
      attr: {
        max: "1",
        value: String(progress.progressRatio),
        "aria-label": `${goal.name}: ${Math.floor(progress.actualMinutes)} of ${goal.targetMinutes} minutes`
      }
    });
    bar.max = 1;
    bar.value = progress.progressRatio;

    const summary = card.createDiv({ cls: "daily-hub-goal-summary" });
    const minutes = Math.floor(progress.actualMinutes);
    summary.createEl("strong", { text: `${minutes} / ${goal.targetMinutes} min` });
    if (progress.completed) {
      const complete = summary.createEl("span", { text: "Complete", cls: "daily-hub-complete" });
      setIcon(complete, "check");
      const extra = Math.floor(progress.actualMinutes - goal.targetMinutes);
      if (extra > 0) card.createEl("div", { text: `+${extra} min beyond goal`, cls: "daily-hub-muted" });
    } else {
      const remaining = Math.max(0, Math.ceil(goal.targetMinutes - progress.actualMinutes));
      card.createEl("div", { text: `${remaining} min remaining`, cls: "daily-hub-muted" });
    }
  }

  private async loadGoalWeekStats(
    goal: DailyGoal,
    selectedDateKey: string,
    force: boolean
  ): Promise<GoalWeekStats> {
    const today = new Date();
    const weekDates = getLocalWeek(selectedDateKey);
    const keys = weekDates.map(toLocalDateKey).filter((key) => !isFutureDate(key, today));
    if (force) this.plugin.invalidateActivitySnapshots(keys);
    const results = await Promise.allSettled(keys.map((key) => this.plugin.getActivitySnapshot(key)));
    const snapshots = new Map<string, ActivityWatchSnapshot>();
    results.forEach((result, index) => {
      const key = keys[index];
      if (key !== undefined && result.status === "fulfilled") snapshots.set(key, result.value);
    });
    const days = weekDates.map((date) => {
      const dateKey = toLocalDateKey(date);
      const future = isFutureDate(dateKey, today);
      const snapshot = snapshots.get(dateKey);
      return {
        dateKey,
        future,
        progress: future || snapshot === undefined || snapshot.status.kind === "offline"
          ? undefined
          : calculateDailyProgress([goal], snapshot.activity, dateKey)
      };
    });
    const stats = summarizeWeek([goal], days, selectedDateKey).goals[0];
    if (stats === undefined) throw new Error("Goal details are unavailable");
    return stats;
  }
}
