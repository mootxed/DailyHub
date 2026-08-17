import type { DayActivity } from "./models";
import { loadDateRange } from "./range-loader";
import type { DayActivityInput } from "./range-progress";

export type LongTermActivityLoader = (dateKey: string) => Promise<DayActivity | undefined>;

export class LongTermActivityState {
  private days: DayActivityInput[] | undefined;
  private endKey: string | undefined;
  private url: string | undefined;
  private load: Promise<DayActivityInput[]> | undefined;
  private loadSequence = 0;

  get(todayKey: string, activityWatchUrl: string): DayActivityInput[] | undefined {
    if (this.endKey !== todayKey || this.url !== activityWatchUrl) return undefined;
    return this.days;
  }

  merge(
    todayKey: string,
    activityWatchUrl: string,
    updates: DayActivityInput[]
  ): void {
    if (
      this.days === undefined
      || this.endKey !== todayKey
      || this.url !== activityWatchUrl
      || updates.length === 0
    ) return;
    this.invalidateLoad();
    this.days = mergeLongTermRange(this.days, updates);
  }

  ensure(
    dateKeys: string[],
    todayKey: string,
    activityWatchUrl: string,
    loader: LongTermActivityLoader,
    concurrency: number
  ): Promise<DayActivityInput[]> {
    const contextChanged = this.endKey !== todayKey || this.url !== activityWatchUrl;
    if (this.days === undefined || contextChanged) {
      const reusableDays = this.url === activityWatchUrl ? this.days : undefined;
      this.invalidateLoad();
      this.endKey = todayKey;
      this.url = activityWatchUrl;
      this.days = createLongTermRange(dateKeys, reusableDays);
    }
    if (this.load !== undefined) return this.load;

    const sequence = ++this.loadSequence;
    const promise = loadLongTermRange(
      this.days,
      todayKey,
      loader,
      concurrency
    ).then((days) => {
      if (
        sequence === this.loadSequence
        && this.endKey === todayKey
        && this.url === activityWatchUrl
      ) {
        this.days = days;
        return days;
      }
      return this.days ?? days;
    });
    this.load = promise;
    void promise.finally(() => {
      if (this.load === promise) this.load = undefined;
    });
    return promise;
  }

  private invalidateLoad(): void {
    this.loadSequence += 1;
    this.load = undefined;
  }
}

export function createLongTermRange(
  dateKeys: string[],
  existingDays: DayActivityInput[] = []
): DayActivityInput[] {
  const existing = new Map<string, DayActivity | undefined>();
  for (const day of existingDays) {
    if (day.future) continue;
    if (day.activity !== undefined || !existing.has(day.dateKey)) {
      existing.set(day.dateKey, day.activity);
    }
  }

  return [...new Set(dateKeys)].map((dateKey) => ({
    dateKey,
    future: false,
    activity: existing.get(dateKey)
  }));
}

export function getLongTermRetryKeys(days: DayActivityInput[], todayKey: string): string[] {
  return days
    .filter((day) => !day.future && (day.activity === undefined || day.dateKey === todayKey))
    .map((day) => day.dateKey);
}

export function mergeLongTermRange(
  days: DayActivityInput[],
  updates: DayActivityInput[]
): DayActivityInput[] {
  const successful = new Map<string, DayActivity>();
  for (const update of updates) {
    if (!update.future && update.activity !== undefined) {
      successful.set(update.dateKey, update.activity);
    }
  }
  if (successful.size === 0) return days;

  return days.map((day) => {
    const activity = successful.get(day.dateKey);
    return activity === undefined ? day : { ...day, activity };
  });
}

export async function loadLongTermRange(
  days: DayActivityInput[],
  todayKey: string,
  load: LongTermActivityLoader,
  concurrency: number
): Promise<DayActivityInput[]> {
  const retryKeys = getLongTermRetryKeys(days, todayKey);
  const results = await loadDateRange(retryKeys, load, concurrency);
  const updates = results.map((result): DayActivityInput => ({
    dateKey: result.dateKey,
    future: false,
    activity: result.value
  }));
  return mergeLongTermRange(days, updates);
}
