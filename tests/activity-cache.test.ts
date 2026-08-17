import { describe, expect, it, vi } from "vitest";
import { ActivitySnapshotCache } from "../src/activity-cache";
import type { ActivityWatchSnapshot } from "../src/models";

function snapshot(message: string): ActivityWatchSnapshot {
  return {
    status: {
      kind: "connected",
      windowWatcherAvailable: true,
      browserWatcherAvailable: true,
      afkWatcherAvailable: true,
      message
    },
    activity: { windowEvents: [], browserEvents: [], afkEvents: [] }
  };
}

describe("ActivityWatch snapshot cache", () => {
  it("coalesces duplicate simultaneous requests", async () => {
    let resolve: ((value: ActivityWatchSnapshot) => void) | undefined;
    const load = vi.fn(() => new Promise<ActivityWatchSnapshot>((done) => { resolve = done; }));
    const cache = new ActivitySnapshotCache(load);
    const first = cache.get("http://localhost:5600", "2026-08-16");
    const second = cache.get("http://localhost:5600", "2026-08-16");
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    resolve?.(snapshot("loaded"));
    await expect(first).resolves.toMatchObject({ status: { message: "loaded" } });
  });

  it("keeps historical snapshots for the session", async () => {
    const load = vi.fn(() => Promise.resolve(snapshot("historical")));
    const now = new Date(2026, 7, 17, 12).getTime();
    const cache = new ActivitySnapshotCache(load, { now: () => now });
    await cache.get("http://localhost:5600", "2026-08-16");
    await cache.get("http://localhost:5600", "2026-08-16");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("expires today's snapshot after its short TTL", async () => {
    let now = new Date(2026, 7, 17, 12).getTime();
    const load = vi.fn(() => Promise.resolve(snapshot("today")));
    const cache = new ActivitySnapshotCache(load, { now: () => now, todayTtlMs: 1_000 });
    await cache.get("http://localhost:5600", "2026-08-17");
    now += 1_001;
    await cache.get("http://localhost:5600", "2026-08-17");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not keep an offline historical response for the whole session", async () => {
    let now = new Date(2026, 7, 17, 12).getTime();
    const offline = snapshot("offline");
    offline.status.kind = "offline";
    const load = vi.fn(() => Promise.resolve(offline));
    const cache = new ActivitySnapshotCache(load, { now: () => now, todayTtlMs: 1_000 });
    await cache.get("http://localhost:5600", "2026-08-16");
    now += 1_001;
    await cache.get("http://localhost:5600", "2026-08-16");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads an explicitly invalidated date", async () => {
    const load = vi.fn(() => Promise.resolve(snapshot("refreshed")));
    const cache = new ActivitySnapshotCache(load);
    await cache.get("http://localhost:5600", "2026-08-16");
    cache.invalidate("http://localhost:5600", ["2026-08-16"]);
    await cache.get("http://localhost:5600", "2026-08-16");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not reuse or cache a pending request after manual invalidation", async () => {
    const resolvers: ((value: ActivityWatchSnapshot) => void)[] = [];
    const load = vi.fn(() => new Promise<ActivityWatchSnapshot>((resolve) => {
      resolvers.push(resolve);
    }));
    const cache = new ActivitySnapshotCache(load);

    const stale = cache.get("http://localhost:5600", "2026-08-16");
    cache.invalidate("http://localhost:5600", ["2026-08-16"]);
    const fresh = cache.get("http://localhost:5600", "2026-08-16");

    expect(fresh).not.toBe(stale);
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[0]?.(snapshot("stale"));
    resolvers[1]?.(snapshot("fresh"));
    await expect(stale).resolves.toMatchObject({ status: { message: "stale" } });
    await expect(fresh).resolves.toMatchObject({ status: { message: "fresh" } });
    await expect(cache.get("http://localhost:5600", "2026-08-16"))
      .resolves.toMatchObject({ status: { message: "fresh" } });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("separates dates and ActivityWatch URLs", async () => {
    const load = vi.fn((url: string, key: string) => Promise.resolve(snapshot(`${url}:${key}`)));
    const cache = new ActivitySnapshotCache(load);
    await Promise.all([
      cache.get("http://one", "2026-08-15"),
      cache.get("http://one", "2026-08-16"),
      cache.get("http://two", "2026-08-15")
    ]);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
