import { Modal } from "obsidian";
import { getGoalColor } from "./activity-chart";
import type DailyHubPlugin from "./main";
import { ruleMatches } from "./matcher";
import type { DailyGoal } from "./models";
import { BROWSER_CONTEXT_GRACE_MS, resolveTrackingAtDetailed, type TrackingDiagnosticReason } from "./progress";

const REASON_LABELS: Record<TrackingDiagnosticReason, string> = {
  "tracking-now": "Tracking now",
  paused: "Goal is paused",
  "not-tracking-yet": "Goal tracking has not started yet",
  "afk-blocked": "AFK interval blocks this rule",
  "primary-mismatch": "Current context does not match primary rules",
  "watcher-unavailable": "A required ActivityWatch watcher is unavailable",
  "overlap-lost": "Another goal won overlap resolution",
  "no-current-activity": "No fresh ActivityWatch event is available"
};

export class TrackingDiagnosticsModal extends Modal {
  constructor(private readonly plugin: DailyHubPlugin, private readonly goal: DailyGoal) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.modalEl.addClass("daily-hub-modal", "daily-hub-diagnostics-modal");
    this.titleEl.setText("Tracking diagnostics");
    this.contentEl.createEl("p", {
      text: "A private, on-demand snapshot from the same resolver used by live tracking.",
      cls: "daily-hub-modal-intro"
    });
    const loading = this.contentEl.createEl("p", { text: "Checking current activity…", attr: { role: "status" } });
    void this.load(loading);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async load(loading: HTMLElement): Promise<void> {
    const now = new Date();
    const maximumContextMs = this.plugin.data.goals.reduce(
      (maximum, goal) => Math.max(maximum, goal.contextTimeoutMinutes * 60_000), 0
    );
    const lookbackMs = Math.max(5 * 60_000, maximumContextMs + BROWSER_CONTEXT_GRACE_MS);
    const start = new Date(now.getTime() - lookbackMs);
    const snapshot = await this.plugin.getRecentActivitySnapshot(start, now);
    if (!loading.isConnected) return;
    loading.remove();
    const diagnostics = resolveTrackingAtDetailed(
      this.plugin.data.goals, snapshot.activity, now.getTime(), start.getTime(), snapshot.status
    );
    const candidate = diagnostics.candidates.find((item) => item.goalId === this.goal.id);
    const section = this.contentEl.createDiv({ cls: "daily-hub-diagnostics" });
    const goalRow = this.row(section, "Goal", this.goal.name);
    goalRow.addClass("is-goal");
    goalRow.style.setProperty("--dh-goal-color", getGoalColor(this.goal.id, this.goal.colorIndex));

    section.createEl("h3", { text: "Current context" });
    this.row(section, "URL", diagnostics.context.url ?? "—");
    this.row(section, "Application", diagnostics.context.application ?? "—");
    this.row(section, "Window title", diagnostics.context.windowTitle ?? "—");
    this.row(section, "AFK", diagnostics.afk ? "Yes" : "No");

    section.createEl("h3", { text: "Primary rules" });
    for (const rule of this.goal.rules.filter((item) => item.role === "primary")) {
      this.row(
        section,
        ruleMatches(rule, diagnostics.context) ? "✓" : "×",
        `${rule.field} ${rule.operator} ${rule.value}`
      );
    }

    section.createEl("h3", { text: "ActivityWatch" });
    this.row(section, snapshot.status.windowWatcherAvailable ? "✓" : "×", "Window watcher");
    this.row(section, snapshot.status.browserWatcherAvailable ? "✓" : "×", "Browser watcher");
    this.row(section, snapshot.status.afkWatcherAvailable ? "✓" : "×", "AFK watcher");
    this.row(
      section,
      "Browser evidence",
      diagnostics.browserEvidenceAgeSeconds === undefined
        ? "None" : `${Math.round(diagnostics.browserEvidenceAgeSeconds)} sec ago`
    );
    this.row(section, "Resolved goal", diagnostics.winnerGoalId === undefined
      ? "—"
      : this.plugin.data.goals.find((goal) => goal.id === diagnostics.winnerGoalId)?.name ?? diagnostics.winnerGoalId);

    section.createEl("h3", { text: "Result" });
    const result = section.createDiv({ cls: `daily-hub-diagnostics-result${candidate?.reason === "tracking-now" ? " is-tracking" : ""}` });
    result.createEl("strong", { text: candidate?.reason === "tracking-now" ? "Tracking now" : "Not tracking" });
    result.createEl("span", { text: candidate === undefined ? "Goal is unavailable" : REASON_LABELS[candidate.reason] });
  }

  private row(container: HTMLElement, label: string, value: string): HTMLElement {
    const row = container.createDiv({ cls: "daily-hub-diagnostics-row" });
    row.createEl("span", { text: label });
    row.createEl("strong", { text: value });
    return row;
  }
}
