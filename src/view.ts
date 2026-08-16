import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { ActivityWatchClient } from "./activity-watch";
import { toLocalDateKey } from "./date";
import { GoalEditorModal } from "./goal-editor";
import type DailyHubPlugin from "./main";
import { calculateDailyProgress } from "./progress";
import type { ActivityWatchStatus, DailyGoal, GoalProgress } from "./models";

export const DAILY_HUB_VIEW_TYPE = "daily-hub-view";
const ACTIVITYWATCH_DOWNLOAD_URL = "https://activitywatch.net/downloads/";
const BROWSER_WATCHER_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-browser";

export class DailyHubView extends ItemView {
  private readonly plugin: DailyHubPlugin;
  private refreshSequence = 0;

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

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    this.renderLoading();

    const today = new Date();
    const client = new ActivityWatchClient(this.plugin.data.settings.activityWatchUrl);
    const snapshot = await client.getDaySnapshot(today);
    if (sequence !== this.refreshSequence) return;

    const progress = calculateDailyProgress(
      this.plugin.data.goals,
      snapshot.activity,
      today,
      this.plugin.data.settings.afkThresholdSeconds
    );
    this.renderDashboard(today, snapshot.status, progress);
    await this.plugin.notifyNewCompletions(toLocalDateKey(today), progress);
  }

  private renderLoading(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("daily-hub-view");
    container.createEl("h1", { text: "Daily Hub" });
    container.createEl("p", { text: "Loading activity…", cls: "daily-hub-muted" });
  }

  private renderDashboard(date: Date, status: ActivityWatchStatus, progress: GoalProgress[]): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("daily-hub-view");

    const header = container.createDiv({ cls: "daily-hub-header" });
    const titles = header.createDiv();
    titles.createEl("h1", { text: "Daily Hub" });
    titles.createEl("div", { text: "Today", cls: "daily-hub-kicker" });
    titles.createEl("div", {
      text: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date),
      cls: "daily-hub-date"
    });

    const headerActions = header.createDiv({ cls: "daily-hub-header-actions" });
    const refresh = headerActions.createEl("button", { attr: { "aria-label": "Refresh Daily Hub" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => { void this.refresh(); });
    const add = headerActions.createEl("button", { text: "Add goal", cls: "mod-cta" });
    add.addEventListener("click", () => new GoalEditorModal(this.plugin).open());

    this.renderStatus(container, status);

    const enabledGoals = this.plugin.data.goals.filter((goal) => goal.enabled);
    if (enabledGoals.length === 0) {
      const empty = container.createDiv({ cls: "daily-hub-empty" });
      empty.createEl("h2", { text: "No daily goals yet" });
      empty.createEl("p", { text: "Add a goal and match it to an app, window title, or browser URL." });
      const emptyAdd = empty.createEl("button", { text: "Add your first goal", cls: "mod-cta" });
      emptyAdd.addEventListener("click", () => new GoalEditorModal(this.plugin).open());
      return;
    }

    const goals = container.createDiv({ cls: "daily-hub-goals" });
    const progressByGoal = new Map(progress.map((item) => [item.goalId, item]));
    for (const goal of enabledGoals) {
      const goalProgress = progressByGoal.get(goal.id);
      if (goalProgress !== undefined) this.renderGoal(goals, goal, goalProgress);
    }
  }

  private renderStatus(container: HTMLElement, status: ActivityWatchStatus): void {
    const statusBar = container.createDiv({
      cls: `daily-hub-status is-${status.kind}`,
      attr: { role: "status" }
    });
    const statusText = statusBar.createDiv();
    statusText.createEl("strong", { text: status.message });

    if (status.kind === "offline") {
      statusText.createEl("div", {
        text: "Start ActivityWatch, then refresh. Installation opens the official download page.",
        cls: "daily-hub-muted"
      });
      const actions = statusBar.createDiv({ cls: "daily-hub-status-actions" });
      this.externalLinkButton(actions, "Install ActivityWatch", ACTIVITYWATCH_DOWNLOAD_URL, true);
      this.externalLinkButton(actions, "Open installation instructions", ACTIVITYWATCH_DOWNLOAD_URL);
    } else if (!status.browserWatcherAvailable) {
      statusText.createEl("div", {
        text: "Application and window-title rules work. Install a browser watcher to use URL rules.",
        cls: "daily-hub-muted"
      });
      this.externalLinkButton(statusBar, "Browser watcher instructions", BROWSER_WATCHER_URL);
    }
  }

  private externalLinkButton(container: HTMLElement, label: string, url: string, primary = false): void {
    const button = container.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined });
    button.addEventListener("click", () => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  private renderGoal(container: HTMLElement, goal: DailyGoal, progress: GoalProgress): void {
    const card = container.createDiv({ cls: "daily-hub-goal" });
    const heading = card.createDiv({ cls: "daily-hub-goal-heading" });
    heading.createEl("h2", { text: goal.name });
    const edit = heading.createEl("button", { attr: { "aria-label": `Edit ${goal.name}` } });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => new GoalEditorModal(this.plugin, goal).open());

    const bar = card.createEl("progress", {
      cls: "daily-hub-progress",
      attr: {
        max: "1",
        value: String(progress.progressRatio),
        "aria-label": `${goal.name} progress`
      }
    });
    bar.max = 1;
    bar.value = progress.progressRatio;

    const summary = card.createDiv({ cls: "daily-hub-goal-summary" });
    const minutes = Math.floor(progress.actualMinutes);
    summary.createEl("span", { text: `${minutes} / ${goal.targetMinutes} min` });
    if (progress.completed) {
      const complete = summary.createEl("span", { text: "Complete", cls: "daily-hub-complete" });
      setIcon(complete, "check");
      const extra = Math.floor(progress.actualMinutes - goal.targetMinutes);
      if (extra > 0) card.createEl("div", { text: `+${extra} min beyond goal`, cls: "daily-hub-muted" });
    }
  }
}
