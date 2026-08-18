import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ActivityWatchClient } from "./activity-watch";
import {
  configureAfkTimeout,
  inspectAfkConfig,
  RECOMMENDED_AFK_TIMEOUT_SECONDS,
  type AfkConfigStatus
} from "./afk-config";
import { GoalEditorModal } from "./goal-editor";
import {
  getIdentityColor,
  IDENTITY_COLOR_COUNT,
  IDENTITY_COLOR_NAMES
} from "./identity-color";
import { createEmptyActivityCategory, createId, type ActivityCategory } from "./models";
import type DailyHubPlugin from "./main";

const DOWNLOAD_URL = "https://activitywatch.net/downloads/";
const BROWSER_WATCHER_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-browser";
const AFK_CONFIGURATION_URL = "https://docs.activitywatch.net/en/latest/configuration.html#aw-watcher-afk";

export class DailyHubSettingTab extends PluginSettingTab {
  private readonly plugin: DailyHubPlugin;

  constructor(app: App, plugin: DailyHubPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("daily-hub-settings");
    containerEl.createEl("h1", { text: "Daily Hub" });
    containerEl.createEl("p", {
      text: "Connect activity tracking and manage the goals shown on your dashboard.",
      cls: "daily-hub-settings-intro"
    });
    containerEl.createEl("h2", { text: "Activity tracking" });

    new Setting(containerEl)
      .setName("ActivityWatch URL")
      .setDesc("Local ActivityWatch server. Daily Hub does not send activity elsewhere.")
      .addText((text) => text
        .setPlaceholder("http://localhost:5600")
        .setValue(this.plugin.data.settings.activityWatchUrl)
        .onChange(async (value) => {
          this.plugin.data.settings.activityWatchUrl = value.trim();
          await this.plugin.savePluginData();
        }));

    this.renderAfkTracking(containerEl);

    new Setting(containerEl)
      .setName("Refresh interval")
      .setDesc("Seconds between dashboard updates (minimum 10).")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "10";
        text.setValue(String(this.plugin.data.settings.refreshIntervalSeconds)).onChange(async (value) => {
          const seconds = Number(value);
          if (Number.isFinite(seconds) && seconds >= 10) {
            this.plugin.data.settings.refreshIntervalSeconds = seconds;
            await this.plugin.savePluginData();
            this.plugin.resetRefreshInterval();
          }
        });
      });

    new Setting(containerEl)
      .setName("Completion notifications")
      .setDesc("Notify once when a goal first reaches its daily minimum.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.settings.completionNotifications)
        .onChange(async (value) => {
          this.plugin.data.settings.completionNotifications = value;
          await this.plugin.savePluginData();
        }));

    const connection = new Setting(containerEl).setName("ActivityWatch connection");
    connection.setDesc("Checking…");
    connection.addButton((button) => button.setButtonText("Check again").onClick(() => {
      void this.updateConnectionStatus(connection);
    }));
    connection.addButton((button) => button.setButtonText("Install ActivityWatch").onClick(() => {
      window.open(DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    }));
    void this.updateConnectionStatus(connection);

    new Setting(containerEl)
      .setName("Browser URL tracking")
      .setDesc("URL rules require an ActivityWatch browser watcher; browsers do not allow safe automatic installation.")
      .addButton((button) => button.setButtonText("Open browser watcher instructions").onClick(() => {
        window.open(BROWSER_WATCHER_URL, "_blank", "noopener,noreferrer");
      }));

    this.renderActivityCategories(containerEl);

    containerEl.createEl("h2", { text: "Daily goals" });
    containerEl.createEl("p", {
      text: "Goals are measured automatically from matching apps, windows, and websites.",
      cls: "daily-hub-settings-section-copy"
    });
    new Setting(containerEl)
      .setName("Add goal")
      .setDesc("Rules within each section use OR logic.")
      .addButton((button) => button.setCta().setButtonText("Add goal").onClick(() => {
        new GoalEditorModal(this.plugin, undefined, () => this.display()).open();
      }));

    if (this.plugin.data.goals.length === 0) {
      containerEl.createEl("p", { text: "No goals configured.", cls: "daily-hub-muted" });
    }

    for (const goal of this.plugin.data.goals) {
      new Setting(containerEl)
        .setName(goal.name)
        .setDesc(`${goal.targetMinutes} min · ${goal.rules.length} rule${goal.rules.length === 1 ? "" : "s"}`)
        .addToggle((toggle) => toggle.setValue(goal.enabled).onChange(async (value) => {
          await this.plugin.setGoalEnabled(goal.id, value);
          this.display();
        }))
        .addButton((button) => button.setButtonText("Edit").onClick(() => {
          const currentGoal = this.plugin.data.goals.find((candidate) => candidate.id === goal.id);
          if (currentGoal !== undefined) {
            new GoalEditorModal(this.plugin, currentGoal, () => this.display()).open();
          }
        }))
        .addButton((button) => button.setWarning().setButtonText("Delete").onClick(async () => {
          if (window.confirm(`Delete daily goal “${goal.name}”?`)) {
            await this.plugin.deleteGoal(goal.id);
            this.display();
          }
        }));
    }
  }

  private renderActivityCategories(container: HTMLElement): void {
    container.createEl("h2", { text: "Activity categories" });
    container.createEl("p", {
      text: "Categories classify foreground activity from top to bottom. Changing a rule reclassifies historical activity; raw ActivityWatch history is not copied into your vault.",
      cls: "daily-hub-settings-section-copy"
    });
    new Setting(container)
      .setName("Add category")
      .setDesc("Categories have no target, completion, schedule, or timer.")
      .addButton((button) => button.setCta().setButtonText("Add category").onClick(async () => {
        this.plugin.data.activityCategories.push(createEmptyActivityCategory());
        await this.plugin.savePluginData();
        await this.plugin.refreshViews();
        this.display();
      }));

    if (this.plugin.data.activityCategories.length === 0) {
      container.createEl("p", {
        text: "No categories configured. All computer activity is currently Uncategorized.",
        cls: "daily-hub-muted"
      });
      return;
    }

    this.plugin.data.activityCategories.forEach((category, index) => {
      this.renderActivityCategory(container, category, index);
    });
  }

  private renderActivityCategory(container: HTMLElement, category: ActivityCategory, index: number): void {
    const card = container.createDiv({ cls: "daily-hub-category-settings" });
    new Setting(card)
      .setName(`Category ${index + 1}`)
      .setDesc("The first matching category wins.")
      .addText((text) => text.setValue(category.name).onChange(async (value) => {
        const name = value.trim();
        if (name.length === 0) return;
        category.name = name;
        await this.plugin.savePluginData();
        await this.plugin.refreshViews();
      }))
      .addButton((button) => button.setIcon("arrow-up").setTooltip("Move up").setDisabled(index === 0).onClick(async () => {
        const previous = this.plugin.data.activityCategories[index - 1];
        if (previous === undefined) return;
        this.plugin.data.activityCategories[index - 1] = category;
        this.plugin.data.activityCategories[index] = previous;
        await this.plugin.savePluginData();
        await this.plugin.refreshViews();
        this.display();
      }))
      .addButton((button) => button.setIcon("arrow-down").setTooltip("Move down")
        .setDisabled(index === this.plugin.data.activityCategories.length - 1).onClick(async () => {
          const next = this.plugin.data.activityCategories[index + 1];
          if (next === undefined) return;
          this.plugin.data.activityCategories[index + 1] = category;
          this.plugin.data.activityCategories[index] = next;
          await this.plugin.savePluginData();
          await this.plugin.refreshViews();
          this.display();
        }))
      .addButton((button) => button.setWarning().setIcon("trash-2").setTooltip("Delete category").onClick(async () => {
        if (!window.confirm(`Delete activity category “${category.name}”? Activity will become Uncategorized.`)) return;
        this.plugin.data.activityCategories = this.plugin.data.activityCategories.filter((item) => item.id !== category.id);
        await this.plugin.savePluginData();
        await this.plugin.refreshViews();
        this.display();
      }));

    const colorSetting = new Setting(card)
      .setName("Identity color")
      .setDesc("Use a stable automatic color or choose a shared identity color.");
    const colors = colorSetting.controlEl.createDiv({
      cls: "daily-hub-color-picker",
      attr: { role: "group", "aria-label": `${category.name} color` }
    });
    const choices: { label: string; value: number | undefined }[] = [
      { label: "Automatic", value: undefined },
      ...Array.from({ length: IDENTITY_COLOR_COUNT }, (_, colorIndex) => ({
        label: IDENTITY_COLOR_NAMES[colorIndex] ?? `Color ${colorIndex + 1}`,
        value: colorIndex
      }))
    ];
    for (const choice of choices) {
      const selected = category.colorIndex === choice.value;
      const button = colors.createEl("button", {
        cls: `daily-hub-color-choice${choice.value === undefined ? " is-auto" : ""}${selected ? " is-selected" : ""}`,
        text: choice.value === undefined ? "Auto" : "",
        attr: { type: "button", "aria-label": choice.label, "aria-pressed": String(selected) }
      });
      if (choice.value !== undefined) {
        const swatch = button.createSpan({
          cls: "daily-hub-color-swatch",
          attr: { "aria-hidden": "true" }
        });
        swatch.style.setProperty(
          "--dh-identity-color",
          getIdentityColor("category", category.id, choice.value)
        );
      }
      button.addEventListener("click", async () => {
        category.colorIndex = choice.value;
        await this.plugin.savePluginData();
        await this.plugin.refreshViews();
        this.display();
      });
    }

    category.rules.forEach((rule) => {
      new Setting(card)
        .setName("Classification rule")
        .addDropdown((dropdown) => dropdown
          .addOption("application", "Application")
          .addOption("domain", "Domain")
          .addOption("windowTitle", "Window title")
          .setValue(rule.field)
          .onChange(async (value) => {
            if (value !== "application" && value !== "domain" && value !== "windowTitle") return;
            rule.field = value;
            await this.plugin.savePluginData();
            await this.plugin.refreshViews();
          }))
        .addDropdown((dropdown) => dropdown
          .addOption("contains", "Contains")
          .addOption("equals", "Equals")
          .setValue(rule.operator)
          .onChange(async (value) => {
            if (value !== "contains" && value !== "equals") return;
            rule.operator = value;
            await this.plugin.savePluginData();
            await this.plugin.refreshViews();
          }))
        .addText((text) => text.setPlaceholder("Value").setValue(rule.value).onChange(async (value) => {
          rule.value = value;
          await this.plugin.savePluginData();
          await this.plugin.refreshViews();
        }))
        .addButton((button) => button.setIcon("x").setTooltip("Remove rule").onClick(async () => {
          category.rules = category.rules.filter((item) => item.id !== rule.id);
          await this.plugin.savePluginData();
          await this.plugin.refreshViews();
          this.display();
        }));
    });

    new Setting(card)
      .setName("Rules")
      .setDesc(category.rules.length === 0 ? "No rules: this category does not match activity." : "Rules within this category use OR logic.")
      .addButton((button) => button.setButtonText("Add rule").onClick(async () => {
        category.rules.push({
          id: createId(),
          field: "application",
          operator: "contains",
          value: ""
        });
        await this.plugin.savePluginData();
        this.display();
      }));
  }

  private async updateConnectionStatus(setting: Setting): Promise<void> {
    const client = new ActivityWatchClient(this.plugin.data.settings.activityWatchUrl);
    const status = await client.getStatus();
    const details = [status.message];
    if (status.kind === "connected" && !status.windowWatcherAvailable) {
      details.push("Window watcher not found; application, window-title, and URL rules require it.");
    }
    if (status.kind === "connected" && !status.afkWatcherAvailable) details.push("AFK watcher not found.");
    if (status.kind === "connected" && !status.browserWatcherAvailable) details.push("Browser watcher not found.");
    setting.setDesc(details.join(" "));
  }

  private renderAfkTracking(container: HTMLElement): void {
    const setting = new Setting(container)
      .setName("AFK tracking")
      .setDesc("Checking ActivityWatch AFK configuration…")
      .addButton((button) => button.setButtonText("Configure ActivityWatch").onClick(async () => {
        const status = await inspectAfkConfig();
        if (status.configPath === undefined || status.kind === "missing" || status.kind === "error") {
          new Notice("Daily Hub: ActivityWatch AFK config was not found. Use the official instructions.");
          await this.updateAfkStatus(setting);
          return;
        }
        const confirmed = window.confirm(
          `Set ActivityWatch AFK timeout to ${RECOMMENDED_AFK_TIMEOUT_SECONDS} seconds?\n\n`
          + `Daily Hub will create a backup before updating:\n${status.configPath}`
        );
        if (!confirmed) return;

        button.setDisabled(true);
        try {
          const result = await configureAfkTimeout();
          new Notice(`Daily Hub: ActivityWatch AFK timeout set to 60 seconds. Restart ActivityWatch.\nBackup: ${result.backupPath}`, 10000);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[Daily Hub] Could not configure ActivityWatch AFK timeout: ${detail}`);
          new Notice(`Daily Hub: could not update ActivityWatch AFK config. ${detail}`);
        } finally {
          button.setDisabled(false);
          await this.updateAfkStatus(setting);
        }
      }))
      .addButton((button) => button.setButtonText("Official instructions").onClick(() => {
        window.open(AFK_CONFIGURATION_URL, "_blank", "noopener,noreferrer");
      }));
    void this.updateAfkStatus(setting);
  }

  private async updateAfkStatus(setting: Setting): Promise<void> {
    setting.setDesc(this.afkStatusDescription(await inspectAfkConfig()));
  }

  private afkStatusDescription(status: AfkConfigStatus): string {
    const explanation = "ActivityWatch controls when you become AFK. Daily Hub excludes AFK time unless a matching Primary rule explicitly allows it. Recommended timeout: 60 seconds.";
    switch (status.kind) {
      case "configured":
        return `${explanation} Config file timeout: 60 sec ✓`;
      case "different":
        return `${explanation} Config file timeout: ${status.timeoutSeconds ?? "unknown"} sec.`;
      case "not-explicit":
        return `${explanation} The timeout is not explicitly set, so Daily Hub cannot detect the effective value.`;
      case "missing":
        return `${explanation} ActivityWatch config was not found at the documented Linux path.`;
      case "unsupported":
        return `${explanation} ${status.message ?? "Automatic configuration is unavailable."}`;
      case "error":
        return `${explanation} Daily Hub could not safely read the config file.`;
    }
  }
}
