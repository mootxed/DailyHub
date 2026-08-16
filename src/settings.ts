import { App, PluginSettingTab, Setting } from "obsidian";
import { ActivityWatchClient } from "./activity-watch";
import { GoalEditorModal } from "./goal-editor";
import type DailyHubPlugin from "./main";

const DOWNLOAD_URL = "https://activitywatch.net/downloads/";
const BROWSER_WATCHER_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-browser";

export class DailyHubSettingTab extends PluginSettingTab {
  private readonly plugin: DailyHubPlugin;

  constructor(app: App, plugin: DailyHubPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h1", { text: "Daily Hub" });

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

    new Setting(containerEl)
      .setName("AFK threshold")
      .setDesc("AFK events at least this long are excluded. Default: 60 seconds.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.setValue(String(this.plugin.data.settings.afkThresholdSeconds)).onChange(async (value) => {
          const seconds = Number(value);
          if (Number.isFinite(seconds) && seconds >= 1) {
            this.plugin.data.settings.afkThresholdSeconds = seconds;
            await this.plugin.savePluginData();
          }
        });
      });

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
    new Setting(containerEl)
      .setName("Add goal")
      .setDesc("Rules within a goal use OR logic.")
      .addButton((button) => button.setCta().setButtonText("Add goal").onClick(() => {
        new GoalEditorModal(this.plugin).open();
      }));

    if (this.plugin.data.goals.length === 0) {
      containerEl.createEl("p", { text: "No goals configured.", cls: "daily-hub-muted" });
    }

    for (const goal of this.plugin.data.goals) {
      new Setting(containerEl)
        .setName(goal.name)
        .setDesc(`${goal.targetMinutes} min · ${goal.rules.length} rule${goal.rules.length === 1 ? "" : "s"}`)
        .addToggle((toggle) => toggle.setValue(goal.enabled).onChange(async (value) => {
          await this.plugin.upsertGoal({ ...goal, enabled: value });
          this.display();
        }))
        .addButton((button) => button.setButtonText("Edit").onClick(() => {
          new GoalEditorModal(this.plugin, goal).open();
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
    setting.setDesc(status.message);
  }
}
