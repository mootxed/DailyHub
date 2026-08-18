import { Modal, Notice, Setting } from "obsidian";
import { GoalDeletionAction, isDeleteGoalAvailable } from "./goal-deletion";
import type DailyHubPlugin from "./main";
import {
  createEmptyGoal,
  createEmptyRule,
  WEEKDAYS,
  type DailyGoal,
  type GoalRule,
  type GoalRuleRole,
  type GoalSchedule,
  type Weekday
} from "./models";
import {
  applyDefaultTargetToAllDays,
  getCustomTargetWeekdays,
  getGoalSchedule,
  isValidTargetMinutes,
  parseDefaultTargetInput,
  updateDefaultTarget
} from "./schedule";

function copyGoal(goal: DailyGoal): DailyGoal {
  const schedule = getGoalSchedule(goal);
  return {
    ...goal,
    schedule: Object.fromEntries(WEEKDAYS.map((weekday) => [weekday, { ...schedule[weekday] }])) as GoalSchedule,
    overrides: structuredClone(goal.overrides ?? {}),
    trackingPauses: structuredClone(goal.trackingPauses ?? []),
    rules: goal.rules.map((rule) => ({ ...rule }))
  };
}

class DeleteGoalConfirmationModal extends Modal {
  private cancelButton: HTMLButtonElement | undefined;
  private deleteButton: HTMLButtonElement | undefined;

  constructor(
    plugin: DailyHubPlugin,
    private readonly goalName: string,
    private readonly deletion: GoalDeletionAction,
    private readonly onDeleted: () => void
  ) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.modalEl.addClass("daily-hub-modal", "daily-hub-delete-modal");
    this.titleEl.setText(`Delete "${this.goalName}"?`);
    this.contentEl.createEl("p", {
      text: "This permanently removes the goal, its schedule, and its tracking rules.",
      cls: "daily-hub-modal-intro"
    });

