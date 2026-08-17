import { toLocalDateKey } from "./date";
import type { ActivityWatchSnapshot } from "./models";

type SnapshotLoader = (activityWatchUrl: string, dateKey: string) => Promise<ActivityWatchSnapshot>;

interface CacheEntry {
  snapshot: ActivityWatchSnapshot;
  expiresAt: number;
}

interface ActivitySnapshotCacheOptions {
  now?: () => number;
  todayTtlMs?: number;
}

export class ActivitySnapshotCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly requests = new Map<string, Promise<ActivityWatchSnapshot>>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly todayTtlMs: number;

  constructor(
    private readonly load: SnapshotLoader,
    options: ActivitySnapshotCacheOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.todayTtlMs = options.todayTtlMs ?? 45_000;
  }

  get(activityWatchUrl: string, dateKey: string): Promise<ActivityWatchSnapshot> {
    const key = this.key(activityWatchUrl, dateKey);
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.snapshot);

    const pending = this.requests.get(key);
    if (pending !== undefined) return pending;

    const generation = this.generations.get(key) ?? 0;
    const promise = this.load(activityWatchUrl, dateKey).then((snapshot) => {
      if ((this.generations.get(key) ?? 0) === generation) {
        const todayKey = toLocalDateKey(new Date(this.now()));
        this.cache.set(key, {
          snapshot,
          expiresAt: dateKey === todayKey || snapshot.status.kind === "offline"
            ? this.now() + this.todayTtlMs
            : Number.POSITIVE_INFINITY
        });
      }
      return snapshot;
    }).finally(() => {
      if (this.requests.get(key) === promise) this.requests.delete(key);
    });
    this.requests.set(key, promise);
    return promise;
  }

  invalidate(activityWatchUrl: string, dateKeys?: Iterable<string>): void {
    if (dateKeys !== undefined) {
      for (const dateKey of dateKeys) this.invalidateKey(this.key(activityWatchUrl, dateKey));
      return;
    }

    const prefix = `${activityWatchUrl}\u0000`;
    const keys = new Set([...this.cache.keys(), ...this.requests.keys()]);
    for (const key of keys) {
      if (key.startsWith(prefix)) this.invalidateKey(key);
    }
  }

  private invalidateKey(key: string): void {
    this.cache.delete(key);
    this.requests.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private key(activityWatchUrl: string, dateKey: string): string {
    return `${activityWatchUrl}\u0000${dateKey}`;
  }
}
