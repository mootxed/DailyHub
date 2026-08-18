import { Modal, Setting } from "obsidian";
import type { ActivityBreakdownItem, ComputerActivitySegment, DailyComputerActivity } from "./activity-models";
import type { ActivityBreakdownMode } from "./view/activity-breakdown-view";
import type DailyHubPlugin from "./main";
import { createEmptyActivityCategory, createEmptyGoal, createId } from "./models";
import { GoalEditorModal } from "./goal-editor";
import { formatDuration } from "./dashboard";

interface ActivitySession {
  startMs: number;
  endMs: number;
}

function matches(segment: ComputerActivitySegment, item: ActivityBreakdownItem, mode: ActivityBreakdownMode): boolean {
  if (mode === "apps") return segment.application === item.id;
  if (mode === "sites") return segment.domain === item.id;
  return (segment.categoryId ?? "uncategorized") === item.id;
}

function sessionsFor(
  activity: DailyComputerActivity,
  item: ActivityBreakdownItem,
  mode: ActivityBreakdownMode
): ActivitySession[] {
  const sessions: ActivitySession[] = [];
  for (const segment of activity.segments.filter((candidate) => matches(candidate, item, mode))) {
    const previous = sessions.at(-1);
    if (previous?.endMs === segment.startMs) previous.endMs = segment.endMs;
    else sessions.push({ startMs: segment.startMs, endMs: segment.endMs });
  }
  return sessions;
}

function time(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

export class ActivityDetailsModal extends Modal {
  constructor(
    private readonly plugin: DailyHubPlugin,
    private readonly activity: DailyComputerActivity,
    private readonly item: ActivityBreakdownItem,
    private readonly mode: ActivityBreakdownMode
  ) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("daily-hub-modal", "daily-hub-activity-details");
    this.setTitle(this.item.label);
    const summary = this.contentEl.createDiv({ cls: "daily-hub-activity-details-summary" });
    summary.createEl("strong", { text: formatDuration(this.item.seconds) });
    summary.createEl("span", { text: "Today" });

    if (this.item.domainBreakdown !== undefined) {
      this.contentEl.createEl("h3", { text: "Top domains" });
      for (const domain of this.item.domainBreakdown.slice(0, 8)) {
        const row = this.contentEl.createDiv({ cls: "daily-hub-activity-detail-row" });
        row.createEl("span", { text: domain.label });
        row.createEl("strong", { text: formatDuration(domain.seconds) });
      }
    }

    this.contentEl.createEl("h3", { text: "Today sessions" });
    const sessions = sessionsFor(this.activity, this.item, this.mode);
    for (const session of sessions.slice(0, 20)) {
      const row = this.contentEl.createDiv({ cls: "daily-hub-activity-detail-row" });
      row.createEl("span", { text: `${time(session.startMs)}–${time(session.endMs)}` });
      row.createEl("strong", { text: formatDuration((session.endMs - session.startMs) / 1000) });
    }
    if (sessions.length > 20) {
      this.contentEl.createEl("p", { text: `${sessions.length - 20} more sessions`, cls: "daily-hub-muted" });
    }

    if ((this.mode === "apps" || this.mode === "sites") && this.item.id !== "other") {
      this.renderClassificationActions();
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderClassificationActions(): void {
    this.contentEl.createEl("h3", { text: "Classify this activity" });
    if (this.plugin.data.activityCategories.length > 0) {
      let selectedId = this.plugin.data.activityCategories[0]?.id;
      new Setting(this.contentEl)
        .setName("Assign to category")
        .setDesc("Adds a rule; historical activity is reclassified immediately.")
        .addDropdown((dropdown) => {
          for (const category of this.plugin.data.activityCategories) {
            dropdown.addOption(category.id, category.name);
          }
          dropdown.onChange((value) => { selectedId = value; });
        })
        .addButton((button) => button.setButtonText("Assign").onClick(async () => {
          const category = this.plugin.data.activityCategories.find((candidate) => candidate.id === selectedId);
          if (category === undefined) return;
          category.rules.push({
            id: createId(),
            field: this.mode === "sites" ? "domain" : "application",
            operator: "equals",
            value: this.item.id
          });
          await this.plugin.savePluginData();
          await this.plugin.refreshViews();
          this.close();
        }));
    }

    new Setting(this.contentEl)
      .setName("Create category")
      .setDesc("Creates a category with an exact rule for this item.")
      .addButton((button) => button.setButtonText("Create category").onClick(async () => {
        const category = createEmptyActivityCategory(this.item.label);
        category.rules.push({
          id: createId(),
          field: this.mode === "sites" ? "domain" : "application",
          operator: "equals",
          value: this.item.id
        });
        this.plugin.data.activityCategories.push(category);
        await this.plugin.savePluginData();
        await this.plugin.refreshViews();
        this.close();
      }));

    new Setting(this.contentEl)
      .setName("Create goal")
      .setDesc("Opens a draft goal; nothing is saved until you confirm it.")
      .addButton((button) => button.setButtonText("Create goal").onClick(() => {
        const goal = createEmptyGoal();
        goal.name = this.item.label;
        const primary = goal.rules[0];
        if (primary?.role === "primary") {
          primary.field = this.mode === "sites" ? "url" : "application";
          primary.operator = this.mode === "sites" ? "contains" : "equals";
          primary.value = this.item.id;
        }
        this.close();
        new GoalEditorModal(this.plugin, goal).open();
      }));
  }
}
