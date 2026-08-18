import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ActivityWatchClient } from "./activity-watch";
import {
  configureAfkTimeout,
  inspectAfkConfig,
  RECOMMENDED_AFK_TIMEOUT_SECONDS,
  type AfkConfigStatus
} from "./afk-config";
import { GoalEditorModal } from "./goal-editor";
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
