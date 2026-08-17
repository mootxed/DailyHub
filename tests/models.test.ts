import { describe, expect, it } from "vitest";
import { createEmptyRule, updateGoalEnabled, type DailyGoal } from "../src/models";

describe("goal mutations", () => {
  it("uses URL for new primary rules and Application for continuation rules", () => {
    expect(createEmptyRule("primary")).toMatchObject({ role: "primary", field: "url" });
    expect(createEmptyRule("continuation")).toMatchObject({ role: "continuation", field: "application" });
  });

  it("changes only enabled on the latest stored goal", () => {
    const staleSnapshot: DailyGoal = {
      id: "devops",
      name: "DevOps",
      targetMinutes: 90,
      contextTimeoutMinutes: 10,
      enabled: true,
      rules: [{
        id: "docs",
        role: "primary",
        field: "url",
        operator: "contains",
        value: "docs.example.com",
        countDuringAfk: false
      }]
    };
    const goals = [structuredClone(staleSnapshot)];
    const latest = goals[0];
    if (latest === undefined) throw new Error("Expected test goal");
    latest.name = "Updated DevOps";
    latest.contextTimeoutMinutes = 20;
    latest.rules = [
      {
        id: "stepik",
        role: "primary",
        field: "url",
        operator: "contains",
        value: "stepik.org",
        countDuringAfk: true
      },
      {
        id: "terminal",
        role: "continuation",
        field: "application",
        operator: "contains",
        value: "terminal"
      }
    ];
    const originalRules = structuredClone(latest.rules);

    expect(updateGoalEnabled(goals, staleSnapshot.id, false)).toBe(true);
    expect(goals[0]).toMatchObject({
      name: "Updated DevOps",
      targetMinutes: 90,
      contextTimeoutMinutes: 20,
      enabled: false,
      rules: originalRules
    });
  });

  it("does nothing when the goal no longer exists", () => {
    expect(updateGoalEnabled([], "missing", false)).toBe(false);
  });
});
