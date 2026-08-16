import { Modal, Notice, Setting } from "obsidian";
import type DailyHubPlugin from "./main";
import { createEmptyGoal, createEmptyRule, type DailyGoal, type GoalRule } from "./models";

function copyGoal(goal: DailyGoal): DailyGoal {
  return { ...goal, rules: goal.rules.map((rule) => ({ ...rule })) };
}

export class GoalEditorModal extends Modal {
  private readonly plugin: DailyHubPlugin;
  private readonly draft: DailyGoal;

  constructor(plugin: DailyHubPlugin, goal?: DailyGoal) {
    super(plugin.app);
    this.plugin = plugin;
    this.draft = goal === undefined ? createEmptyGoal() : copyGoal(goal);
  }

  override onOpen(): void {
    this.titleEl.setText(this.plugin.hasGoal(this.draft.id) ? "Edit daily goal" : "Add daily goal");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    new Setting(this.contentEl)
      .setName("Name")
      .addText((text) => text
        .setPlaceholder("Typing practice")
        .setValue(this.draft.name)
        .onChange((value) => { this.draft.name = value; }));

    new Setting(this.contentEl)
      .setName("Daily minimum")
      .setDesc("Minutes required to complete the goal. Time keeps accumulating afterward.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.setValue(String(this.draft.targetMinutes)).onChange((value) => {
          this.draft.targetMinutes = Number(value);
        });
      });

    new Setting(this.contentEl)
      .setName("Enabled")
      .addToggle((toggle) => toggle.setValue(this.draft.enabled).onChange((value) => {
        this.draft.enabled = value;
      }));

    this.contentEl.createEl("h3", { text: "Activity rules" });
    this.contentEl.createEl("p", {
      text: "A segment is counted when any rule matches. Matching is case-insensitive.",
      cls: "daily-hub-muted"
    });

    const rules = this.contentEl.createDiv({ cls: "daily-hub-rule-list" });
    for (const rule of this.draft.rules) this.renderRule(rules, rule);

    const actions = this.contentEl.createDiv({ cls: "daily-hub-modal-actions" });
    const addRule = actions.createEl("button", { text: "Add rule" });
    addRule.addEventListener("click", () => {
      this.draft.rules.push(createEmptyRule());
      this.render();
    });

    const save = actions.createEl("button", { text: "Save goal", cls: "mod-cta" });
    save.addEventListener("click", () => { void this.save(); });
  }

  private renderRule(container: HTMLElement, rule: GoalRule): void {
    const row = container.createDiv({ cls: "daily-hub-rule" });

    const field = row.createEl("select", { attr: { "aria-label": "Rule type" } });
    const fields: [GoalRule["field"], string][] = [
      ["url", "URL"],
      ["application", "Application"],
      ["windowTitle", "Window title"]
    ];
    for (const [value, label] of fields) field.createEl("option", { text: label, value });
    field.value = rule.field;
    field.addEventListener("change", () => { rule.field = field.value as GoalRule["field"]; });

    const operator = row.createEl("select", { attr: { "aria-label": "Match operator" } });
    operator.createEl("option", { text: "contains", value: "contains" });
    operator.createEl("option", { text: "equals", value: "equals" });
    operator.value = rule.operator;
    operator.addEventListener("change", () => { rule.operator = operator.value as GoalRule["operator"]; });

    const value = row.createEl("input", {
      type: "text",
      value: rule.value,
      placeholder: rule.field === "url" ? "keybr.com" : "Value",
      attr: { "aria-label": "Match value" }
    });
    value.addEventListener("input", () => { rule.value = value.value; });

    const remove = row.createEl("button", {
      text: "Remove",
      cls: "daily-hub-rule-remove",
      attr: { "aria-label": "Remove rule" }
    });
    remove.addEventListener("click", () => {
      this.draft.rules = this.draft.rules.filter((candidate) => candidate.id !== rule.id);
      this.render();
    });
  }

  private async save(): Promise<void> {
    this.draft.name = this.draft.name.trim();
    this.draft.rules = this.draft.rules.map((rule) => ({ ...rule, value: rule.value.trim() }));
    if (this.draft.name.length === 0) {
      new Notice("Daily Hub: enter a goal name");
      return;
    }
    if (!Number.isFinite(this.draft.targetMinutes) || this.draft.targetMinutes <= 0) {
      new Notice("Daily Hub: daily minimum must be greater than zero");
      return;
    }
    if (this.draft.rules.length === 0 || this.draft.rules.some((rule) => rule.value.length === 0)) {
      new Notice("Daily Hub: add at least one complete activity rule");
      return;
    }

    await this.plugin.upsertGoal(this.draft);
    this.close();
  }
}
