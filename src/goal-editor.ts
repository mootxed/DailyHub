import { Modal, Notice, Setting } from "obsidian";
import type DailyHubPlugin from "./main";
import {
  createEmptyGoal,
  createEmptyRule,
  type DailyGoal,
  type GoalRule,
  type GoalRuleRole
} from "./models";

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

    new Setting(this.contentEl)
      .setName("Context timeout (minutes)")
      .setDesc(
        "How long Daily Hub remembers this goal after unrelated activity. "
        + "Continuous primary or continuation activity keeps the context alive."
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.setAttribute("aria-label", "Context timeout in minutes");
        text.setValue(String(this.draft.contextTimeoutMinutes)).onChange((value) => {
          this.draft.contextTimeoutMinutes = Number(value);
        });
      });

    this.renderRuleSection(
      "primary",
      "Primary rules",
      "These activities directly identify and count toward this goal.",
      "Add primary rule"
    );
    this.renderRuleSection(
      "continuation",
      "Continuation rules",
      "These activities count only after this goal was recently identified.",
      "Add continuation rule"
    );

    const actions = this.contentEl.createDiv({ cls: "daily-hub-modal-actions" });
    const save = actions.createEl("button", { text: "Save goal", cls: "mod-cta" });
    save.addEventListener("click", () => { void this.save(); });
  }

  private renderRuleSection(
    role: GoalRuleRole,
    title: string,
    description: string,
    addLabel: string
  ): void {
    const section = this.contentEl.createDiv({ cls: "daily-hub-rule-section" });
    section.createEl("h3", { text: title });
    section.createEl("p", {
      text: description,
      cls: "daily-hub-muted"
    });

    const rules = section.createDiv({ cls: "daily-hub-rule-list" });
    for (const rule of this.draft.rules.filter((candidate) => candidate.role === role)) {
      this.renderRule(rules, rule);
    }

    const addRule = section.createEl("button", { text: addLabel, cls: "daily-hub-add-rule" });
    addRule.addEventListener("click", () => {
      this.draft.rules.push(createEmptyRule(role));
      this.render();
    });
  }

  private renderRule(container: HTMLElement, rule: GoalRule): void {
    const item = container.createDiv({ cls: "daily-hub-rule-item" });
    const row = item.createDiv({ cls: "daily-hub-rule" });

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

    if (rule.role === "primary") {
      const passive = item.createDiv({ cls: "daily-hub-rule-afk" });
      const checkboxId = `daily-hub-rule-afk-${rule.id}`;
      const checkbox = passive.createEl("input", {
        type: "checkbox",
        attr: { id: checkboxId, "aria-label": "Count while AFK" }
      });
      checkbox.checked = rule.countDuringAfk;
      checkbox.addEventListener("change", () => { rule.countDuringAfk = checkbox.checked; });

      const copy = passive.createDiv();
      copy.createEl("label", { text: "Count while AFK", attr: { for: checkboxId } });
      copy.createEl("div", {
        text: "Useful for passive activities such as video lessons. The rule must still match the current foreground activity.",
        cls: "daily-hub-muted"
      });
    }
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
    if (!Number.isFinite(this.draft.contextTimeoutMinutes) || this.draft.contextTimeoutMinutes <= 0) {
      new Notice("Daily Hub: context timeout must be greater than zero");
      return;
    }
    if (!this.draft.rules.some((rule) => rule.role === "primary")
      || this.draft.rules.some((rule) => rule.value.length === 0)) {
      new Notice("Daily Hub: add at least one complete primary rule");
      return;
    }

    await this.plugin.upsertGoal(this.draft);
    this.close();
  }
}
