import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  calculateRangeAnalytics,
  getHeatmapLevel,
  type GoalRangeStats,
  type RangeAnalytics
} from "./analytics";
import {
  formatDuration,
  formatRemainingDuration,
  getDayPlan,
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
  getTrailingLocalDates,
  isFutureDate,
  isToday,
  toLocalDateKey
} from "./date";
import { DayOverrideModal } from "./day-override";
import { GoalEditorModal } from "./goal-editor";
import { GoalDetailsModal, type GoalDetailsStats } from "./goal-details";
import { hasGoalTrackingStartedByDate } from "./goal-lifecycle";
import { LongTermActivityState } from "./long-term-state";
import type DailyHubPlugin from "./main";
import type { ActivityWatchSnapshot, ActivityWatchStatus, DailyGoal, GoalProgress } from "./models";
import { calculateDailyProgress } from "./progress";
import { calculateRangeProgress, type DayActivityInput } from "./range-progress";
import { applyScheduleToProgress, type PlannedGoalProgress } from "./schedule";
import { calculateGoalWeekStats, calculateWeekProgress, type WeekDayActivity } from "./weekly-progress";

export const DAILY_HUB_VIEW_TYPE = "daily-hub-view";
const ACTIVITYWATCH_DOWNLOAD_URL = "https://activitywatch.net/downloads/";
const BROWSER_WATCHER_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-browser";
const LONG_TERM_DAYS = 30;
const RANGE_LOAD_CONCURRENCY = 6;
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
  private readonly longTermActivity = new LongTermActivityState();
  private longTermSection: HTMLElement | undefined;

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
    this.updateLongTermSnapshots(todayKey, snapshots);

    const selectedFuture = isFutureDate(this.selectedDateKey, today);
    const selectedSnapshot = selectedFuture ? undefined : snapshots.get(this.selectedDateKey);
    const selectedProgress = calculateDailyProgress(
      this.plugin.data.goals,
      selectedSnapshot?.activity ?? { windowEvents: [], browserEvents: [], afkEvents: [] },
      this.selectedDateKey
    );
    const weekActivity = weekDates.map((date): WeekDayActivity => {
      const key = toLocalDateKey(date);
      const future = isFutureDate(key, today);
      const snapshot = snapshots.get(key);
      return {
        dateKey: key,
        future,
        activity: future || snapshot === undefined || snapshot.status.kind === "offline"
          ? undefined
          : snapshot.activity
      };
    });
    const weekProgress = calculateWeekProgress(this.plugin.data.goals, weekActivity);
    const week = weekProgress.map((day): WeekDayData => ({
      key: day.dateKey,
      date: getLocalDateRange(day.dateKey).start,
      future: day.future,
      progress: day.progress
    }));

    const weeklyAnalytics = summarizeWeek(
      this.plugin.data.goals,
      weekProgress,
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

    if (this.plugin.data.goals.some((goal) => goal.enabled)) {
      void this.ensureLongTermActivity(todayKey).then(() => {
        if (todayKey === toLocalDateKey(new Date())) this.renderLongTermContent(today);
      });
    }

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

    const daySummary = summarizeDay(this.plugin.data.goals, progress, this.selectedDateKey);
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
    } else if (daySummary.goalCount === 0) {
      container.createEl("div", {
        text: daySummary.trackedGoalCount === 0 ? "Not tracked yet" : "No goals scheduled",
        cls: "daily-hub-rest-day"
      });
    }

    this.renderStatus(container, status);
    this.renderDayPlan(container, date, today, progress, selectedAvailable, future);
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
      const progressByGoal = new Map(
        applyScheduleToProgress(this.plugin.data.goals, progress, this.selectedDateKey)
          .map((item) => [item.goalId, item])
      );
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
    this.longTermSection = container.createDiv({ cls: "daily-hub-long-term" });
    this.renderLongTermContent(today);
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

  private renderDayPlan(
    container: HTMLElement,
    date: Date,
    today: Date,
    progress: GoalProgress[],
    selectedAvailable: boolean,
    future: boolean
  ): void {
    const section = container.createDiv({ cls: "daily-hub-remaining" });
    const heading = isToday(this.selectedDateKey, today)
      ? "Today Plan"
      : `Plan for ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
    section.createEl("h2", { text: heading, cls: "daily-hub-section-title" });

    const plan = getDayPlan(this.plugin.data.goals, progress, this.selectedDateKey);
    if (plan.length === 0) {
      const hasTrackedGoals = this.plugin.data.goals.some((goal) => (
        goal.enabled && hasGoalTrackingStartedByDate(goal, this.selectedDateKey)
      ));
      section.createEl("p", {
        text: hasTrackedGoals ? "No goals scheduled" : "Not tracked yet",
        cls: "daily-hub-rest-day"
      });
      return;
    }

    const list = section.createDiv({ cls: "daily-hub-remaining-list" });
    for (const item of plan) {
      const row = list.createDiv({
        cls: `daily-hub-remaining-row${item.completed ? " is-complete" : ""}`
      });
      const copy = row.createDiv({ cls: "daily-hub-plan-copy" });
      copy.createEl("strong", { text: `${item.completed ? "✓ " : ""}${item.name}` });
      copy.createEl("span", {
        text: selectedAvailable
          ? `${Math.floor(item.actualMinutes)} / ${item.targetMinutes} min`
          : `Planned: ${item.targetMinutes} min`,
        cls: "daily-hub-muted"
      });
      row.createEl("strong", {
        text: item.completed
          ? "Complete"
          : selectedAvailable || future
            ? `${formatRemainingDuration(item.remainingSeconds)} remaining`
            : "Activity unavailable"
      });
    }
    if (selectedAvailable || future) {
      const total = section.createDiv({ cls: "daily-hub-remaining-total" });
      total.createEl("span", { text: "Total remaining" });
      total.createEl("strong", {
        text: formatRemainingDuration(getTotalRemainingSeconds(
          this.plugin.data.goals,
          progress,
          this.selectedDateKey
        ))
      });
    }
    const next = plan.find((item) => !item.completed);
    if (next !== undefined) {
      section.createEl("p", { text: `Next suggested: ${next.name}`, cls: "daily-hub-muted" });
    }
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
        : summarizeDay(this.plugin.data.goals, day.progress, day.key);
      if (daySummary === undefined) {
        button.createEl("span", { text: "—", cls: "daily-hub-week-stat" });
      } else {
        button.createEl("span", {
          text: formatDuration(daySummary.totalActiveSeconds),
          cls: "daily-hub-week-stat"
        });
        button.createEl("span", {
          text: daySummary.trackedGoalCount === 0
            ? "Not tracked"
            : daySummary.goalCount === 0
            ? "Rest"
            : `${daySummary.completedGoals}/${daySummary.goalCount}`,
          cls: "daily-hub-week-stat daily-hub-muted"
        });
      }
      button.addEventListener("click", () => this.selectDate(day.key));
    }

    this.renderGoalBreakdown(section, analytics.goals);
  }

  private renderLongTermContent(today: Date): void {
    const section = this.longTermSection;
    if (section === undefined) return;
    section.empty();
    section.createEl("h2", { text: "Last 30 days", cls: "daily-hub-section-title" });
    section.createEl("div", { text: "Ending Today", cls: "daily-hub-kicker" });

    const enabledGoals = this.plugin.data.goals.filter((goal) => goal.enabled);
    if (enabledGoals.length === 0) {
      section.createEl("p", { text: "Add goals to see long-term analytics.", cls: "daily-hub-muted" });
      return;
    }

    const analytics = this.getLongTermAnalytics(toLocalDateKey(today));
    if (analytics === undefined) {
      section.createEl("p", { text: "Loading analytics…", cls: "daily-hub-muted", attr: { role: "status" } });
      return;
    }
    if (analytics.availableDays === 0) {
      section.createEl("p", { text: "30-day analytics unavailable", cls: "daily-hub-muted", attr: { role: "status" } });
      this.renderHeatmap(section, analytics);
      return;
    }

    const summary = section.createDiv({
      cls: "daily-hub-long-term-summary",
      attr: { "aria-label": "Last 30 days summary" }
    });
    this.renderLongTermMetric(summary, formatDuration(analytics.totalSeconds), "studied");
    this.renderLongTermMetric(
      summary,
      analytics.averageSeconds === undefined ? "—" : formatDuration(analytics.averageSeconds),
      "daily average"
    );
    this.renderLongTermMetric(summary, String(analytics.activeDays), "active days");
    this.renderLongTermMetric(
      summary,
      analytics.completionRate === undefined ? "—" : `${Math.round(analytics.completionRate * 100)}%`,
      "goal completion"
    );

    if (analytics.availableDays < LONG_TERM_DAYS) {
      section.createEl("p", {
        text: `Partial data: ${analytics.availableDays} of ${LONG_TERM_DAYS} days available`,
        cls: "daily-hub-muted"
      });
    }

    this.renderHeatmap(section, analytics);
    this.renderGoalConsistency(section, analytics.goals);
  }

  private renderLongTermMetric(container: HTMLElement, value: string, label: string): void {
    const metric = container.createDiv({ cls: "daily-hub-summary-item" });
    metric.createEl("strong", { text: value });
    metric.createEl("span", { text: label });
  }

  private renderHeatmap(container: HTMLElement, analytics: RangeAnalytics): void {
    container.createEl("h3", { text: "Daily completion", cls: "daily-hub-subsection-title" });
    const scroll = container.createDiv({ cls: "daily-hub-heatmap-scroll" });
    const heatmap = scroll.createDiv({ cls: "daily-hub-heatmap", attr: { "aria-label": "30-day goal completion heatmap" } });
    for (const day of analytics.days) {
      const date = getLocalDateRange(day.dateKey).start;
      const dateLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
      const selected = day.dateKey === this.selectedDateKey;
      const notTracked = day.trackedGoalCount === 0;
      const restDay = !notTracked && day.goalCount === 0;
      const neutral = notTracked || restDay;
      const ratio = day.progressRatio;
      const available = day.available && ratio !== undefined;
      const details = notTracked
        ? "No goals existed yet"
        : restDay
        ? "No goals scheduled"
        : available
        ? `${formatDuration(day.totalSeconds ?? 0)} studied, ${day.completedGoals ?? 0} of ${day.goalCount} goals completed, ${Math.round(ratio * 100)}% planned progress`
        : "Activity data unavailable";
      const label = `${dateLabel}: ${details}`;
      const button = heatmap.createEl("button", {
        text: available ? "" : neutral ? "·" : "—",
        cls: `daily-hub-heatmap-cell${available ? ` is-level-${getHeatmapLevel(ratio)}` : neutral ? " is-rest" : " is-unavailable"}${selected ? " is-selected" : ""}`,
        attr: {
          "aria-label": label,
          title: label,
          ...(selected ? { "aria-current": "date" } : {})
        }
      });
      button.disabled = !available && !neutral;
      if (available || neutral) button.addEventListener("click", () => this.selectDate(day.dateKey));
    }
  }

  private renderGoalConsistency(container: HTMLElement, goals: GoalRangeStats[]): void {
    container.createEl("h3", { text: "Goal consistency", cls: "daily-hub-subsection-title" });
    const list = container.createDiv({ cls: "daily-hub-consistency" });
    for (const goal of goals) {
      const card = list.createDiv({ cls: "daily-hub-consistency-card" });
      const heading = card.createDiv({ cls: "daily-hub-consistency-heading" });
      heading.createEl("strong", { text: goal.goalName });
      heading.createEl("span", { text: formatDuration(goal.totalSeconds), cls: "daily-hub-muted" });
      card.createEl("div", {
        text: `${goal.completedDays} / ${goal.availableDays} scheduled days completed`,
        cls: "daily-hub-consistency-completion"
      });
      card.createEl("div", {
        text: `Current streak ${goal.currentStreak} days · Best ${goal.bestStreak} days`,
        cls: "daily-hub-muted"
      });
    }
  }

  private getLongTermAnalytics(todayKey: string): RangeAnalytics | undefined {
    const days = this.longTermActivity.get(
      todayKey,
      this.plugin.data.settings.activityWatchUrl
    );
    if (days === undefined) return undefined;
    return calculateRangeAnalytics(
      this.plugin.data.goals,
      calculateRangeProgress(this.plugin.data.goals, days)
    );
  }

  private updateLongTermSnapshots(
    todayKey: string,
    snapshots: Map<string, ActivityWatchSnapshot>
  ): void {
    const activityWatchUrl = this.plugin.data.settings.activityWatchUrl;
    const days = this.longTermActivity.get(todayKey, activityWatchUrl);
    if (days === undefined) return;
    const updates = days.flatMap((day): DayActivityInput[] => {
      const snapshot = snapshots.get(day.dateKey);
      return snapshot === undefined ? [] : [{
        dateKey: day.dateKey,
        future: false,
        activity: snapshot.status.kind === "connected" ? snapshot.activity : undefined
      }];
    });
    this.longTermActivity.merge(todayKey, activityWatchUrl, updates);
  }

  private mergeLongTermActivity(days: DayActivityInput[]): void {
    this.longTermActivity.merge(
      toLocalDateKey(new Date()),
      this.plugin.data.settings.activityWatchUrl,
      days
    );
  }

  private ensureLongTermActivity(todayKey: string): Promise<DayActivityInput[]> {
    const activityWatchUrl = this.plugin.data.settings.activityWatchUrl;
    const keys = getTrailingLocalDates(todayKey, LONG_TERM_DAYS).map(toLocalDateKey);
    return this.longTermActivity.ensure(
      keys,
      todayKey,
      activityWatchUrl,
      async (dateKey) => {
        const snapshot = await this.plugin.getActivitySnapshot(dateKey);
        return snapshot.status.kind === "connected" ? snapshot.activity : undefined;
      },
      RANGE_LOAD_CONCURRENCY
    );
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
    progress: PlannedGoalProgress,
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
        selectedDateKey,
        {
          week,
          range: this.getLongTermAnalytics(toLocalDateKey(new Date()))?.goals
            .find((item) => item.goalId === goal.id)
        },
        (force) => this.loadGoalDetailsStats(goal.id, selectedDateKey, force)
      ).open();
    });
    const edit = actions.createEl("button", {
      cls: "daily-hub-icon-button",
      attr: { "aria-label": `Edit ${goal.name}`, title: `Edit ${goal.name}` }
    });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => new GoalEditorModal(this.plugin, goal).open());

    const adjust = actions.createEl("button", {
      text: "Adjust this day",
      cls: "daily-hub-details-button"
    });
    adjust.addEventListener("click", () => {
      new DayOverrideModal(this.plugin, goal, this.selectedDateKey).open();
    });

    if (!progress.trackingStarted) {
      card.createEl("div", {
        text: "Not tracked yet",
        cls: "daily-hub-rest-day daily-hub-no-activity"
      });
      return;
    }

    if (!progress.scheduled) {
      card.createEl("div", {
        text: progress.skipped ? "Skipped" : "Rest day",
        cls: "daily-hub-rest-day daily-hub-no-activity"
      });
      if (selectedAvailable && progress.activeSeconds > 0) {
        card.createEl("div", {
          text: `${formatDuration(progress.activeSeconds)} activity`,
          cls: "daily-hub-muted daily-hub-no-activity"
        });
      }
      return;
    }

    if (!selectedAvailable) {
      card.createEl("div", {
        text: future ? `Planned: ${progress.targetMinutes} min` : `Activity unavailable · target ${progress.targetMinutes} min`,
        cls: "daily-hub-muted daily-hub-no-activity"
      });
      return;
    }

    const bar = card.createEl("progress", {
      cls: "daily-hub-progress",
      attr: {
        max: "1",
        value: String(progress.progressRatio ?? 0),
        "aria-label": `${goal.name}: ${Math.floor(progress.actualMinutes)} of ${progress.targetMinutes} minutes`
      }
    });
    bar.max = 1;
    bar.value = progress.progressRatio ?? 0;

    const summary = card.createDiv({ cls: "daily-hub-goal-summary" });
    const minutes = Math.floor(progress.actualMinutes);
    summary.createEl("strong", { text: `${minutes} / ${progress.targetMinutes} min` });
    if (progress.completed) {
      const complete = summary.createEl("span", { text: "Complete", cls: "daily-hub-complete" });
      setIcon(complete, "check");
      const extra = Math.floor(progress.actualMinutes - progress.targetMinutes);
      if (extra > 0) card.createEl("div", { text: `+${extra} min beyond goal`, cls: "daily-hub-muted" });
    } else {
      const remaining = Math.max(0, Math.ceil(progress.targetMinutes - progress.actualMinutes));
      card.createEl("div", { text: `${remaining} min remaining`, cls: "daily-hub-muted" });
    }
  }

  private async loadGoalWeekStats(
    goalId: string,
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
    const days = weekDates.map((date): WeekDayActivity => {
      const dateKey = toLocalDateKey(date);
      const future = isFutureDate(dateKey, today);
      const snapshot = snapshots.get(dateKey);
      return {
        dateKey,
        future,
        activity: future || snapshot === undefined || snapshot.status.kind === "offline"
          ? undefined
          : snapshot.activity
      };
    });
    this.mergeLongTermActivity(days);
    const stats = calculateGoalWeekStats(
      this.plugin.data.goals,
      goalId,
      days,
      selectedDateKey
    );
    if (stats === undefined) throw new Error("Goal details are unavailable");
    return stats;
  }

  private async loadGoalDetailsStats(
    goalId: string,
    selectedDateKey: string,
    force: boolean
  ): Promise<GoalDetailsStats> {
    const todayKey = toLocalDateKey(new Date());
    const week = await this.loadGoalWeekStats(goalId, selectedDateKey, force);
    await this.ensureLongTermActivity(todayKey);
    const range = this.getLongTermAnalytics(todayKey)?.goals.find((goal) => goal.goalId === goalId);
    return { week, range };
  }
}
