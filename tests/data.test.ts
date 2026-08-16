import { describe, expect, it } from "vitest";
import { normalizeData, requiresDataMigration } from "../src/data";
import { DATA_SCHEMA_VERSION } from "../src/models";

describe("plugin data validation", () => {
  it("migrates legacy settings without losing valid goals", () => {
    const legacy = {
      settings: {
        activityWatchUrl: "http://localhost:5600",
        afkThresholdSeconds: 60,
        refreshIntervalSeconds: 30,
        completionNotifications: true
      },
      goals: [{
        id: "goal-1",
        name: "Typing",
        targetMinutes: 30,
        enabled: true,
        rules: [{ id: "rule-1", field: "url", operator: "contains", value: "keybr.com" }]
      }],
      notifiedCompletions: ["2026-08-16:goal-1"]
    };
    const migrated = normalizeData(legacy);
    expect(requiresDataMigration(legacy)).toBe(true);
    expect(migrated.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(migrated.settings).not.toHaveProperty("afkThresholdSeconds");
    expect(migrated.goals).toEqual([{
      id: "goal-1",
      name: "Typing",
      targetMinutes: 30,
      enabled: true,
      contextTimeoutMinutes: 10,
      rules: [{
        id: "rule-1",
        role: "primary",
        field: "url",
        operator: "contains",
        value: "keybr.com",
        countDuringAfk: false
      }]
    }]);
    expect(migrated.notifiedCompletions).toEqual(["2026-08-16:goal-1"]);
  });

  it("keeps a goal with only a valid primary rule", () => {
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [{
        id: "primary-only",
        name: "Primary only",
        targetMinutes: 25,
        enabled: true,
        rules: [{ id: "primary", role: "primary", field: "url", operator: "contains", value: "keybr.com" }]
      }],
      notifiedCompletions: []
    });
    expect(data.goals[0]?.rules).toEqual([{
      id: "primary",
      role: "primary",
      field: "url",
      operator: "contains",
      value: "keybr.com",
      countDuringAfk: false
    }]);
  });

  it("keeps primary and continuation rules while normalizing their AFK fields", () => {
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [{
        id: "mixed",
        name: "Mixed",
        targetMinutes: 25,
        contextTimeoutMinutes: 15,
        enabled: false,
        rules: [
          { id: "primary", role: "primary", field: "url", operator: "contains", value: "stepik.org", countDuringAfk: true },
          { id: "continuation", role: "continuation", field: "application", operator: "equals", value: "kitty", countDuringAfk: true }
        ]
      }],
      notifiedCompletions: [42, "2026-08-16:valid"]
    });
    expect(data.goals).toEqual([{
      id: "mixed",
      name: "Mixed",
      targetMinutes: 25,
      contextTimeoutMinutes: 15,
      enabled: false,
      rules: [
        {
          id: "primary",
          role: "primary",
          field: "url",
          operator: "contains",
          value: "stepik.org",
          countDuringAfk: true
        },
        {
          id: "continuation",
          role: "continuation",
          field: "application",
          operator: "equals",
          value: "kitty"
        }
      ]
    }]);
    expect(data.notifiedCompletions).toEqual(["2026-08-16:valid"]);
  });

  it("drops a continuation-only goal", () => {
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [{
        id: "continuation-only",
        name: "Continuation only",
        targetMinutes: 25,
        enabled: true,
        rules: [{ id: "continuation", role: "continuation", field: "application", operator: "equals", value: "kitty" }]
      }]
    });
    expect(data.goals).toEqual([]);
  });

  it("drops a goal whose invalid primary is removed even if its continuation is valid", () => {
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [{
        id: "invalid-primary",
        name: "Invalid primary",
        targetMinutes: 25,
        enabled: true,
        rules: [
          { id: "primary", role: "primary", field: "unknown", operator: "contains", value: "stepik.org" },
          { id: "continuation", role: "continuation", field: "application", operator: "equals", value: "kitty" }
        ]
      }]
    });
    expect(data.goals).toEqual([]);
  });

  it("deduplicates goal ids and falls back for invalid settings", () => {
    const goal = {
      id: "same",
      name: "Goal",
      targetMinutes: 30,
      contextTimeoutMinutes: 10,
      enabled: true,
      rules: [{
        id: "rule",
        role: "primary",
        field: "url",
        operator: "contains",
        value: "keybr.com",
        countDuringAfk: false
      }]
    };
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: { activityWatchUrl: "", refreshIntervalSeconds: 1, completionNotifications: "yes" },
      goals: [goal, { ...goal, name: "Duplicate" }]
    });
    expect(data.goals).toHaveLength(1);
    expect(data.settings.activityWatchUrl).toBe("http://localhost:5600");
    expect(data.settings.refreshIntervalSeconds).toBe(60);
    expect(data.settings.completionNotifications).toBe(true);
  });
});
