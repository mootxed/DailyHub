import { requestUrl } from "obsidian";
import {
  getWatcherAvailability,
  NO_WATCHERS,
  selectActivityWatchBuckets,
  type ActivityWatchBucket,
  type SelectedActivityWatchBuckets
} from "./activity-watch-buckets";
import { getLocalDateRange } from "./date";
import type { ActivityEvent, ActivityWatchSnapshot, ActivityWatchStatus, DayActivity } from "./models";

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
  private sourcesRequest: Promise<{
    hostname: string | undefined;
    buckets: ActivityWatchBucket[];
  }> | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  async getStatus(): Promise<ActivityWatchStatus> {
    try {
      const { hostname, buckets } = await this.getSources();
      const selected = selectActivityWatchBuckets(buckets, hostname);
      const availability = getWatcherAvailability(selected);
      return {
        kind: "connected",
        ...availability,
        message: "ActivityWatch connected"
      };
    } catch (error) {
      this.logError("Connection check failed", error);
      return {
        kind: "offline",
        ...NO_WATCHERS,
        message: "ActivityWatch not found"
      };
    }
  }

  async getActivityForDate(date: Date | string): Promise<DayActivity> {
    const { hostname, buckets } = await this.getSources();
    return this.loadActivity(buckets, hostname, date);
  }

  async getDaySnapshot(date: Date | string): Promise<ActivityWatchSnapshot> {
    const range = getLocalDateRange(date);
    return this.getRangeSnapshot(range.start, range.end);
  }

  async getRangeSnapshot(start: Date, end: Date): Promise<ActivityWatchSnapshot> {
    try {
      const { hostname, buckets } = await this.getSources();
      const selected = selectActivityWatchBuckets(buckets, hostname);
      const availability = getWatcherAvailability(selected);
      const activity = await this.loadSelectedActivity(selected, start, end);
      return {
        status: {
          kind: "connected",
          ...availability,
          message: "ActivityWatch connected"
        },
        activity
      };
    } catch (error) {
      this.logError("Could not load activity", error);
      return {
        status: {
          kind: "offline",
          ...NO_WATCHERS,
          message: "ActivityWatch not found"
        },
        activity: EMPTY_ACTIVITY
      };
    }
  }

  private async getBuckets(): Promise<ActivityWatchBucket[]> {
    return parseBuckets(await this.getJson("/api/0/buckets"));
  }

  private getSources(): Promise<{ hostname: string | undefined; buckets: ActivityWatchBucket[] }> {
    if (this.sourcesRequest !== undefined) return this.sourcesRequest;

    const request = Promise.all([this.getHostname(), this.getBuckets()])
      .then(([hostname, buckets]) => ({ hostname, buckets }))
      .finally(() => {
        if (this.sourcesRequest === request) this.sourcesRequest = undefined;
      });
    this.sourcesRequest = request;
    return request;
  }

  private async loadActivity(
    buckets: ActivityWatchBucket[],
    hostname: string | undefined,
    date: Date | string
  ): Promise<DayActivity> {
    const range = getLocalDateRange(date);
    return this.loadSelectedActivity(selectActivityWatchBuckets(buckets, hostname), range.start, range.end);
  }

  private async loadSelectedActivity(
    buckets: SelectedActivityWatchBuckets,
    start: Date,
    end: Date
  ): Promise<DayActivity> {
    const [windowEvents, browserEvents, afkEvents] = await Promise.all([
      this.getEvents(buckets.window, start, end),
      this.getEvents(buckets.browser, start, end),
      this.getEvents(buckets.afk, start, end)
    ]);
    return { windowEvents, browserEvents, afkEvents };
  }

  private async getEvents(buckets: ActivityWatchBucket[], start: Date, end: Date): Promise<ActivityEvent[]> {
    const query = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
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
