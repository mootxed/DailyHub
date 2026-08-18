import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  calculateRangeAnalytics,
  type GoalRangeStats,
  type RangeAnalytics
} from "./analytics";
import { ActivityDetailsModal } from "./activity-details";
import {
  activityForUnavailableDate,
  calculateComputerActivity,
  calculateComputerActivityRange
} from "./activity-analysis";
import type { ComputerActivityRange, DailyComputerActivity } from "./activity-models";
import { getGoalColor } from "./activity-chart";
import {
  formatDuration,
  formatRemainingDuration,
  getDashboardPresentationState,
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
import { TrackingDiagnosticsModal } from "./diagnostics-view";
import { GoalEditorModal } from "./goal-editor";
import { GoalDetailsModal, type GoalDetailsStats } from "./goal-details";
import { hasGoalTrackingStartedByDate, isGoalPaused } from "./goal-lifecycle";
import {
  formatCurrentSessionDuration,
  getGoalRuntimeUiState,
  type GoalProgressState
} from "./goal-runtime-ui";
import { LongTermActivityState } from "./long-term-state";
import type DailyHubPlugin from "./main";
import type {
  ActivityWatchSnapshot,
  ActivityWatchStatus,
  DailyGoal,
  DayActivity,
  GoalProgress
} from "./models";
import { BROWSER_CONTEXT_GRACE_MS, calculateDailyProgress, resolveLiveTrackingState } from "./progress";
import { calculateRangeProgress, type DayActivityInput } from "./range-progress";
import { applyScheduleToProgress, type PlannedGoalProgress } from "./schedule";
import { calculateGoalWeekStats, calculateWeekProgress, type WeekDayActivity } from "./weekly-progress";
import { renderActivityChartView, type ActivityChartMode } from "./view/activity-chart-view";
import {
  renderActivityBreakdownView,
  type ActivityBreakdownMode
} from "./view/activity-breakdown-view";
import {
  renderActivityHeatmap,
  renderCalendarHeatmap,
  renderGoalConsistencyView
} from "./view/analytics-view";
import { renderDayTimelineView, type DayTimelineMode } from "./view/day-timeline-view";

export const DAILY_HUB_VIEW_TYPE = "daily-hub-view";
const ACTIVITYWATCH_DOWNLOAD_URL = "https://activitywatch.net/downloads/";
const BROWSER_WATCHER_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-browser";
const LONG_TERM_DAYS = 30;
const RANGE_LOAD_CONCURRENCY = 6;
const LIVE_POLL_INTERVAL_MS = 5_000;
const LIVE_MIN_LOOKBACK_MS = 5 * 60_000;
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
  computerActivity: DailyComputerActivity;
}

interface GoalRuntimeElements {
  card: HTMLElement;
  status: HTMLElement;
  actualTime?: HTMLElement;
  compactTime?: string;
  liveEligible: boolean;
  progressShell?: HTMLElement;
  pauseButton?: HTMLButtonElement;
  pauseIcon?: HTMLElement;
  pauseLabel?: HTMLElement;
}

