import { describe, expect, it } from "vitest";
import { readAfkTimeoutFromText, updateAfkConfigText } from "../src/afk-config";

describe("ActivityWatch AFK config", () => {
  it("reads timeout only from the normal watcher section", () => {
    const config = "[aw-watcher-afk]\ntimeout = 60\n\n[aw-watcher-afk-testing]\ntimeout = 20\n";
    expect(readAfkTimeoutFromText(config)).toBe(60);
  });

  it("activates a commented timeout without changing other settings", () => {
    const config = "[aw-watcher-afk]\n# timeout = 180\npoll_time = 5\n\n[aw-watcher-afk-testing]\ntimeout = 20\n";
    expect(updateAfkConfigText(config, 60)).toBe(
      "[aw-watcher-afk]\ntimeout = 60\npoll_time = 5\n\n[aw-watcher-afk-testing]\ntimeout = 20\n"
    );
  });

  it("inserts timeout when the section has no timeout key", () => {
    const config = "[aw-watcher-afk]\npoll_time = 5\n";
    expect(updateAfkConfigText(config, 60)).toBe("[aw-watcher-afk]\ntimeout = 60\npoll_time = 5\n");
  });

  it("refuses an unexpected config structure", () => {
    expect(() => updateAfkConfigText("[other]\ntimeout = 180\n", 60)).toThrow(/section/);
  });
});
