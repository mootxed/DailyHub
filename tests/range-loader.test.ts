import { describe, expect, it, vi } from "vitest";
import { ActivitySnapshotCache } from "../src/activity-cache";
import { loadDateRange } from "../src/range-loader";
import type { ActivityWatchSnapshot } from "../src/models";

function snapshot(dateKey: string): ActivityWatchSnapshot {
  return {
    status: {
      kind: "connected",
      windowWatcherAvailable: true,
      browserWatcherAvailable: true,
      afkWatcherAvailable: true,
      message: dateKey
    },
    activity: { windowEvents: [], browserEvents: [], afkEvents: [] }
  };
}

describe("range loader", () => {
  it("limits concurrency, preserves order, coalesces duplicate keys, and isolates errors", async () => {
    let active = 0;
    let maximum = 0;
    const resolvers: (() => void)[] = [];
    const load = vi.fn(async (dateKey: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => { resolvers.push(resolve); });
      active -= 1;
      if (dateKey === "bad") throw new Error("unavailable");
      return `snapshot:${dateKey}`;
    });

    const pending = loadDateRange(["3", "1", "bad", "2", "1"], load, 2);
    while (resolvers.length > 0 || load.mock.calls.length < 4) {
      resolvers.shift()?.();
      await Promise.resolve();
    }
    resolvers.splice(0).forEach((resolve) => resolve());

    const result = await pending;
    expect(maximum).toBe(2);
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.map((item) => item.dateKey)).toEqual(["3", "1", "bad", "2", "1"]);
    expect(result[0]).toMatchObject({ value: "snapshot:3", error: undefined });
    expect(result[2]?.value).toBeUndefined();
    expect(result[2]?.error).toBeInstanceOf(Error);
    expect(result[4]).toEqual(result[1]);
  });

  it("handles an empty range and validates the limit", async () => {
    const load = vi.fn(() => Promise.resolve("unused"));
    await expect(loadDateRange([], load, 6)).resolves.toEqual([]);
    await expect(loadDateRange(["day"], load, 0)).rejects.toThrow("positive integer");
    expect(load).not.toHaveBeenCalled();
  });

  it("reuses cached historical snapshots across overlapping range loads", async () => {
    const source = vi.fn((_url: string, dateKey: string) => Promise.resolve(snapshot(dateKey)));
    const cache = new ActivitySnapshotCache(source, {
      now: () => new Date(2026, 7, 17, 12).getTime()
    });
    const load = (dateKey: string): Promise<ActivityWatchSnapshot> => cache.get("http://activitywatch", dateKey);

    await loadDateRange(["2026-08-14", "2026-08-15", "2026-08-16"], load, 2);
    const second = await loadDateRange(["2026-08-15", "2026-08-16"], load, 2);

    expect(source).toHaveBeenCalledTimes(3);
    expect(second.map((result) => result.value?.status.message)).toEqual(["2026-08-15", "2026-08-16"]);
  });
});
