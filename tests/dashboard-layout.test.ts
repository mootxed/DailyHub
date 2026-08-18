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

  it("keeps the trend chart full-width but visually subordinate to the day timeline", () => {
    expect(styles).not.toContain("grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr)");
    expect(styles).toMatch(
      /@container \(min-width: 760px\)[\s\S]*?\.daily-hub-analytics-rail\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/
    );
    expect(styles).toMatch(
      /\.daily-hub-line-chart\s*\{[\s\S]*?height: clamp\(230px, 26cqi, 260px\);[\s\S]*?min-width: 680px;/
    );
    expect(styles).toMatch(
      /\.daily-hub-day-timeline-content\s*\{[\s\S]*?--dh-timeline-label-width: 176px;/
    );
    expect(styles).toMatch(
      /\.daily-hub-day-timeline-row\s*\{[\s\S]*?height: 38px;/
    );
    expect(styles).toMatch(
      /button\.daily-hub-day-timeline-segment\s*\{[\s\S]*?height: 15px;/
    );
  });
});
