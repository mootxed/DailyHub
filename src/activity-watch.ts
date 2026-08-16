import { requestUrl } from "obsidian";
import { getLocalDateRange } from "./date";
import type { ActivityEvent, ActivityWatchSnapshot, ActivityWatchStatus, DayActivity } from "./models";

interface ActivityWatchBucket {
  id: string;
  type: string;
  client?: string;
  hostname?: string;
  lastUpdated?: string;
}

const EMPTY_ACTIVITY: DayActivity = { windowEvents: [], browserEvents: [], afkEvents: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBuckets(value: unknown): ActivityWatchBucket[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, bucket]) => {
    if (!isRecord(bucket)) return [];
    const id = typeof bucket.id === "string" ? bucket.id : key;
    const type = typeof bucket.type === "string" ? bucket.type : "";
    return [{
      id,
      type,
      client: typeof bucket.client === "string" ? bucket.client : undefined,
      hostname: typeof bucket.hostname === "string" ? bucket.hostname : undefined,
      lastUpdated: typeof bucket.last_updated === "string" ? bucket.last_updated : undefined
    }];
  });
}

function parseEvents(value: unknown, sourceBucketId: string): ActivityEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event) => {
    if (!isRecord(event) || typeof event.timestamp !== "string" || typeof event.duration !== "number") {
      return [];
    }
    return [{
      timestamp: event.timestamp,
      duration: event.duration,
      data: isRecord(event.data) ? event.data : {},
      sourceBucketId
    }];
  });
}

