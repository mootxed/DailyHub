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
    expect(migrated.goals).toHaveLength(1);
    expect(migrated.notifiedCompletions).toEqual(["2026-08-16:goal-1"]);
  });

  it("drops malformed goals and invalid rules while preserving valid data", () => {
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [
        { id: "broken", name: "Broken", targetMinutes: -1, enabled: true, rules: [] },
        {
          id: "valid",
          name: "Valid",
          targetMinutes: 25,
          enabled: false,
          rules: [
            { id: "bad", field: "unknown", operator: "contains", value: "x" },
            { id: "good", field: "application", operator: "equals", value: "kitty" }
          ]
        }
      ],
      notifiedCompletions: [42, "2026-08-16:valid"]
    });
    expect(data.goals).toEqual([{
      id: "valid",
      name: "Valid",
      targetMinutes: 25,
      enabled: false,
      rules: [{ id: "good", field: "application", operator: "equals", value: "kitty" }]
    }]);
    expect(data.notifiedCompletions).toEqual(["2026-08-16:valid"]);
  });

  it("deduplicates goal ids and falls back for invalid settings", () => {
    const goal = {
      id: "same",
      name: "Goal",
      targetMinutes: 30,
      enabled: true,
      rules: [{ id: "rule", field: "url", operator: "contains", value: "keybr.com" }]
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