export class DailyHubView extends ItemView {
  private readonly plugin: DailyHubPlugin;
  private refreshSequence = 0;
  private selectedDateKey = toLocalDateKey(new Date());
  private hasRendered = false;
  private refreshButton: HTMLButtonElement | undefined;
  private readonly longTermActivity = new LongTermActivityState();
  private longTermSection: HTMLElement | undefined;
  private readonly goalRuntimeElements = new Map<string, GoalRuntimeElements>();
  private livePollTimer: number | undefined;
  private livePollSequence = 0;
  private livePollInFlight = false;
  private viewOpen = false;
  private selectedActivityAvailable = false;
  private todayActivity: DayActivity | undefined;
  private readonly hiddenChartGoalIds = new Set<string>();
  private readonly hiddenChartAppIds = new Set<string>();
  private readonly hiddenChartCategoryIds = new Set<string>();
  private activityChartMode: ActivityChartMode = "goals";
  private activityBreakdownMode: ActivityBreakdownMode = "apps";
  private dayTimelineMode: DayTimelineMode = "apps";
  private heatmapMode: "completion" | "activity" = "completion";
  private noGoalDefaultsApplied = false;

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
    this.viewOpen = true;
    await this.refresh();
  }

  override onClose(): Promise<void> {
    this.viewOpen = false;
    this.stopLivePolling();
    this.goalRuntimeElements.clear();
    return Promise.resolve();
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
    const todaySnapshot = snapshots.get(todayKey);
    this.todayActivity = todaySnapshot?.status.kind === "connected" ? todaySnapshot.activity : undefined;

    const selectedFuture = isFutureDate(this.selectedDateKey, today);
    const selectedSnapshot = selectedFuture ? undefined : snapshots.get(this.selectedDateKey);
    const selectedProgress = calculateDailyProgress(
      this.plugin.data.goals,
      selectedSnapshot?.activity ?? { windowEvents: [], browserEvents: [], afkEvents: [] },
      this.selectedDateKey
    );
    const selectedComputerActivity = selectedSnapshot?.status.kind === "connected"
      && selectedSnapshot.status.windowWatcherAvailable
      ? calculateComputerActivity(
        selectedSnapshot.activity,
        this.selectedDateKey,
        this.plugin.data.activityCategories
      )
      : activityForUnavailableDate(this.selectedDateKey);
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
      progress: day.progress,
      computerActivity: (() => {
        const snapshot = snapshots.get(day.dateKey);
        return !day.future && snapshot?.status.kind === "connected" && snapshot.status.windowWatcherAvailable
          ? calculateComputerActivity(snapshot.activity, day.dateKey, this.plugin.data.activityCategories)
          : activityForUnavailableDate(day.dateKey);
      })()
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
      selectedComputerActivity,
      selectedFuture,
      selectedSnapshot?.status.kind === "connected"
    );
    this.hasRendered = true;

    void this.ensureLongTermActivity(todayKey).then(() => {
      if (todayKey === toLocalDateKey(new Date())) this.renderLongTermContent(today);
    });

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
    this.goalRuntimeElements.clear();
    const loading = container.createDiv({ cls: "daily-hub-loading", attr: { role: "status" } });
    const header = loading.createDiv({ cls: "daily-hub-loading-header" });
    header.createDiv({ cls: "daily-hub-loading-line is-title" });
    header.createDiv({ cls: "daily-hub-loading-line is-action" });
    loading.createDiv({ cls: "daily-hub-loading-line is-navigator" });
    const dashboard = loading.createDiv({ cls: "daily-hub-loading-dashboard" });
    dashboard.createDiv({ cls: "daily-hub-loading-line is-overview" });
    dashboard.createDiv({ cls: "daily-hub-loading-line is-plan" });
    loading.createDiv({ cls: "daily-hub-loading-line is-goal" });
    loading.createDiv({ cls: "daily-hub-loading-line is-goal" });
    loading.createDiv({ cls: "daily-hub-loading-line is-analytics" });
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
    computerActivity: DailyComputerActivity,
    future: boolean,
    selectedAvailable: boolean
  ): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("daily-hub-view");
    this.goalRuntimeElements.clear();
    this.selectedActivityAvailable = selectedAvailable;

    const enabledGoals = this.plugin.data.goals.filter((goal) => goal.enabled);
    const presentation = getDashboardPresentationState(enabledGoals.length);
    if (!presentation.hasGoals && !this.noGoalDefaultsApplied) {
      this.activityChartMode = presentation.defaultActivityChartMode;
      this.heatmapMode = presentation.defaultHeatmapMode;
      this.noGoalDefaultsApplied = true;
    } else if (presentation.hasGoals) this.noGoalDefaultsApplied = false;
    const daySummary = summarizeDay(this.plugin.data.goals, progress, this.selectedDateKey);
    const plannedProgress = applyScheduleToProgress(this.plugin.data.goals, progress, this.selectedDateKey);
    const bento = container.createDiv({
      cls: `daily-hub-bento${presentation.hasGoals ? "" : " is-no-goals"}`
    });

    const header = bento.createDiv({ cls: "daily-hub-header daily-hub-bento-header" });
    const headerTop = header.createDiv({ cls: "daily-hub-header-top" });
    const brand = headerTop.createDiv({ cls: "daily-hub-brand" });
    brand.createEl("h1", { text: "Daily Hub" });
    brand.createEl("p", { text: "Your activity dashboard" });
    const headerActions = headerTop.createDiv({ cls: "daily-hub-header-actions" });
    this.refreshButton = headerActions.createEl("button", {
      cls: "daily-hub-icon-button",
      attr: { "aria-label": "Refresh Daily Hub", title: "Refresh" }
    });
    setIcon(this.refreshButton, "refresh-cw");
    this.refreshButton.addEventListener("click", () => { void this.refresh(true); });
    const add = headerActions.createEl("button", { cls: "daily-hub-primary-button" });
    const addIcon = add.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(addIcon, "plus");
    add.createSpan({ text: "Add goal" });
    add.addEventListener("click", () => new GoalEditorModal(this.plugin).open());

    const hud = header.createDiv({
      cls: `daily-hub-header-hud${presentation.hasGoals ? "" : " is-no-goals"}`,
      attr: { "aria-label": "Daily Hub status" }
    });
    this.renderHudMetric(hud, computerActivity.available
      ? formatDuration(computerActivity.activeComputerSeconds) : "—", "active");
    if (presentation.hasGoals) {
      this.renderHudMetric(hud, selectedAvailable ? formatDuration(daySummary.totalActiveSeconds) : "—", "goals");
      this.renderHudMetric(
        hud,
        selectedAvailable ? `${daySummary.completedGoals} / ${daySummary.goalCount}` : "—",
        "done"
      );
    }
    const connection = hud.createDiv({ cls: `daily-hub-hud-status is-${status.kind}` });
    connection.createEl("span", { cls: "daily-hub-status-dot", attr: { "aria-hidden": "true" } });
    const connectionCopy = connection.createDiv();
    connectionCopy.createEl("span", { text: "ActivityWatch" });
    connectionCopy.createEl("strong", { text: status.kind === "connected" ? "Connected" : "Offline" });

    this.renderDateNavigator(bento, today);

    const overview = bento.createDiv({ cls: "daily-hub-day-overview daily-hub-bento-day" });
    const dayHeader = overview.createDiv({ cls: "daily-hub-day-header" });
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

    const summary = overview.createDiv({ cls: "daily-hub-summary", attr: { "aria-label": "Daily summary" } });
    const active = summary.createDiv({ cls: "daily-hub-summary-item" });
    active.createEl("strong", {
      text: computerActivity.available ? formatDuration(computerActivity.activeComputerSeconds) : "—"
    });
    active.createEl("span", { text: "active computer" });
    if (presentation.hasGoals) {
      const goalTracking = summary.createDiv({ cls: "daily-hub-summary-item" });
      goalTracking.createEl("strong", {
        text: selectedAvailable ? formatDuration(daySummary.totalActiveSeconds) : "—"
      });
      goalTracking.createEl("span", {
        text: "goal tracking",
        attr: { title: "Goal tracking may overlap foreground computer activity, for example while a passive browser goal continues in the background." }
      });
      const completed = summary.createDiv({ cls: "daily-hub-summary-item" });
      completed.createEl("strong", {
        text: selectedAvailable ? `${daySummary.completedGoals} / ${daySummary.goalCount}` : "—"
      });
      completed.createEl("span", { text: "goals completed" });
    }
    if (selectedAvailable && daySummary.goalCount > 0 && daySummary.completedGoals === daySummary.goalCount) {
      const complete = overview.createDiv({ cls: "daily-hub-all-complete" });
      const completeIcon = complete.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(completeIcon, "check-circle-2");
      complete.createSpan({ text: "All goals completed" });
    } else if (presentation.hasGoals && daySummary.goalCount === 0) {
      overview.createEl("div", {
        text: daySummary.trackedGoalCount === 0 ? "Not tracked yet" : "No goals scheduled",
        cls: "daily-hub-rest-day"
      });
    }

    if (selectedAvailable && daySummary.goalCount > 0) {
      const aggregateTarget = plannedProgress
        .filter((item) => item.scheduled && item.trackingStarted)
        .reduce((total, item) => total + item.targetMinutes, 0);
      const aggregateActual = plannedProgress
        .filter((item) => item.scheduled && item.trackingStarted)
        .reduce((total, item) => total + Math.min(item.actualMinutes, item.targetMinutes), 0);
      if (aggregateTarget > 0) {
        const ratio = Math.min(aggregateActual / aggregateTarget, 1);
        const progressBar = overview.createEl("progress", {
          cls: "daily-hub-progress daily-hub-overview-progress",
          attr: { max: "1", value: String(ratio), "aria-label": `Daily goal progress: ${Math.round(ratio * 100)}%` }
        });
        progressBar.max = 1;
        progressBar.value = ratio;
      }
    }

    this.renderDayPlan(bento, date, today, progress, selectedAvailable, future);
    if (status.kind === "offline" || !status.windowWatcherAvailable
      || !status.browserWatcherAvailable || !status.afkWatcherAvailable) {
      this.renderStatus(bento, status);
    }

    renderActivityBreakdownView(bento, {
      activity: computerActivity,
      mode: this.activityBreakdownMode,
      categories: this.plugin.data.activityCategories,
      available: computerActivity.available,
      setMode: (mode) => {
        this.activityBreakdownMode = mode;
        void this.refresh();
      },
      openDetails: (item, mode) => new ActivityDetailsModal(this.plugin, computerActivity, item, mode).open()
    });

    const goalsTile = bento.createDiv({ cls: "daily-hub-bento-goals daily-hub-panel" });
    const goalsHeader = goalsTile.createDiv({ cls: "daily-hub-section-heading" });
    goalsHeader.createEl("div", { text: "Current actions", cls: "daily-hub-kicker" });
    goalsHeader.createEl("h2", { text: "Goals", cls: "daily-hub-section-title" });

    if (enabledGoals.length === 0) {
      goalsTile.addClass("is-empty");
      const empty = goalsTile.createDiv({ cls: "daily-hub-empty is-compact" });
      empty.createEl("h3", { text: "No goals yet" });
      empty.createEl("p", { text: "Track recurring activities automatically." });
      const emptyAdd = empty.createEl("button", { cls: "daily-hub-primary-button" });
      const emptyAddIcon = emptyAdd.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(emptyAddIcon, "plus");
      emptyAdd.createSpan({ text: "Add goal" });
      emptyAdd.addEventListener("click", () => new GoalEditorModal(this.plugin).open());
    } else {
      const goals = goalsTile.createDiv({
        cls: `daily-hub-goals${enabledGoals.length === 1 ? " is-single-goal" : ""}`
      });
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

    renderDayTimelineView(bento, {
      activity: computerActivity,
      categories: this.plugin.data.activityCategories,
      mode: this.dayTimelineMode,
      setMode: (mode) => {
        this.dayTimelineMode = mode;
        void this.refresh();
      },
      openDetails: (item, mode) => new ActivityDetailsModal(this.plugin, computerActivity, item, mode).open()
    });

    const analyticsLayout = bento.createDiv({ cls: "daily-hub-bento-analytics" });
    this.renderActivityChart(analyticsLayout, week);
    const analyticsRail = analyticsLayout.createDiv({ cls: "daily-hub-analytics-rail" });
    this.renderWeek(analyticsRail, week, weeklyAnalytics);
    if (presentation.showGoalAnalytics) {
      const breakdown = analyticsRail.createDiv({ cls: "daily-hub-bento-breakdown daily-hub-panel" });
      const breakdownHeading = breakdown.createDiv({ cls: "daily-hub-section-heading" });
      breakdownHeading.createEl("div", { text: "This week", cls: "daily-hub-kicker" });
      breakdownHeading.createEl("h2", { text: "Goal breakdown", cls: "daily-hub-section-title" });
      this.renderGoalBreakdown(breakdown, weeklyAnalytics.goals, false);
    }
    this.longTermSection = bento.createDiv({ cls: "daily-hub-long-term" });
    this.renderLongTermContent(today);
    this.updateGoalRuntimeStates();
    this.syncLivePolling(status.kind === "connected" && selectedAvailable);
  }

  private renderHudMetric(container: HTMLElement, value: string, label: string): void {
    const metric = container.createDiv({ cls: "daily-hub-hud-metric" });
    metric.createEl("strong", { text: value });
    metric.createEl("span", { text: label });
  }

  private renderDateNavigator(container: HTMLElement, today: Date): void {
    const tile = container.createDiv({ cls: "daily-hub-bento-navigation" });
    const wrapper = tile.createDiv({ cls: "daily-hub-date-navigation" });
    const previous = wrapper.createEl("button", {
      cls: "daily-hub-date-arrow daily-hub-icon-button",
      attr: { "aria-label": "Previous week", title: "Previous week" }
    });
    setIcon(previous, "chevron-left");
    previous.addEventListener("click", () => this.selectDate(toLocalDateKey(addLocalDays(this.selectedDateKey, -7))));

    const days = wrapper.createDiv({ cls: "daily-hub-date-days" });
    for (const item of getDateNavigator(this.selectedDateKey, today)) {
      const button = days.createEl("button", {
        cls: `daily-hub-date-button${item.selected ? " is-selected" : ""}${item.today ? " is-today" : ""}${isFutureDate(item.key, today) ? " is-future" : ""}`,
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
      const todayButton = tile.createEl("button", { text: "Today", cls: "daily-hub-today-button" });
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
    const section = container.createDiv({ cls: "daily-hub-remaining daily-hub-bento-plan" });
    const heading = isToday(this.selectedDateKey, today)
      ? "Today Plan"
      : `Plan for ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
    section.createEl("h2", { text: heading, cls: "daily-hub-section-title" });

    if (!this.plugin.data.goals.some((goal) => goal.enabled)) {
      const empty = section.createDiv({ cls: "daily-hub-plan-empty" });
      empty.createEl("strong", { text: "No goals planned" });
      empty.createEl("span", { text: "Add a goal to start tracking recurring activities.", cls: "daily-hub-muted" });
      const add = empty.createEl("button", {
        text: "Add goal →",
        cls: "daily-hub-text-action",
        attr: { type: "button" }
      });
      add.addEventListener("click", () => new GoalEditorModal(this.plugin).open());
      return;
    }

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

    const dayComplete = selectedAvailable && plan.every((item) => item.completed);
    section.toggleClass("is-complete", dayComplete);
    if (dayComplete) {
      const complete = section.createDiv({ cls: "daily-hub-plan-complete" });
      const completeIcon = complete.createDiv({ cls: "daily-hub-plan-complete-icon", attr: { "aria-hidden": "true" } });
      setIcon(completeIcon, "check-circle-2");
      const copy = complete.createDiv();
      copy.createEl("strong", { text: "Day complete" });
      copy.createEl("span", { text: "All scheduled goals are done", cls: "daily-hub-muted" });
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
    const planFooter = section.createDiv({ cls: "daily-hub-plan-footer" });
    if (selectedAvailable || future) {
      const total = planFooter.createDiv({ cls: "daily-hub-remaining-total" });
      total.createEl("span", { text: "Remaining" });
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
      const nextRow = planFooter.createDiv({ cls: "daily-hub-remaining-total" });
      nextRow.createEl("span", { text: "Next up" });
      nextRow.createEl("strong", { text: next.name });
    }
  }

  private renderWeek(
    container: HTMLElement,
    week: WeekDayData[],
    analytics: WeeklyAnalytics
  ): void {
    const hasGoals = this.plugin.data.goals.some((goal) => goal.enabled);
    const section = container.createDiv({ cls: "daily-hub-week daily-hub-panel daily-hub-bento-week" });
    const heading = section.createDiv({ cls: "daily-hub-section-heading" });
    heading.createEl("div", { text: "Progress", cls: "daily-hub-kicker" });
    heading.createEl("h2", { text: "This week", cls: "daily-hub-section-title" });

    const summary = section.createDiv({ cls: "daily-hub-week-summary", attr: { "aria-label": "Weekly summary" } });
    const computer = calculateComputerActivityRange(week.map((day) => day.computerActivity));
    const computerTotal = summary.createDiv({ cls: "daily-hub-summary-item" });
    computerTotal.createEl("strong", {
      text: computer.availableDays > 0 ? formatDuration(computer.totalSeconds) : "—"
    });
    computerTotal.createEl("span", { text: "active computer" });
    if (hasGoals) {
      const total = summary.createDiv({ cls: "daily-hub-summary-item" });
      total.createEl("strong", { text: formatDuration(analytics.totalActiveSeconds) });
      total.createEl("span", { text: analytics.unavailableDays > 0 ? "goal tracking (partial)" : "goal tracking" });
      const average = summary.createDiv({ cls: "daily-hub-summary-item" });
      average.createEl("strong", {
        text: analytics.dailyAverageSeconds === undefined ? "—" : formatDuration(analytics.dailyAverageSeconds)
      });
      average.createEl("span", { text: "daily average" });
      const completed = summary.createDiv({ cls: "daily-hub-summary-item" });
      completed.createEl("strong", { text: `${analytics.completedGoals} / ${analytics.goalOpportunities}` });
      completed.createEl("span", { text: "completed goals" });
    } else {
      const average = summary.createDiv({ cls: "daily-hub-summary-item" });
      average.createEl("strong", {
        text: computer.averageSeconds === undefined ? "—" : formatDuration(computer.averageSeconds)
      });
      average.createEl("span", { text: "daily active average" });
      const top = summary.createDiv({ cls: "daily-hub-summary-item" });
      top.createEl("strong", { text: computer.topApplication?.label ?? "—" });
      top.createEl("span", { text: "top app" });
    }

    const days = section.createDiv({ cls: "daily-hub-week-days" });

    for (const day of week) {
      const selected = day.key === this.selectedDateKey;
      const daySummary = day.progress === undefined
        ? undefined
        : summarizeDay(this.plugin.data.goals, day.progress, day.key);
      const dayState = day.future
        ? "is-future"
        : !day.computerActivity.available
        ? "is-unavailable"
        : !hasGoals
        ? day.computerActivity.activeComputerSeconds > 0 ? "is-partial" : "is-rest"
        : daySummary === undefined
        ? "is-unavailable"
        : daySummary.trackedGoalCount === 0 || daySummary.goalCount === 0
        ? "is-rest"
        : daySummary.completedGoals === daySummary.goalCount
        ? "is-complete"
        : daySummary.completedGoals > 0 || daySummary.totalActiveSeconds > 0
        ? "is-partial"
        : "is-missed";
      const button = days.createEl("button", {
        cls: `daily-hub-week-day ${dayState}${selected ? " is-selected" : ""}${isToday(day.key) ? " is-today" : ""}`,
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
      if (day.future) {
        button.createEl("span", { text: "Future", cls: "daily-hub-week-stat daily-hub-muted" });
      } else if (!day.computerActivity.available || daySummary === undefined) {
        button.createEl("span", { text: "Unavailable", cls: "daily-hub-week-stat daily-hub-muted" });
      } else if (!hasGoals) {
        button.createEl("span", {
          text: formatDuration(day.computerActivity.activeComputerSeconds),
          cls: "daily-hub-week-stat"
        });
        button.createEl("span", { text: "Active", cls: "daily-hub-week-stat daily-hub-muted" });
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

  }

  private renderActivityChart(container: HTMLElement, week: WeekDayData[]): void {
    const hiddenIds = this.activityChartMode === "goals"
      ? this.hiddenChartGoalIds
      : this.activityChartMode === "apps"
        ? this.hiddenChartAppIds
        : this.hiddenChartCategoryIds;
    renderActivityChartView(container, {
      goals: this.plugin.data.goals.filter((goal) => goal.enabled),
      days: week,
      hiddenGoalIds: hiddenIds,
      selectDate: (dateKey) => this.selectDate(dateKey),
      mode: this.activityChartMode,
      categories: this.plugin.data.activityCategories,
      setMode: (mode) => {
        this.activityChartMode = mode;
        void this.refresh();
      }
    });
  }

  private renderLongTermContent(today: Date): void {
    const section = this.longTermSection;
    if (section === undefined) return;
    section.empty();
    const hasGoals = this.plugin.data.goals.some((goal) => goal.enabled);

    const analytics = this.getLongTermAnalytics(toLocalDateKey(today));
    const computer = this.getLongTermComputerAnalytics(toLocalDateKey(today));
    if (analytics === undefined || computer === undefined) {
      const loading = section.createDiv({ cls: "daily-hub-analytics-notice daily-hub-panel" });
      loading.createEl("p", { text: "Loading analytics…", cls: "daily-hub-muted", attr: { role: "status" } });
      return;
    }
    if (analytics.availableDays === 0 && computer.availableDays === 0) {
      const unavailable = section.createDiv({ cls: "daily-hub-analytics-notice daily-hub-panel" });
      unavailable.createEl("p", { text: "30-day analytics unavailable", cls: "daily-hub-muted", attr: { role: "status" } });
      this.renderLongTermHeatmap(section, analytics, computer);
      if (hasGoals) this.renderLongTermConsistency(section, analytics);
      return;
    }

    this.renderLongTermMetric(section, formatDuration(computer.totalSeconds), "Computer activity");
    this.renderLongTermMetric(
      section, computer.averageSeconds === undefined ? "—" : formatDuration(computer.averageSeconds),
      "Daily active average"
    );
    this.renderLongTermMetric(
      section,
      computer.topApplication === undefined
        ? "—"
        : `${computer.topApplication.label} · ${formatDuration(computer.topApplication.seconds)}`,
      "Most used app"
    );
    if (hasGoals) {
      this.renderLongTermMetric(section, formatDuration(analytics.totalSeconds), "Goal tracking");
      this.renderLongTermMetric(
        section,
        analytics.completionRate === undefined ? "—" : `${Math.round(analytics.completionRate * 100)}%`,
        "Goal completion"
      );
    }
    this.renderLongTermHeatmap(section, analytics, computer);
    if (hasGoals) this.renderLongTermConsistency(section, analytics);
  }

  private renderLongTermHeatmap(
    section: HTMLElement,
    analytics: RangeAnalytics,
    computer: ComputerActivityRange
  ): void {
    const heatmap = this.createAnalyticsTile(
      section,
      this.heatmapMode === "completion" ? "Daily completion" : "Computer activity",
      "Last 30 days",
      "daily-hub-bento-heatmap"
    );
    const heading = heatmap.querySelector<HTMLElement>(".daily-hub-section-heading");
    const tabs = heading?.createDiv({ cls: "daily-hub-segmented-control", attr: { role: "tablist" } });
    if (tabs !== undefined) {
      for (const mode of ["completion", "activity"] as const) {
        const selected = this.heatmapMode === mode;
        const button = tabs.createEl("button", {
          text: mode === "completion" ? "Completion" : "Activity",
          cls: selected ? "is-selected" : "",
          attr: { type: "button", role: "tab", "aria-selected": String(selected) }
        });
        button.addEventListener("click", () => {
          this.heatmapMode = mode;
          this.renderLongTermContent(new Date());
        });
      }
    }
    const availableDays = this.heatmapMode === "completion" ? analytics.availableDays : computer.availableDays;
    if (availableDays < LONG_TERM_DAYS) {
      heatmap.createEl("p", {
        text: `Partial data: ${availableDays} of ${LONG_TERM_DAYS} days available`,
        cls: "daily-hub-muted"
      });
    }
    if (this.heatmapMode === "completion") this.renderHeatmap(heatmap, analytics, false);
    else renderActivityHeatmap(heatmap, computer.days, this.selectedDateKey, (dateKey) => this.selectDate(dateKey));
  }

  private renderLongTermConsistency(section: HTMLElement, analytics: RangeAnalytics): void {
    const consistency = this.createAnalyticsTile(
      section, "Goal consistency", "Last 30 days", "daily-hub-bento-consistency"
    );
    if (analytics.goals.length === 0) {
      consistency.createEl("p", { text: "Add goals to see goal consistency.", cls: "daily-hub-muted" });
    } else this.renderGoalConsistency(consistency, analytics.goals, false);
  }

  private renderLongTermMetric(container: HTMLElement, value: string, label: string): void {
    const metric = container.createDiv({ cls: "daily-hub-bento-metric daily-hub-panel" });
    metric.createEl("span", { text: "Last 30 days", cls: "daily-hub-kicker" });
    metric.createEl("strong", { text: value });
    metric.createEl("span", { text: label });
  }

  private createAnalyticsTile(
    container: HTMLElement,
    title: string,
    kicker: string,
    className: string
  ): HTMLElement {
    const tile = container.createDiv({ cls: `${className} daily-hub-panel` });
    const heading = tile.createDiv({ cls: "daily-hub-section-heading" });
    heading.createEl("div", { text: kicker, cls: "daily-hub-kicker" });
    heading.createEl("h2", { text: title, cls: "daily-hub-section-title" });
    return tile;
  }

  private renderHeatmap(container: HTMLElement, analytics: RangeAnalytics, includeHeading = true): void {
    if (includeHeading) {
      container.createEl("h3", { text: "Daily completion", cls: "daily-hub-subsection-title" });
    }
    renderCalendarHeatmap(container, analytics, this.selectedDateKey, (dateKey) => this.selectDate(dateKey));
  }

  private renderGoalConsistency(
    container: HTMLElement,
    goals: GoalRangeStats[],
    includeHeading = true
  ): void {
    if (includeHeading) {
      container.createEl("h3", { text: "Goal consistency", cls: "daily-hub-subsection-title" });
    }
    renderGoalConsistencyView(container, goals, this.plugin.data.goals);
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

  private getLongTermComputerAnalytics(todayKey: string): ComputerActivityRange | undefined {
    const days = this.longTermActivity.get(todayKey, this.plugin.data.settings.activityWatchUrl);
    if (days === undefined) return undefined;
    return calculateComputerActivityRange(days.map((day) => day.activity === undefined
      ? activityForUnavailableDate(day.dateKey)
      : calculateComputerActivity(day.activity, day.dateKey, this.plugin.data.activityCategories)));
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

  private renderGoalBreakdown(
    container: HTMLElement,
    goals: GoalWeekStats[],
    includeHeading = true
  ): void {
    if (includeHeading) {
      container.createEl("h3", { text: "Goal breakdown", cls: "daily-hub-subsection-title" });
    }
    const breakdown = container.createDiv({ cls: "daily-hub-goal-breakdown" });
    const maximum = Math.max(...goals.map((goal) => goal.totalSeconds), 1);
    for (const goal of goals) {
      const item = breakdown.createDiv({ cls: "daily-hub-breakdown-item" });
      const configuredGoal = this.plugin.data.goals.find((candidate) => candidate.id === goal.goalId);
      item.style.setProperty("--dh-goal-color", getGoalColor(goal.goalId, configuredGoal?.colorIndex));
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
      cls: `daily-hub-status daily-hub-bento-status is-${status.kind}`,
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
        text: "⚠ Window watcher unavailable. Computer activity is unavailable; application and window-title goal rules cannot match.",
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
    const state: GoalProgressState = !progress.trackingStarted
      ? "untracked"
      : !progress.scheduled
      ? "rest"
      : !selectedAvailable
      ? future ? "future" : "unavailable"
      : progress.completed
      ? "complete"
      : progress.actualMinutes > 0
      ? "progress"
      : isToday(this.selectedDateKey) ? "not-started" : "missed";
    const stateLabel = state === "untracked"
      ? "Not tracked"
      : state === "rest"
      ? progress.skipped ? "Skipped" : "Rest day"
      : state === "future"
      ? "Planned"
      : state === "unavailable"
      ? "Unavailable"
      : state === "complete"
      ? "Complete"
      : state === "progress"
      ? "In progress"
      : state === "missed"
      ? "Goal missed"
      : "Not started";

    const card = container.createDiv({ cls: `daily-hub-goal is-${state}` });
    card.style.setProperty("--dh-goal-color", getGoalColor(goal.id, goal.colorIndex));
    const heading = card.createDiv({ cls: "daily-hub-goal-heading" });
    heading.createEl("h3", { text: goal.name });
    const badge = heading.createDiv({ cls: "daily-hub-goal-state" });
    const stateIcon = badge.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(stateIcon, state === "complete" ? "check-circle-2"
      : state === "unavailable" ? "alert-triangle"
      : state === "missed" ? "circle-x"
      : state === "rest" || state === "untracked" ? "minus-circle"
      : "circle");
    badge.createSpan({ text: stateLabel });

    const content = card.createDiv({ cls: "daily-hub-goal-content" });
    let actualTime: HTMLElement | undefined;
    let compactTime: string | undefined;
    let progressShell: HTMLElement | undefined;

    if (!progress.trackingStarted) {
      content.createEl("div", { text: "Tracking begins from this goal’s creation date.", cls: "daily-hub-muted" });
    } else if (!progress.scheduled) {
      content.createEl("div", {
        text: progress.skipped ? "This goal was skipped for the selected day." : "No target is scheduled for this day.",
        cls: "daily-hub-muted"
      });
      if (selectedAvailable && progress.activeSeconds > 0) {
        content.createEl("strong", { text: `${formatDuration(progress.activeSeconds)} activity` });
      }
    } else if (!selectedAvailable) {
      content.createEl("strong", {
        text: future ? `Target ${progress.targetMinutes} min` : `Target ${progress.targetMinutes} min · activity unavailable`
      });
    } else {
      const summary = content.createDiv({ cls: "daily-hub-goal-summary" });
      const minutes = Math.floor(progress.actualMinutes);
      compactTime = `${minutes} min`;
      actualTime = summary.createEl("strong", { text: compactTime, cls: "daily-hub-goal-actual" });
      summary.createEl("span", { text: `goal ${progress.targetMinutes} min`, cls: "daily-hub-muted" });

      const progressRatio = progress.progressRatio ?? 0;
      progressShell = content.createDiv({ cls: "daily-hub-progress-shell" });
      progressShell.style.setProperty("--dh-progress-ratio", String(Math.max(0, Math.min(1, progressRatio))));
      const bar = progressShell.createDiv({
        cls: "daily-hub-goal-progress",
        attr: {
          role: "progressbar",
          "aria-valuemin": "0",
          "aria-valuemax": String(progress.targetMinutes),
          "aria-valuenow": String(Math.min(progress.actualMinutes, progress.targetMinutes)),
          "aria-label": `${goal.name}: ${minutes} of ${progress.targetMinutes} minutes`
        }
      });
      bar.createDiv({ cls: "daily-hub-goal-progress-fill" });
      const emitter = progressShell.createSpan({
        cls: "daily-hub-progress-emitter",
        attr: { "aria-hidden": "true" }
      });
      for (let index = 0; index < 6; index += 1) {
        emitter.createSpan({ cls: `daily-hub-progress-particle is-${index + 1}` });
      }

      if (progress.completed) {
        const extra = Math.floor(progress.actualMinutes - progress.targetMinutes);
        content.createEl("div", {
          text: extra > 0 ? `Goal completed · +${extra} min beyond goal` : "Goal completed",
          cls: "daily-hub-goal-description"
        });
      } else {
        const remaining = Math.max(0, Math.ceil(progress.targetMinutes - progress.actualMinutes));
        content.createEl("div", {
          text: state === "missed" ? `${remaining} min short of the goal` : `${remaining} min remaining`,
          cls: "daily-hub-goal-description"
        });
      }
    }

    const runtimeStatus = content.createDiv({
      cls: "daily-hub-goal-runtime-state",
      attr: { role: "status", "aria-live": "polite" }
    });

    const actions = card.createDiv({ cls: "daily-hub-goal-actions" });
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

    if (isToday(this.selectedDateKey)) {
      const diagnostics = actions.createEl("button", {
        text: "Why isn't this tracking?",
        cls: "daily-hub-details-button daily-hub-diagnostics-button"
      });
      diagnostics.addEventListener("click", () => new TrackingDiagnosticsModal(this.plugin, goal).open());
    }

    let pauseButton: HTMLButtonElement | undefined;
    let pauseIcon: HTMLElement | undefined;
    let pauseLabel: HTMLElement | undefined;
    if (isToday(this.selectedDateKey) && progress.trackingStarted && goal.enabled) {
      pauseButton = actions.createEl("button", { cls: "daily-hub-details-button daily-hub-pause-button" });
      pauseIcon = pauseButton.createSpan({ attr: { "aria-hidden": "true" } });
      pauseLabel = pauseButton.createSpan();
      pauseButton.addEventListener("click", () => { void this.toggleGoalPause(goal.id); });
    }

    const adjust = actions.createEl("button", {
      text: "Adjust this day",
      cls: "daily-hub-details-button"
    });
    adjust.addEventListener("click", () => {
      new DayOverrideModal(this.plugin, goal, this.selectedDateKey).open();
    });

    const edit = actions.createEl("button", {
      cls: "daily-hub-icon-button",
      attr: { "aria-label": `Edit ${goal.name}`, title: `Edit ${goal.name}` }
    });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => new GoalEditorModal(this.plugin, goal).open());

    this.goalRuntimeElements.set(goal.id, {
      card,
      status: runtimeStatus,
      actualTime,
      compactTime,
      liveEligible: selectedAvailable && progress.trackingStarted && progress.scheduled && !future,
      progressShell,
      pauseButton,
      pauseIcon,
      pauseLabel
    });
  }

  private syncLivePolling(activityAvailable: boolean): void {
    const shouldPoll = this.viewOpen && activityAvailable && isToday(this.selectedDateKey);
    if (!shouldPoll) {
      this.stopLivePolling();
      this.updateGoalRuntimeStates();
      return;
    }
    this.livePollTimer ??= window.setInterval(() => { void this.refreshLiveState(); }, LIVE_POLL_INTERVAL_MS);
    void this.refreshLiveState();
  }

  private stopLivePolling(): void {
    this.livePollSequence += 1;
    if (this.livePollTimer !== undefined) {
      window.clearInterval(this.livePollTimer);
      this.livePollTimer = undefined;
    }
  }

  private async refreshLiveState(): Promise<void> {
    if (this.livePollInFlight || !this.viewOpen || !isToday(this.selectedDateKey)) return;
    this.livePollInFlight = true;
    const sequence = ++this.livePollSequence;
    const now = new Date();
    const maximumContextMs = this.plugin.data.goals.reduce(
      (maximum, goal) => Math.max(maximum, goal.contextTimeoutMinutes * 60_000), 0
    );
    const recentStart = new Date(now.getTime() - Math.max(
      LIVE_MIN_LOOKBACK_MS, maximumContextMs + BROWSER_CONTEXT_GRACE_MS
    ));

    try {
      const snapshot = await this.plugin.getRecentActivitySnapshot(recentStart, now);
      if (sequence !== this.livePollSequence || !isToday(this.selectedDateKey)) return;
      if (snapshot.status.kind !== "connected") {
        this.selectedActivityAvailable = false;
        this.updateGoalRuntimeStates();
        this.stopLivePolling();
        return;
      }
      const base = this.todayActivity ?? { windowEvents: [], browserEvents: [], afkEvents: [] };
      const combined: DayActivity = {
        windowEvents: [...base.windowEvents, ...snapshot.activity.windowEvents],
        browserEvents: [...base.browserEvents, ...snapshot.activity.browserEvents],
        afkEvents: [...base.afkEvents, ...snapshot.activity.afkEvents]
      };
      const live = resolveLiveTrackingState(
        this.plugin.data.goals,
        combined,
        now.getTime(),
        getLocalDateRange(now).start.getTime()
      );
      this.updateGoalRuntimeStates(live.goal?.id, live.currentSessionSeconds);
    } finally {
      this.livePollInFlight = false;
    }
  }

  private updateGoalRuntimeStates(liveGoalId?: string, currentSessionSeconds = 0): void {
    const currentDay = isToday(this.selectedDateKey);
    for (const [goalId, elements] of this.goalRuntimeElements) {
      const goal = this.plugin.data.goals.find((candidate) => candidate.id === goalId);
      if (goal === undefined) continue;
      const runtime = getGoalRuntimeUiState({
        goalId,
        liveGoalId,
        currentDay,
        activityAvailable: this.selectedActivityAvailable,
        liveEligible: elements.liveEligible,
        paused: isGoalPaused(goal)
      });
      const wasPaused = elements.card.hasClass("is-paused");
      const wasLive = elements.card.hasClass("is-live");
      elements.card.toggleClass("is-paused", runtime.paused);
      elements.card.toggleClass("is-live", runtime.live);

      if (wasPaused !== runtime.paused || wasLive !== runtime.live || runtime.live) {
        elements.status.empty();
        if (runtime.paused) {
          elements.status.addClass("is-paused");
          elements.status.removeClass("is-live");
          const icon = elements.status.createSpan({ attr: { "aria-hidden": "true" } });
          setIcon(icon, "pause");
          elements.status.createSpan({ text: runtime.label });
        } else if (runtime.live) {
          elements.status.addClass("is-live");
          elements.status.removeClass("is-paused");
          elements.status.createSpan({ cls: "daily-hub-live-dot", attr: { "aria-hidden": "true" } });
          elements.status.createSpan({
            text: `${runtime.label} · ${formatCurrentSessionDuration(currentSessionSeconds)}`
          });
        } else {
          elements.status.removeClass("is-live", "is-paused");
        }
      }

      elements.progressShell?.toggleClass("is-live", runtime.particlesActive);
      if (elements.actualTime !== undefined && elements.compactTime !== undefined) {
        elements.actualTime.setText(elements.compactTime);
      }

      if (elements.pauseButton !== undefined
        && elements.pauseIcon !== undefined
        && elements.pauseLabel !== undefined) {
        const pauseText = runtime.actionLabel;
        if (elements.pauseLabel.textContent !== pauseText) {
          setIcon(elements.pauseIcon, runtime.paused ? "play" : "pause");
          elements.pauseLabel.setText(pauseText);
        }
        elements.pauseButton.toggleClass("is-resume", runtime.paused);
        elements.pauseButton.setAttribute("aria-label", `${pauseText} ${goal.name}`);
      }
    }
  }

  private async toggleGoalPause(goalId: string): Promise<void> {
    const goal = this.plugin.data.goals.find((candidate) => candidate.id === goalId);
    const elements = this.goalRuntimeElements.get(goalId);
    if (goal === undefined || elements?.pauseButton === undefined) return;
    elements.pauseButton.disabled = true;
    const operation = isGoalPaused(goal)
      ? this.plugin.resumeGoalTracking(goalId)
      : this.plugin.pauseGoalTracking(goalId);
    this.updateGoalRuntimeStates();
    try {
      await operation;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Daily Hub] Could not update goal tracking pause: ${detail}`);
      this.updateGoalRuntimeStates();
    } finally {
      const currentButton = this.goalRuntimeElements.get(goalId)?.pauseButton;
      if (currentButton !== undefined) currentButton.disabled = false;
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