export class ActivityWatchClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  async getStatus(): Promise<ActivityWatchStatus> {
    try {
      const hostname = await this.getHostname();
      const buckets = await this.getBuckets();
      const selected = this.selectBuckets(buckets, hostname);
      const browserWatcherAvailable = selected.browser.length > 0;
      return {
        kind: "connected",
        browserWatcherAvailable,
        afkWatcherAvailable: selected.afk.length > 0,
        message: "ActivityWatch connected"
      };
    } catch (error) {
      this.logError("Connection check failed", error);
      return {
        kind: "offline",
        browserWatcherAvailable: false,
        afkWatcherAvailable: false,
        message: "ActivityWatch not found"
      };
    }
  }

  async getActivityForDate(date: Date | string): Promise<DayActivity> {
    const hostname = await this.getHostname();
    const buckets = await this.getBuckets();
    return this.loadActivity(buckets, hostname, date);
  }

  async getDaySnapshot(date: Date | string): Promise<ActivityWatchSnapshot> {
    try {
      const hostname = await this.getHostname();
      const buckets = await this.getBuckets();
      const selected = this.selectBuckets(buckets, hostname);
      const browserWatcherAvailable = selected.browser.length > 0;
      const activity = await this.loadSelectedActivity(selected, date);
      return {
        status: {
          kind: "connected",
          browserWatcherAvailable,
          afkWatcherAvailable: selected.afk.length > 0,
          message: "ActivityWatch connected"
        },
        activity
      };
    } catch (error) {
      this.logError("Could not load activity", error);
      return {
        status: {
          kind: "offline",
          browserWatcherAvailable: false,
          afkWatcherAvailable: false,
          message: "ActivityWatch not found"
        },
        activity: EMPTY_ACTIVITY
      };
    }
  }

  private async getBuckets(): Promise<ActivityWatchBucket[]> {
    return parseBuckets(await this.getJson("/api/0/buckets"));
  }

  private async loadActivity(
    buckets: ActivityWatchBucket[],
    hostname: string | undefined,
    date: Date | string
  ): Promise<DayActivity> {
    return this.loadSelectedActivity(this.selectBuckets(buckets, hostname), date);
  }

  private async loadSelectedActivity(
    buckets: { window: ActivityWatchBucket[]; browser: ActivityWatchBucket[]; afk: ActivityWatchBucket[] },
    date: Date | string
  ): Promise<DayActivity> {
    const [windowEvents, browserEvents, afkEvents] = await Promise.all([
      this.getEvents(buckets.window, date),
      this.getEvents(buckets.browser, date),
      this.getEvents(buckets.afk, date)
    ]);
    return { windowEvents, browserEvents, afkEvents };
  }

  private async getEvents(buckets: ActivityWatchBucket[], date: Date | string): Promise<ActivityEvent[]> {
    const range = getLocalDateRange(date);
    const query = new URLSearchParams({
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      limit: "-1"
    });
    const eventLists = await Promise.all(
      buckets.map(async (bucket) => {
        const path = `/api/0/buckets/${encodeURIComponent(bucket.id)}/events?${query.toString()}`;
        return parseEvents(await this.getJson(path), bucket.id);
      })
    );
    return eventLists.flat();
  }

  private isWindowBucket(bucket: ActivityWatchBucket): boolean {
    return bucket.type === "currentwindow" || bucket.id.startsWith("aw-watcher-window");
  }

  private isBrowserBucket(bucket: ActivityWatchBucket): boolean {
    return bucket.type === "web.tab.current" || bucket.id.startsWith("aw-watcher-web");
  }

  private isAfkBucket(bucket: ActivityWatchBucket): boolean {
    return bucket.type === "afkstatus" || bucket.id.startsWith("aw-watcher-afk");
  }

  private selectBuckets(
    buckets: ActivityWatchBucket[],
    hostname: string | undefined
  ): { window: ActivityWatchBucket[]; browser: ActivityWatchBucket[]; afk: ActivityWatchBucket[] } {
    const window = this.preferCurrentHost(buckets.filter((bucket) => this.isWindowBucket(bucket)), hostname);
    const browser = this.preferCurrentHost(buckets.filter((bucket) => this.isBrowserBucket(bucket)), hostname);
    const afk = this.preferCurrentHost(buckets.filter((bucket) => this.isAfkBucket(bucket)), hostname);
    return {
      window: this.latestPerSource(window, () => "window"),
      browser: this.latestPerSource(browser, (bucket) => this.browserSource(bucket)),
      afk: this.latestPerSource(afk, () => "afk")
    };
  }

  private preferCurrentHost(buckets: ActivityWatchBucket[], hostname: string | undefined): ActivityWatchBucket[] {
    if (hostname === undefined) return buckets;
    const local = buckets.filter((bucket) => bucket.hostname === hostname || bucket.id.endsWith(`_${hostname}`));
    return local.length > 0 ? local : buckets;
  }

  private latestPerSource(
    buckets: ActivityWatchBucket[],
    source: (bucket: ActivityWatchBucket) => string
  ): ActivityWatchBucket[] {
    const latest = new Map<string, ActivityWatchBucket>();
    for (const bucket of buckets) {
      const key = source(bucket);
      const current = latest.get(key);
      if (current === undefined || this.updatedAt(bucket) > this.updatedAt(current)) latest.set(key, bucket);
    }
    return [...latest.values()];
  }

  private browserSource(bucket: ActivityWatchBucket): string {
    const hostnameSuffix = bucket.hostname === undefined ? "" : `_${bucket.hostname}`;
    return hostnameSuffix.length > 0 && bucket.id.endsWith(hostnameSuffix)
      ? bucket.id.slice(0, -hostnameSuffix.length)
      : bucket.id;
  }

  private updatedAt(bucket: ActivityWatchBucket): number {
    const value = bucket.lastUpdated === undefined ? 0 : new Date(bucket.lastUpdated).getTime();
    return Number.isFinite(value) ? value : 0;
  }

  private async getHostname(): Promise<string | undefined> {
    const info = await this.getJson("/api/0/info");
    return isRecord(info) && typeof info.hostname === "string" ? info.hostname : undefined;
  }

  private async getJson(path: string): Promise<unknown> {
    if (this.baseUrl.length === 0) throw new Error("ActivityWatch URL is empty");
    const response = await requestUrl({ url: `${this.baseUrl}${path}`, method: "GET", throw: true });
    return response.json as unknown;
  }

  private logError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[Daily Hub] ${message}: ${detail}`);
  }
}
