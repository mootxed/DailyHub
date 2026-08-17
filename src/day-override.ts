import { Modal, Notice, Setting } from "obsidian";
import type DailyHubPlugin from "./main";
import type { DailyGoal, GoalDayOverride } from "./models";
import { getGoalSchedule, getWeekday, parseTargetOverride } from "./schedule";

export class DayOverrideModal extends Modal {
  private targetValue: string;

  constructor(
    private readonly plugin: DailyHubPlugin,
    private readonly goal: DailyGoal,
    private readonly dateKey: string
  ) {
    super(plugin.app);
    const scheduled = getGoalSchedule(goal)[getWeekday(dateKey)].targetMinutes;
    const override = goal.overrides?.[dateKey];
    this.targetValue = String(override?.kind === "target" ? override.targetMinutes : scheduled);
  }

  override onOpen(): void {
    this.titleEl.setText(`Adjust ${this.goal.name}`);
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    const scheduleDay = getGoalSchedule(this.goal)[getWeekday(this.dateKey)];
    container.createEl("p", {
      text: `${this.dateKey} · ${scheduleDay.enabled ? `Scheduled target: ${scheduleDay.targetMinutes} min` : "Scheduled rest day"}`,
      cls: "daily-hub-muted"
    });

    new Setting(container)
      .setName("Target for this day")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.setValue(this.targetValue).onChange((value) => { this.targetValue = value; });
      });

    const actions = container.createDiv({ cls: "daily-hub-modal-actions daily-hub-override-actions" });
    const save = actions.createEl("button", { text: "Save target", cls: "mod-cta" });
    save.addEventListener("click", () => { void this.saveTarget(); });
    const skip = actions.createEl("button", { text: "Skip this day" });
    skip.addEventListener("click", () => { void this.save({ kind: "skip" }); });
    const reset = actions.createEl("button", { text: "Reset override" });
    reset.disabled = this.goal.overrides?.[this.dateKey] === undefined;
    reset.addEventListener("click", () => { void this.save(undefined); });
  }

  private async saveTarget(): Promise<void> {
    const override = parseTargetOverride(this.targetValue);
    if (override === undefined) {
      new Notice("Daily Hub: target must be at least one minute");
      return;
    }
    await this.save(override);
  }

  private async save(override: GoalDayOverride | undefined): Promise<void> {
    await this.plugin.setGoalDayOverride(this.goal.id, this.dateKey, override);
    this.close();
  }
}
