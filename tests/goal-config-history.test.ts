import { describe, expect, it } from "vitest";
import {
  configRevisionFromGoal,
  getGoalAt,
  getGoalConfigAt,
  hasTrackingConfigChanged,
  withRecordedConfigRevision
} from "../src/goal-config-history";
import { getLocalDateRange } from "../src/date";
import { pauseGoal } from "../src/goal-lifecycle";
import { createDefaultSchedule, type DailyGoal } from "../src/models";
import { calculateDailyProgress } from "../src/progress";
import { getEffectiveGoalDay, withGoalDayOverride } from "../src/schedule";

function goal(): DailyGoal {
  return {
    id: "study",
    name: "Study",
    targetMinutes: 30,
    schedule: createDefaultSchedule(30),
    trackingStartedAt: "2026-08-01T00:00:00.000Z",
    rules: [{
      id: "kitty",
      role: "primary",
      field: "application",
      operator: "equals",
      value: "kitty",
      countDuringAfk: false
    }],
    contextTimeoutMinutes: 10,
    enabled: true
  };
}

describe("versioned goal configuration", () => {
  it("resolves old and new targets around a revision", () => {
    const original = goal();
    original.configHistory = [configRevisionFromGoal(original, "2026-08-01T00:00:00.000Z")];
    const changed = withRecordedConfigRevision(original, {
      ...original,
      targetMinutes: 120,
      schedule: createDefaultSchedule(120)
    }, "2026-08-18T10:00:00.000Z");

    expect(getGoalConfigAt(changed, Date.parse("2026-08-18T09:59:59.999Z")).targetMinutes).toBe(30);
    expect(getGoalConfigAt(changed, Date.parse("2026-08-18T10:00:00.000Z")).targetMinutes).toBe(120);
  });

  it("keeps old weekdays on the old schedule and lets overrides win", () => {
    const original = goal();
    const oldSchedule = createDefaultSchedule(30);
    oldSchedule.monday.enabled = false;
    original.schedule = oldSchedule;
    original.configHistory = [configRevisionFromGoal(original, "2026-08-01T00:00:00.000Z")];
    const newSchedule = createDefaultSchedule(30);
    const changed = withRecordedConfigRevision(original, { ...original, schedule: newSchedule }, "2026-08-18T10:00:00.000Z");
    const overridden = withGoalDayOverride(changed, "2026-08-17", { kind: "target", targetMinutes: 75 });

    expect(getEffectiveGoalDay(changed, "2026-08-17").scheduled).toBe(false);
    expect(getEffectiveGoalDay(changed, "2026-08-24").scheduled).toBe(true);
    expect(getEffectiveGoalDay(overridden, "2026-08-17")).toMatchObject({
      scheduled: true, targetMinutes: 75, source: "override"
    });
  });

  it("uses old rules before a change and splits a long event at the revision boundary", () => {
    const dateKey = "2026-08-18";
    const start = getLocalDateRange(dateKey).start.getTime() + 10 * 60 * 60_000;
    const original = goal();
    original.trackingStartedAt = new Date(start - 60_000).toISOString();
    original.configHistory = [configRevisionFromGoal(original, new Date(start - 60_000).toISOString())];
    const changedRules: DailyGoal = {
      ...original,
      rules: [{
        id: "code", role: "primary", field: "application", operator: "equals",
        value: "code", countDuringAfk: false
      }]
    };
    const changed = withRecordedConfigRevision(original, changedRules, start + 30 * 60_000);
    const activity = {
      windowEvents: [
        { timestamp: new Date(start).toISOString(), duration: 60 * 60, data: { app: "kitty" } },
        { timestamp: new Date(start + 60 * 60_000).toISOString(), duration: 30 * 60, data: { app: "code" } }
      ],
      browserEvents: [],
      afkEvents: []
    };

    expect(getGoalAt(changed, start + 1).rules[0]?.value).toBe("kitty");
    expect(getGoalAt(changed, start + 31 * 60_000).rules[0]?.value).toBe("code");
    expect(calculateDailyProgress([changed], activity, dateKey)[0]?.activeSeconds).toBe(60 * 60);
  });

  it("does not revise no-op, rename, color, pause, or override edits", () => {
    const original = goal();
    original.configHistory = [configRevisionFromGoal(original, "2026-08-01T00:00:00.000Z")];
    const metadata = { ...original, name: "Renamed", colorIndex: 4 };
    expect(hasTrackingConfigChanged(original, metadata)).toBe(false);
    expect(withRecordedConfigRevision(original, metadata, "2026-08-18T10:00:00.000Z").configHistory).toHaveLength(1);

    const paused = structuredClone(original);
    pauseGoal(paused, "2026-08-18T10:00:00.000Z");
    expect(withRecordedConfigRevision(original, paused, "2026-08-18T10:00:00.000Z").configHistory).toHaveLength(1);
    const overridden = withGoalDayOverride(original, "2026-08-18", { kind: "skip" });
    expect(withRecordedConfigRevision(original, overridden, "2026-08-18T10:00:00.000Z").configHistory).toHaveLength(1);
  });
});
