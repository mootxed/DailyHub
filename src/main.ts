import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { ActivityWatchClient } from "./activity-watch";
import { normalizeData, requiresDataMigration } from "./data";
import { toLocalDateKey } from "./date";
import { GoalEditorModal } from "./goal-editor";
import {
  DEFAULT_DATA,
  updateGoalEnabled,
  type ActivityWatchSnapshot,
  type DailyGoal,
  type DailyHubData,
  type GoalProgress
} from "./models";
import { DailyHubSettingTab } from "./settings";
import { DAILY_HUB_VIEW_TYPE, DailyHubView } from "./view";

export default class DailyHubPlugin extends Plugin {
  data: DailyHubData = structuredClone(DEFAULT_DATA);
  private refreshTimer: number | undefined;
  private activityRequest: { key: string; promise: Promise<ActivityWatchSnapshot> } | undefined;

  override async onload(): Promise<void> {
    const storedData = await this.loadData() as unknown;
    this.data = normalizeData(storedData);
    const notificationCount = this.data.notifiedCompletions.length;
    this.pruneNotifications(toLocalDateKey(new Date()));
    if (requiresDataMigration(storedData) || notificationCount !== this.data.notifiedCompletions.length) {
      await this.savePluginData();
    }

    this.registerView(DAILY_HUB_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DailyHubView(leaf, this));
    this.addRibbonIcon("calendar-check", "Open Daily Hub", () => { void this.activateView(); });
    this.addCommand({ id: "open-daily-hub", name: "Open Daily Hub", callback: () => { void this.activateView(); } });
    this.addCommand({ id: "add-daily-goal", name: "Add daily goal", callback: () => new GoalEditorModal(this).open() });
    this.addSettingTab(new DailyHubSettingTab(this.app, this));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.refreshViews();
    });
    this.resetRefreshInterval();
  }

  override onunload(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DAILY_HUB_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (existing === undefined) await leaf.setViewState({ type: DAILY_HUB_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  hasGoal(id: string): boolean {
    return this.data.goals.some((goal) => goal.id === id);
  }

  async upsertGoal(goal: DailyGoal): Promise<void> {
    const index = this.data.goals.findIndex((candidate) => candidate.id === goal.id);
    if (index === -1) this.data.goals.push(goal);
    else this.data.goals[index] = goal;
    await this.savePluginData();
    await this.refreshViews();
  }

  async setGoalEnabled(goalId: string, enabled: boolean): Promise<void> {
    if (!updateGoalEnabled(this.data.goals, goalId, enabled)) return;
    await this.savePluginData();
    await this.refreshViews();
  }

  async deleteGoal(id: string): Promise<void> {
    this.data.goals = this.data.goals.filter((goal) => goal.id !== id);
    this.data.notifiedCompletions = this.data.notifiedCompletions.filter((key) => !key.endsWith(`:${id}`));
    await this.savePluginData();
    await this.refreshViews();
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  async refreshViews(): Promise<void> {
    const views = this.app.workspace.getLeavesOfType(DAILY_HUB_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is DailyHubView => view instanceof DailyHubView);
    await Promise.all(views.map((view) => view.refresh()));
  }

  getActivitySnapshot(date: Date): Promise<ActivityWatchSnapshot> {
    const key = `${this.data.settings.activityWatchUrl}:${toLocalDateKey(date)}`;
    if (this.activityRequest?.key === key) return this.activityRequest.promise;

    const client = new ActivityWatchClient(this.data.settings.activityWatchUrl);
    const promise = client.getDaySnapshot(date).finally(() => {
      if (this.activityRequest?.promise === promise) this.activityRequest = undefined;
    });
    this.activityRequest = { key, promise };
    return promise;
  }

  resetRefreshInterval(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    const seconds = Math.max(10, this.data.settings.refreshIntervalSeconds);
    this.refreshTimer = window.setInterval(() => { void this.refreshViews(); }, seconds * 1000);
    this.registerInterval(this.refreshTimer);
  }

  async notifyNewCompletions(dateKey: string, progress: GoalProgress[]): Promise<void> {
    if (!this.data.settings.completionNotifications) return;
    let changed = false;
    const notified = new Set(this.data.notifiedCompletions);
    const goals = new Map(this.data.goals.map((goal) => [goal.id, goal]));

    for (const item of progress) {
      if (!item.completed) continue;
      const key = `${dateKey}:${item.goalId}`;
      if (notified.has(key)) continue;
      const goal = goals.get(item.goalId);
      if (!goal?.enabled) continue;

      new Notice(`Daily Hub\n${goal.name} complete\n${Math.floor(item.actualMinutes)} / ${goal.targetMinutes} min`);
      this.data.notifiedCompletions.push(key);
      notified.add(key);
      changed = true;
    }

    if (changed) {
      this.pruneNotifications(dateKey);
      await this.savePluginData();
    }
  }

  private pruneNotifications(todayKey: string): void {
    const cutoff = new Date(`${todayKey}T00:00:00`);
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffKey = toLocalDateKey(cutoff);
    this.data.notifiedCompletions = this.data.notifiedCompletions.filter((key) => key.slice(0, 10) >= cutoffKey);
  }
}
