import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard composition", () => {
  const viewSource = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const dashboardStart = viewSource.indexOf("  private renderDashboard(");
  const dashboardEnd = viewSource.indexOf("  private renderHudMetric(", dashboardStart);
  const dashboard = viewSource.slice(dashboardStart, dashboardEnd);

  it("places goals directly after date navigation and before the day overview and plan", () => {
    const markers = [
      "this.renderDateNavigator(bento, today);",
      "this.renderGoalsSection(bento, enabledGoals",
      "daily-hub-day-overview daily-hub-bento-day",
      "this.renderDayPlan(bento",
      "renderActivityBreakdownView(bento",
      "renderDayTimelineView(bento",
      "this.renderActivityChart(analyticsLayout"
    ];
    const positions = markers.map((marker) => dashboard.indexOf(marker));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("keeps the chart full-width and moves weekly cards to a two-column rail below it", () => {
    expect(styles).not.toContain("grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr)");
    expect(styles).toMatch(
      /@container \(min-width: 760px\)[\s\S]*?\.daily-hub-analytics-rail\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/
    );
    expect(styles).toMatch(
      /\.daily-hub-line-chart\s*\{[\s\S]*?height: clamp\(260px, 32cqi, 340px\);[\s\S]*?min-width: 720px;/
    );
  });
});
