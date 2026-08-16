import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { toLocalDateKey } from "./date";
import { GoalEditorModal } from "./goal-editor";
import { DEFAULT_DATA, DEFAULT_SETTINGS, type DailyGoal, type DailyHubData, type GoalProgress } from "./models";
import { DailyHubSettingTab } from "./settings";
import { DAILY_HUB_VIEW_TYPE, DailyHubView } from "./view";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeData(value: unknown): DailyHubData {
  if (!isRecord(value)) return structuredClone(DEFAULT_DATA);
  const settings = isRecord(value.settings) ? value.settings : {};
  return {
    settings: {
      activityWatchUrl: typeof settings.activityWatchUrl === "string"
        ? settings.activityWatchUrl
        : DEFAULT_SETTINGS.activityWatchUrl,
      afkThresholdSeconds: typeof settings.afkThresholdSeconds === "number"
        ? settings.afkThresholdSeconds
        : DEFAULT_SETTINGS.afkThresholdSeconds,
      refreshIntervalSeconds: typeof settings.refreshIntervalSeconds === "number"
        ? settings.refreshIntervalSeconds
        : DEFAULT_SETTINGS.refreshIntervalSeconds,
      completionNotifications: typeof settings.completionNotifications === "boolean"
        ? settings.completionNotifications
        : DEFAULT_SETTINGS.completionNotifications
    },
    goals: Array.isArray(value.goals) ? value.goals as DailyGoal[] : [],
    notifiedCompletions: Array.isArray(value.notifiedCompletions)
      ? value.notifiedCompletions.filter((item): item is string => typeof item === "string")
      : []
  };
}

export default class DailyHubPlugin extends Plugin {
  data: DailyHubData = structuredClone(DEFAULT_DATA);
  private refreshTimer: number | undefined;

  override async onload(): Promise<void> {
    this.data = normalizeData(await this.loadData() as unknown);

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
