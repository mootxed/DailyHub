import { describe, expect, it } from "vitest";
import { normalizeData, requiresDataMigration } from "../src/data";
import { createDefaultSchedule, DATA_SCHEMA_VERSION } from "../src/models";

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
      schedule: createDefaultSchedule(30),
      overrides: {},
      trackingPauses: [],
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

  it("migrates v5 goals as legacy and normalizes tracking timestamps", () => {
    const baseGoal = {
      id: "tracked",
      name: "Tracked",
      targetMinutes: 30,
      enabled: true,
      rules: [{ id: "primary", role: "primary", field: "url", operator: "contains", value: "example.com" }]
    };
    const legacy = normalizeData({ schemaVersion: 5, settings: {}, goals: [baseGoal] });
    expect(requiresDataMigration({ schemaVersion: 5, settings: {}, goals: [baseGoal] })).toBe(true);
    expect(legacy.schemaVersion).toBe(7);
    expect(legacy.goals[0]).not.toHaveProperty("trackingStartedAt");

    const valid = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [{ ...baseGoal, trackingStartedAt: "2026-08-17T11:40:12.123Z" }]
    });
    expect(valid.goals[0]?.trackingStartedAt).toBe("2026-08-17T11:40:12.123Z");

    for (const trackingStartedAt of ["banana", ""]) {
      const invalid = normalizeData({
        schemaVersion: DATA_SCHEMA_VERSION,
        settings: {},
        goals: [{ ...baseGoal, trackingStartedAt }]
      });
      expect(invalid.goals[0]).not.toHaveProperty("trackingStartedAt");
    }
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
      schedule: createDefaultSchedule(25),
      overrides: {},
      trackingPauses: [],
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

  it("normalizes invalid schedules and keeps only valid date overrides", () => {
    const data = normalizeData({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {},
      goals: [{
        id: "scheduled",
        name: "Scheduled",
        targetMinutes: 40,
        enabled: true,
        rules: [{ id: "rule", role: "primary", field: "url", operator: "contains", value: "example.com" }],
        schedule: {
          monday: { enabled: true, targetMinutes: 90 },
          tuesday: { enabled: false, targetMinutes: 0 },
          wednesday: { enabled: true, targetMinutes: Number.NaN },
          thursday: "bad"
        },
        overrides: {
          "2026-08-17": { kind: "target", targetMinutes: 75 },
          "2026-08-18": { kind: "skip" },
          "2026-02-30": { kind: "skip" },
          "not-a-date": { kind: "target", targetMinutes: 60 },
          "2026-08-19": { kind: "target", targetMinutes: 0 },
          "2026-08-20": { kind: "unknown" }
        }
      }]
    });

    expect(data.goals[0]?.schedule).toEqual({
      ...createDefaultSchedule(40),
      monday: { enabled: true, targetMinutes: 90 },
      tuesday: { enabled: false, targetMinutes: 40 }
    });
    expect(data.goals[0]?.overrides).toEqual({
      "2026-08-17": { kind: "target", targetMinutes: 75 },
      "2026-08-18": { kind: "skip" }
    });
  });

  it("normalizes pause intervals and permits only one open pause", () => {
    const baseGoal = {
      id: "paused",
      name: "Paused",
      targetMinutes: 30,
      enabled: true,
      rules: [{ id: "primary", role: "primary", field: "application", operator: "equals", value: "kitty" }]
    };
    const data = normalizeData({
      schemaVersion: 6,
      settings: {},
      goals: [{
        ...baseGoal,
        trackingPauses: [
          { startedAt: "invalid" },
          { startedAt: "2026-08-18T10:00:00.000Z", endedAt: "2026-08-18T09:00:00.000Z" },
          { startedAt: "2026-08-18T10:00:00.000Z", endedAt: "2026-08-18T10:20:00.000Z" },
          { startedAt: "2026-08-18T10:15:00.000Z", endedAt: "2026-08-18T10:40:00.000Z" },
          { startedAt: "2026-08-18T11:00:00.000Z" },
          { startedAt: "2026-08-18T12:00:00.000Z" }
        ]
      }]
    });

    expect(data.goals[0]?.trackingPauses).toEqual([
      { startedAt: "2026-08-18T10:00:00.000Z", endedAt: "2026-08-18T10:40:00.000Z" },
      { startedAt: "2026-08-18T11:00:00.000Z" }
    ]);
    expect(requiresDataMigration({ schemaVersion: 6, settings: {}, goals: [baseGoal] })).toBe(true);
  });
});
