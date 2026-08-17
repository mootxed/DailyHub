import { describe, expect, it, vi } from "vitest";
import { calculateRangeAnalytics } from "../src/analytics";
import {
  createLongTermRange,
  getLongTermRetryKeys,
  LongTermActivityState,
  loadLongTermRange,
  mergeLongTermRange
} from "../src/long-term-state";
import { toLocalDateKey } from "../src/date";
import type { DailyGoal, DayActivity } from "../src/models";
import { calculateRangeProgress, type DayActivityInput } from "../src/range-progress";

function activity(label: string): DayActivity {
  return {
    windowEvents: [{ timestamp: "2026-08-17T00:00:00.000Z", duration: 0, data: { label } }],
    browserEvents: [],
    afkEvents: []
  };
}

function day(dateKey: string, value: DayActivity | undefined): DayActivityInput {
  return { dateKey, future: false, activity: value };
}

function trailingKeys(todayKey: string): string[] {
  const today = new Date(`${todayKey}T12:00:00`);
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - 29 + index);
    return toLocalDateKey(date);
  });
}

describe("long-term session state", () => {
  it("reuses overlapping successes, keeps missing dates retryable, and normalizes duplicates", () => {
    const first = activity("first");
    const second = activity("second");
    const range = createLongTermRange(
      ["2026-08-15", "2026-08-16", "2026-08-17", "2026-08-17"],
      [
        day("2026-08-15", first),
        day("2026-08-15", undefined),
        day("2026-08-16", undefined),
        day("2026-08-16", second),
        { dateKey: "2026-08-17", future: true, activity: activity("future") },
        day("2026-08-14", activity("outside"))
      ]
    );

    expect(range).toHaveLength(3);
    expect(range.map((item) => item.dateKey)).toEqual(["2026-08-15", "2026-08-16", "2026-08-17"]);
    expect(range[0]?.activity).toBe(first);
    expect(range[1]?.activity).toBe(second);
    expect(range[2]?.activity).toBeUndefined();
  });

  it("retries only unavailable dates plus Today", () => {
    const days = [
      day("2026-08-14", activity("historical")),
      day("2026-08-15", undefined),
      day("2026-08-16", activity("historical")),
      day("2026-08-17", activity("today")),
      { dateKey: "2026-08-18", future: true, activity: undefined }
    ];

    expect(getLongTermRetryKeys(days, "2026-08-17")).toEqual(["2026-08-15", "2026-08-17"]);
  });

  it("recovers a missing day without refetching or replacing good historical data", async () => {
    const first = activity("first");
    const recovered = activity("recovered");
    const today = activity("today");
    const load = vi.fn((dateKey: string) => Promise.resolve(
      dateKey === "2026-08-16" ? recovered : undefined
    ));

    const result = await loadLongTermRange([
      day("2026-08-15", first),
      day("2026-08-16", undefined),
      day("2026-08-17", today)
    ], "2026-08-17", load, 6);

    expect(load.mock.calls.map(([dateKey]) => dateKey)).toEqual(["2026-08-16", "2026-08-17"]);
    expect(result[0]?.activity).toBe(first);
    expect(result[1]?.activity).toBe(recovered);
    expect(result[2]?.activity).toBe(today);
  });

  it("keeps the last good Today snapshot after failure and replaces it after success", async () => {
    const tenMinutes = activity("10 minutes");
    const fifteenMinutes = activity("15 minutes");
    const failed = await loadLongTermRange(
      [day("2026-08-17", tenMinutes)],
      "2026-08-17",
      () => Promise.reject(new Error("offline")),
      6
    );
    const recovered = await loadLongTermRange(
      failed,
      "2026-08-17",
      () => Promise.resolve(fifteenMinutes),
      6
    );

    expect(failed[0]?.activity).toBe(tenMinutes);
    expect(recovered[0]?.activity).toBe(fifteenMinutes);
  });

  it("never lets unavailable or future updates erase a successful snapshot", () => {
    const original = activity("original");
    const replacement = activity("replacement");
    const days = [day("2026-08-10", original)];

    expect(mergeLongTermRange(days, [
      day("2026-08-10", undefined),
      { dateKey: "2026-08-10", future: true, activity: replacement }
    ])).toBe(days);
    expect(mergeLongTermRange(days, [
      day("2026-08-10", undefined),
      day("2026-08-10", replacement)
    ])[0]?.activity).toBe(replacement);
  });

  it("does not call the loader when every date is successful and Today is outside the range", async () => {
    const days = [day("2026-08-16", activity("historical"))];
    const load = vi.fn(() => Promise.resolve(activity("unused")));

    await expect(loadLongTermRange(days, "2026-08-17", load, 6)).resolves.toBe(days);
    expect(load).not.toHaveBeenCalled();
  });

  it("recomputes partial analytics as unavailable dates recover", async () => {
    const goal: DailyGoal = {
      id: "goal",
      name: "Goal",
      targetMinutes: 30,
      rules: [],
      contextTimeoutMinutes: 10,
      enabled: true
    };
    const keys = Array.from({ length: 30 }, (_, index) => toLocalDateKey(new Date(2026, 6, 19 + index)));
    const missing = new Set([keys[1], keys[14], keys[29]]);
    const initial = keys.map((dateKey) => {
      return day(dateKey, missing.has(dateKey) ? undefined : activity(dateKey));
    });
    const before = calculateRangeAnalytics([goal], calculateRangeProgress([goal], initial));
    const load = vi.fn((dateKey: string) => Promise.resolve(
      dateKey === keys[29] ? undefined : activity(`recovered-${dateKey}`)
    ));

    const updated = await loadLongTermRange(initial, keys[29] ?? "", load, 6);
    const after = calculateRangeAnalytics([goal], calculateRangeProgress([goal], updated));

    expect(before.availableDays).toBe(27);
    expect(load.mock.calls.map(([dateKey]) => dateKey)).toEqual([keys[1], keys[14], keys[29]]);
    expect(after.availableDays).toBe(29);
    expect(after.days.filter((item) => !item.available).map((item) => item.dateKey)).toEqual([keys[29]]);
  });

  it("reuses rollover overlap but resets the complete range for a new endpoint", async () => {
    const state = new LongTermActivityState();
    const firstToday = "2026-08-17";
    const nextToday = "2026-08-18";
    const firstKeys = trailingKeys(firstToday);
    const nextKeys = trailingKeys(nextToday);
    let source = "first";
    const load = vi.fn((dateKey: string) => Promise.resolve(activity(`${source}:${dateKey}`)));

    await state.ensure(firstKeys, firstToday, "http://first", load, 6);
    const retainedKey = firstKeys[1];
    if (retainedKey === undefined) throw new Error("Expected a 30-day range");
    const retained = state.get(firstToday, "http://first")?.find((item) => item.dateKey === retainedKey)?.activity;

    load.mockClear();
    await state.ensure(nextKeys, nextToday, "http://first", load, 6);
    expect(load.mock.calls.map(([dateKey]) => dateKey)).toEqual([nextToday]);
    expect(state.get(nextToday, "http://first")?.find((item) => item.dateKey === retainedKey)?.activity)
      .toBe(retained);

    source = "second";
    load.mockClear();
    await state.ensure(nextKeys, nextToday, "http://second", load, 6);
    expect(load).toHaveBeenCalledTimes(30);
    expect(state.get(nextToday, "http://second")?.every(
      (item) => item.activity?.windowEvents[0]?.data.label === `second:${item.dateKey}`
    )).toBe(true);
    expect(state.get(nextToday, "http://first")).toBeUndefined();
  });

  it("coalesces matching loads and prevents an older load from overwriting a refresh", async () => {
    const state = new LongTermActivityState();
    const todayKey = "2026-08-17";
    const url = "http://activitywatch";
    const keys = trailingKeys(todayKey);
    const initialLoad = vi.fn((dateKey: string) => Promise.resolve(activity(`initial:${dateKey}`)));
    await state.ensure(keys, todayKey, url, initialLoad, 6);
    const initialToday = state.get(todayKey, url)?.at(-1)?.activity;

    let resolveOld: ((value: DayActivity | undefined) => void) | undefined;
    const oldRequest = new Promise<DayActivity | undefined>((resolve) => {
      resolveOld = resolve;
    });
    const staleLoader = vi.fn(() => oldRequest);
    const staleLoad = state.ensure(keys, todayKey, url, staleLoader, 6);
    expect(state.ensure(keys, todayKey, url, staleLoader, 6)).toBe(staleLoad);

    state.merge(todayKey, url, [day(todayKey, undefined)]);
    expect(state.get(todayKey, url)?.at(-1)?.activity).toBe(initialToday);
    state.merge(todayKey, url, [day(todayKey, activity("refresh"))]);

    const currentLoad = state.ensure(
      keys,
      todayKey,
      url,
      (dateKey) => Promise.resolve(activity(`new:${dateKey}`)),
      6
    );
    await currentLoad;
    resolveOld?.(activity("old"));
    await staleLoad;

    expect(state.get(todayKey, url)?.at(-1)?.activity?.windowEvents[0]?.data.label)
      .toBe(`new:${todayKey}`);
  });

  it("ignores merges before initialization, for stale contexts, and without updates", async () => {
    const state = new LongTermActivityState();
    const todayKey = "2026-08-17";
    const url = "http://activitywatch";
    state.merge(todayKey, url, [day(todayKey, activity("ignored"))]);
    expect(state.get(todayKey, url)).toBeUndefined();

    const keys = trailingKeys(todayKey);
    await state.ensure(keys, todayKey, url, (dateKey) => Promise.resolve(activity(dateKey)), 6);
    const before = state.get(todayKey, url);
    state.merge(todayKey, "http://other", [day(todayKey, activity("wrong-url"))]);
    state.merge("2026-08-18", url, [day(todayKey, activity("wrong-day"))]);
    state.merge(todayKey, url, []);

    expect(state.get(todayKey, url)).toBe(before);
  });
});
