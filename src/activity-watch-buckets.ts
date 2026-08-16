export interface ActivityWatchBucket {
  id: string;
  type: string;
  client?: string;
  hostname?: string;
  lastUpdated?: string;
}

export interface SelectedActivityWatchBuckets {
  window: ActivityWatchBucket[];
  browser: ActivityWatchBucket[];
  afk: ActivityWatchBucket[];
}

export interface WatcherAvailability {
  windowWatcherAvailable: boolean;
  browserWatcherAvailable: boolean;
  afkWatcherAvailable: boolean;
}

export const NO_WATCHERS: WatcherAvailability = {
  windowWatcherAvailable: false,
  browserWatcherAvailable: false,
  afkWatcherAvailable: false
};

function isWindowBucket(bucket: ActivityWatchBucket): boolean {
  return bucket.type === "currentwindow" || bucket.id.startsWith("aw-watcher-window");
}

function isBrowserBucket(bucket: ActivityWatchBucket): boolean {
  return bucket.type === "web.tab.current" || bucket.id.startsWith("aw-watcher-web");
}

function isAfkBucket(bucket: ActivityWatchBucket): boolean {
  return bucket.type === "afkstatus" || bucket.id.startsWith("aw-watcher-afk");
}

function preferCurrentHost(buckets: ActivityWatchBucket[], hostname: string | undefined): ActivityWatchBucket[] {
  if (hostname === undefined) return buckets;
  const local = buckets.filter((bucket) => bucket.hostname === hostname || bucket.id.endsWith(`_${hostname}`));
  return local.length > 0 ? local : buckets;
}

function updatedAt(bucket: ActivityWatchBucket): number {
  const value = bucket.lastUpdated === undefined ? 0 : new Date(bucket.lastUpdated).getTime();
  return Number.isFinite(value) ? value : 0;
}

function latestPerSource(
  buckets: ActivityWatchBucket[],
  source: (bucket: ActivityWatchBucket) => string
): ActivityWatchBucket[] {
  const latest = new Map<string, ActivityWatchBucket>();
  for (const bucket of buckets) {
    const key = source(bucket);
    const current = latest.get(key);
    if (current === undefined || updatedAt(bucket) > updatedAt(current)) latest.set(key, bucket);
  }
  return [...latest.values()];
}

function browserSource(bucket: ActivityWatchBucket): string {
  const hostnameSuffix = bucket.hostname === undefined ? "" : `_${bucket.hostname}`;
  return hostnameSuffix.length > 0 && bucket.id.endsWith(hostnameSuffix)
    ? bucket.id.slice(0, -hostnameSuffix.length)
    : bucket.id;
}

export function selectActivityWatchBuckets(
  buckets: ActivityWatchBucket[],
  hostname: string | undefined
): SelectedActivityWatchBuckets {
  const window = preferCurrentHost(buckets.filter(isWindowBucket), hostname);
  const browser = preferCurrentHost(buckets.filter(isBrowserBucket), hostname);
  const afk = preferCurrentHost(buckets.filter(isAfkBucket), hostname);
  return {
    window: latestPerSource(window, () => "window"),
    browser: latestPerSource(browser, browserSource),
    afk: latestPerSource(afk, () => "afk")
  };
}

export function getWatcherAvailability(buckets: SelectedActivityWatchBuckets): WatcherAvailability {
  return {
    windowWatcherAvailable: buckets.window.length > 0,
    browserWatcherAvailable: buckets.browser.length > 0,
    afkWatcherAvailable: buckets.afk.length > 0
  };
}
