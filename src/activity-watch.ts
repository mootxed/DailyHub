import { requestUrl } from "obsidian";
import { getLocalDateRange } from "./date";
import type { ActivityEvent, ActivityWatchStatus, DayActivity } from "./models";

interface ActivityWatchBucket {
  id: string;
  type: string;
}

interface ActivityWatchSnapshot {
  status: ActivityWatchStatus;
  activity: DayActivity;
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
    return [{ id, type }];
  });
}

function parseEvents(value: unknown): ActivityEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event) => {
    if (!isRecord(event) || typeof event.timestamp !== "string" || typeof event.duration !== "number") {
      return [];
    }
    return [{
      timestamp: event.timestamp,
      duration: event.duration,
      data: isRecord(event.data) ? event.data : {}
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
      await this.getJson("/api/0/info");
      const buckets = await this.getBuckets();
      const browserWatcherAvailable = buckets.some((bucket) => this.isBrowserBucket(bucket));
      return {
        kind: "connected",
        browserWatcherAvailable,
        message: browserWatcherAvailable
          ? "ActivityWatch connected"
          : "ActivityWatch connected; browser watcher not found"
      };
    } catch (error) {
      this.logError("Connection check failed", error);
      return {
        kind: "offline",
        browserWatcherAvailable: false,
        message: "ActivityWatch not found"
      };
    }
  }

  async getActivityForDate(date: Date | string): Promise<DayActivity> {
    const buckets = await this.getBuckets();
    return this.loadActivity(buckets, date);
  }

  async getDaySnapshot(date: Date | string): Promise<ActivityWatchSnapshot> {
    try {
      await this.getJson("/api/0/info");
      const buckets = await this.getBuckets();
      const browserWatcherAvailable = buckets.some((bucket) => this.isBrowserBucket(bucket));
      const activity = await this.loadActivity(buckets, date);
      return {
        status: {
          kind: "connected",
          browserWatcherAvailable,
          message: browserWatcherAvailable
            ? "ActivityWatch connected"
            : "ActivityWatch connected; browser watcher not found"
        },
        activity
      };
    } catch (error) {
      this.logError("Could not load activity", error);
      return {
        status: { kind: "offline", browserWatcherAvailable: false, message: "ActivityWatch not found" },
        activity: EMPTY_ACTIVITY
      };
    }
  }

  private async getBuckets(): Promise<ActivityWatchBucket[]> {
    return parseBuckets(await this.getJson("/api/0/buckets"));
  }

  private async loadActivity(buckets: ActivityWatchBucket[], date: Date | string): Promise<DayActivity> {
    const windowBuckets = buckets.filter((bucket) => this.isWindowBucket(bucket));
    const browserBuckets = buckets.filter((bucket) => this.isBrowserBucket(bucket));
    const afkBuckets = buckets.filter((bucket) => this.isAfkBucket(bucket));

    const [windowEvents, browserEvents, afkEvents] = await Promise.all([
      this.getEvents(windowBuckets, date),
      this.getEvents(browserBuckets, date),
      this.getEvents(afkBuckets, date)
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
        return parseEvents(await this.getJson(path));
      })
    );
    return eventLists.flat();
  }

  private isWindowBucket(bucket: ActivityWatchBucket): boolean {
    return bucket.type === "currentwindow" || bucket.id.startsWith("aw-watcher-window_");
  }

  private isBrowserBucket(bucket: ActivityWatchBucket): boolean {
    return bucket.type === "web.tab.current" || bucket.id.startsWith("aw-watcher-web-");
  }

  private isAfkBucket(bucket: ActivityWatchBucket): boolean {
    return bucket.type === "afkstatus" || bucket.id.startsWith("aw-watcher-afk_");
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
