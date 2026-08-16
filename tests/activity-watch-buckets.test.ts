import { describe, expect, it } from "vitest";
import {
  getWatcherAvailability,
  selectActivityWatchBuckets,
  type ActivityWatchBucket
} from "../src/activity-watch-buckets";

const HOST = "dailyhub-x11";

function bucket(id: string, type: string, hostname = HOST): ActivityWatchBucket {
  return { id, type, hostname, lastUpdated: "2026-08-16T12:00:00Z" };
}

function availability(buckets: ActivityWatchBucket[]) {
  return getWatcherAvailability(selectActivityWatchBuckets(buckets, HOST));
}

describe("ActivityWatch watcher availability", () => {
  it("detects standard Linux/X11 watcher buckets", () => {
    expect(availability([
      bucket(`aw-watcher-window_${HOST}`, "currentwindow"),
      bucket(`aw-watcher-afk_${HOST}`, "afkstatus"),
      bucket(`aw-watcher-web-firefox_${HOST}`, "web.tab.current")
    ])).toEqual({
      windowWatcherAvailable: true,
      afkWatcherAvailable: true,
      browserWatcherAvailable: true
    });
  });

  it("reports a missing window watcher", () => {
    expect(availability([
      bucket(`aw-watcher-afk_${HOST}`, "afkstatus"),
      bucket(`aw-watcher-web-firefox_${HOST}`, "web.tab.current")
    ])).toMatchObject({ windowWatcherAvailable: false });
  });

  it("reports a missing browser watcher", () => {
    expect(availability([
      bucket(`aw-watcher-window_${HOST}`, "currentwindow"),
      bucket(`aw-watcher-afk_${HOST}`, "afkstatus")
    ])).toMatchObject({ browserWatcherAvailable: false });
  });

  it("reports a missing AFK watcher", () => {
    expect(availability([
      bucket(`aw-watcher-window_${HOST}`, "currentwindow"),
      bucket(`aw-watcher-web-firefox_${HOST}`, "web.tab.current")
    ])).toMatchObject({ afkWatcherAvailable: false });
  });

  it("reports all watchers unavailable for an offline/empty source", () => {
    expect(availability([])).toEqual({
      windowWatcherAvailable: false,
      browserWatcherAvailable: false,
      afkWatcherAvailable: false
    });
  });

  it("recognizes currentwindow type even with a nonstandard bucket id", () => {
    expect(availability([bucket("custom-x11-window-source", "currentwindow")]))
      .toMatchObject({ windowWatcherAvailable: true });
  });

  it("recognizes standard watcher ids when bucket types are missing", () => {
    expect(availability([
      bucket(`aw-watcher-window_${HOST}`, ""),
      bucket(`aw-watcher-afk_${HOST}`, ""),
      bucket(`aw-watcher-web-firefox_${HOST}`, "")
    ])).toEqual({
      windowWatcherAvailable: true,
      afkWatcherAvailable: true,
      browserWatcherAvailable: true
    });
  });
});
