import { describe, expect, it } from "vitest";
import { goalMatches, pickMatchingGoal, ruleMatches } from "../src/matcher";
import type { DailyGoal, GoalRule } from "../src/models";

function rule(field: GoalRule["field"], value: string, operator: GoalRule["operator"] = "contains"): GoalRule {
  return { id: `${field}-${value}`, field, operator, value };
}

function goal(rules: GoalRule[]): DailyGoal {
  return { id: "goal", name: "Goal", targetMinutes: 30, rules, enabled: true };
}

describe("activity matching", () => {
  it("matches a URL case-insensitively", () => {
    expect(ruleMatches(rule("url", "keybr.com"), { url: "https://www.KEYBR.com/profile" })).toBe(true);
  });

  it("matches an application with equals", () => {
    expect(ruleMatches(rule("application", "kitty", "equals"), { application: "Kitty" })).toBe(true);
    expect(ruleMatches(rule("application", "kitty", "equals"), { application: "kitty-terminal" })).toBe(false);
  });

  it("matches a window title", () => {
    expect(ruleMatches(rule("windowTitle", "Stepik"), { windowTitle: "DevOps — Stepik" })).toBe(true);
  });

  it("uses OR semantics for multiple rules", () => {
    const candidate = goal([rule("url", "example.invalid"), rule("application", "terminal")]);
    expect(goalMatches(candidate, { application: "GNOME Terminal" })).toBe(true);
  });

  it("ignores blank and disabled rules", () => {
    expect(ruleMatches(rule("url", "  "), { url: "https://example.com" })).toBe(false);
    expect(goalMatches({ ...goal([rule("url", "example.com")]), enabled: false }, { url: "https://example.com" })).toBe(false);
  });

  it("resolves overlapping goals deterministically by stable id", () => {
    const later = { ...goal([rule("application", "kitty", "equals")]), id: "z-goal" };
    const earlier = { ...goal([rule("application", "kitty", "equals")]), id: "a-goal" };
    expect(pickMatchingGoal([later, earlier], { application: "kitty" })?.id).toBe("a-goal");
  });
});