    const actions = this.contentEl.createDiv({ cls: "daily-hub-modal-actions" });
    this.cancelButton = actions.createEl("button", { text: "Cancel" });
    this.cancelButton.addEventListener("click", () => {
      this.deletion.cancel();
      this.close();
    });
    this.deleteButton = actions.createEl("button", { text: "Delete", cls: "mod-warning" });
    this.deleteButton.addEventListener("click", () => { void this.confirmDeletion(); });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async confirmDeletion(): Promise<void> {
    this.setButtonsDisabled(true);
    try {
      if (!await this.deletion.confirm()) return;
      this.close();
      this.onDeleted();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Daily Hub] Could not delete goal: ${detail}`);
      new Notice(`Daily Hub: could not delete goal. ${detail}`);
      this.setButtonsDisabled(false);
    }
  }

  private setButtonsDisabled(disabled: boolean): void {
    if (this.cancelButton !== undefined) this.cancelButton.disabled = disabled;
    if (this.deleteButton !== undefined) this.deleteButton.disabled = disabled;
  }
}

export class GoalEditorModal extends Modal {
  private readonly plugin: DailyHubPlugin;
  private draft: DailyGoal;
  private readonly onSaved: (() => void) | undefined;
  private readonly scheduleTargetInputs = new Map<Weekday, HTMLInputElement>();
  private readonly protectedWeekdays: Set<Weekday>;
  private readonly editingExistingGoal: boolean;
  private defaultTargetValue: string;

  constructor(plugin: DailyHubPlugin, goal?: DailyGoal, onSaved?: () => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.draft = goal === undefined ? createEmptyGoal() : copyGoal(goal);
    this.onSaved = onSaved;
    this.editingExistingGoal = goal !== undefined;
    this.defaultTargetValue = String(this.draft.targetMinutes);
    this.protectedWeekdays = getCustomTargetWeekdays(this.draft);
  }

  override onOpen(): void {
    this.modalEl.addClass("daily-hub-modal", "daily-hub-goal-editor-modal");
    this.titleEl.setText(this.plugin.hasGoal(this.draft.id) ? "Edit goal" : "Add goal");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.scheduleTargetInputs.clear();

    this.contentEl.createEl("p", {
      text: "Define what counts, when to track it, and the target for each day.",
      cls: "daily-hub-modal-intro"
    });
    const general = this.contentEl.createDiv({ cls: "daily-hub-form-section" });
    general.createEl("h3", { text: "General" });

    new Setting(general)
      .setName("Name")
      .addText((text) => text
        .setPlaceholder("Typing practice")
        .setValue(this.draft.name)
        .onChange((value) => { this.draft.name = value; }));

    new Setting(general)
      .setName("Default target")
      .setDesc("Default minutes for recurring schedule days. Custom weekday targets stay unchanged.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.setValue(this.defaultTargetValue).onChange((value) => {
          this.defaultTargetValue = value;
          const targetMinutes = parseDefaultTargetInput(value);
          if (targetMinutes === undefined) return;
          this.draft = updateDefaultTarget(this.draft, targetMinutes, this.protectedWeekdays);
          this.refreshScheduleTargetInputs();
        });
      });

    new Setting(general)
      .setName("Enabled")
      .addToggle((toggle) => toggle.setValue(this.draft.enabled).onChange((value) => {
        this.draft.enabled = value;
      }));

    const tracking = this.contentEl.createDiv({ cls: "daily-hub-form-section daily-hub-tracking-section" });
    tracking.createEl("h3", { text: "Tracking rules" });
    tracking.createEl("p", {
      text: "Primary rules start a session. Continuation rules can keep it active while the context window is open.",
      cls: "daily-hub-muted"
    });
    this.renderRuleSection(
      tracking,
      "primary",
      "Primary rules",
      "These activities directly identify and count toward this goal.",
      "Add primary rule"
    );
    this.renderRuleSection(
      tracking,
      "continuation",
      "Continuation rules",
      "Activities allowed shortly after a Primary match. They do not extend the context timeout.",
      "Add continuation rule"
    );
    this.renderSchedule();

    const advanced = this.contentEl.createDiv({ cls: "daily-hub-form-section" });
    advanced.createEl("h3", { text: "Advanced context" });
    new Setting(advanced)
      .setName("Context timeout (minutes)")
      .setDesc(
        "How long continuation activities may count after the most recent Primary activity. "
        + "Continuation rules do not extend this timeout."
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.setAttribute("aria-label", "Context timeout in minutes");
        text.setValue(String(this.draft.contextTimeoutMinutes)).onChange((value) => {
          this.draft.contextTimeoutMinutes = Number(value);
        });
      });

    const actions = this.contentEl.createDiv({ cls: "daily-hub-modal-actions" });
    if (isDeleteGoalAvailable(this.plugin, this.draft.id)) {
      const remove = actions.createEl("button", { text: "Delete goal", cls: "mod-warning" });
      remove.addEventListener("click", () => { this.confirmDelete(); });
    }
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "Save goal", cls: "mod-cta" });
    save.addEventListener("click", () => { void this.save(); });
  }

  private renderSchedule(): void {
    const schedule = getGoalSchedule(this.draft);
    this.draft.schedule = schedule;
    const section = this.contentEl.createDiv({ cls: "daily-hub-form-section daily-hub-schedule-section" });
    section.createEl("h3", { text: "Schedule" });
    section.createEl("p", {
      text: "Changing the default updates days that still use the previous default. Rest days do not affect streaks.",
      cls: "daily-hub-muted"
    });
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const rows = section.createDiv({ cls: "daily-hub-schedule" });
    WEEKDAYS.forEach((weekday, index) => {
      const day = schedule[weekday];
      const row = rows.createDiv({ cls: "daily-hub-schedule-row" });
      const checkboxId = `daily-hub-schedule-${this.draft.id}-${weekday}`;
      const checkbox = row.createEl("input", { type: "checkbox", attr: { id: checkboxId } });
      checkbox.checked = day.enabled;
      row.createEl("label", { text: labels[index] ?? weekday, attr: { for: checkboxId } });
      const target = row.createEl("input", {
        type: "number",
        value: String(day.targetMinutes),
        attr: { min: "1", "aria-label": `${labels[index] ?? weekday} target minutes` }
      });
      this.scheduleTargetInputs.set(weekday, target);
      target.disabled = !day.enabled;
      const suffix = row.createEl("span", { text: day.enabled ? "min" : "Rest", cls: "daily-hub-muted" });
      checkbox.addEventListener("change", () => {
        const currentDay = getGoalSchedule(this.draft)[weekday];
        currentDay.enabled = checkbox.checked;
        target.disabled = !currentDay.enabled;
        suffix.setText(currentDay.enabled ? "min" : "Rest");
      });
      target.addEventListener("input", () => {
        this.protectedWeekdays.add(weekday);
        getGoalSchedule(this.draft)[weekday].targetMinutes = Number(target.value);
      });
    });
    const applyDefault = section.createEl("button", {
      text: "Apply default target to all days",
      cls: "daily-hub-schedule-apply"
    });
    applyDefault.addEventListener("click", () => {
      this.draft = applyDefaultTargetToAllDays(this.draft);
      this.protectedWeekdays.clear();
      this.render();
    });
  }

  private refreshScheduleTargetInputs(): void {
    const schedule = getGoalSchedule(this.draft);
    for (const weekday of WEEKDAYS) {
      const input = this.scheduleTargetInputs.get(weekday);
      if (input !== undefined) input.value = String(schedule[weekday].targetMinutes);
    }
  }

  private renderRuleSection(
    container: HTMLElement,
    role: GoalRuleRole,
    title: string,
    description: string,
    addLabel: string
  ): void {
    const section = container.createDiv({ cls: "daily-hub-rule-section" });
    section.createEl("h4", { text: title });
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
    if (this.editingExistingGoal && !this.plugin.hasGoal(this.draft.id)) {
      new Notice("Daily Hub: this goal no longer exists");
      this.onSaved?.();
      this.close();
      return;
    }
    this.draft.name = this.draft.name.trim();
    this.draft.rules = this.draft.rules.map((rule) => ({ ...rule, value: rule.value.trim() }));
    if (this.draft.name.length === 0) {
      new Notice("Daily Hub: enter a goal name");
      return;
    }
    const defaultTarget = parseDefaultTargetInput(this.defaultTargetValue);
    if (defaultTarget === undefined) {
      new Notice("Daily Hub: default target must be at least one minute");
      return;
    }
    const schedule = getGoalSchedule(this.draft);
    if (WEEKDAYS.some((weekday) => schedule[weekday].enabled
      && !isValidTargetMinutes(schedule[weekday].targetMinutes))) {
      new Notice("Daily Hub: every active schedule day needs a target of at least one minute");
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
    this.onSaved?.();
    this.close();
  }

  private confirmDelete(): void {
    const deletion = new GoalDeletionAction(this.plugin, this.draft.id);
    new DeleteGoalConfirmationModal(this.plugin, this.draft.name, deletion, () => {
      this.onSaved?.();
      this.close();
    }).open();
  }
}
