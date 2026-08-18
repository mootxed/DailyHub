import { describe, expect, it } from "vitest";
import type { ComputerActivitySegment } from "../src/activity-models";
import {
  buildTimelineLanes,
  coalesceTimelineSegments,
  formatActivityDuration,
  getNiceTimelineTickStep,
  getVisibleTimelineRange,
  type TimelinePresentationSegment
} from "../src/timeline-presentation";

function timestamp(hour: number, minute = 0): number {
  return new Date(2026, 7, 19, hour, minute).getTime();
}

function segment(
  application: string,
  startMinute: number,
  durationMinutes: number,
  categoryId?: string
): ComputerActivitySegment {
  const startMs = timestamp(9, startMinute);
  return {
    application,
    displayApplication: application,
    startMs,
    endMs: startMs + durationMinutes * 60_000,
    ...(categoryId === undefined ? {} : { categoryId })
  };
}

describe("timeline presentation", () => {
  it("chooses readable ticks for short and long ranges", () => {
    expect(getNiceTimelineTickStep(47 * 60_000)).toBe(10 * 60_000);
    expect(getNiceTimelineTickStep(6 * 60 * 60_000)).toBe(60 * 60_000);
  });

  it("rounds the visible range to sensible local boundaries", () => {
    const range = getVisibleTimelineRange(timestamp(9, 17), timestamp(14, 43));
    expect(range.startMs).toBe(timestamp(9));
    expect(range.endMs).toBe(timestamp(15));
    expect(range.ticks).toHaveLength(7);
  });

  it("sorts top lanes and groups the remainder without changing totals", () => {
    const source = [
      segment("Obsidian", 0, 6),
      segment("Sober", 6, 31),
      segment("Chrome", 37, 6),
      segment("VS Code", 43, 1),
      segment("Dolphin", 44, 0.4),
      segment("Spectacle", 45, 0.2)
    ];
    const result = buildTimelineLanes(source, "apps", [], 4);
    expect(result.lanes.map((lane) => lane.label)).toEqual([
      "Sober", "Chrome", "Obsidian", "VS Code", "Other"
    ]);
    expect(result.lanes.at(-1)?.sourceItems.map((item) => item.id)).toEqual(["Dolphin", "Spectacle"]);
    expect(result.lanes.reduce((sum, lane) => sum + lane.seconds, 0)).toBeCloseTo(
      source.reduce((sum, item) => sum + (item.endMs - item.startMs) / 1_000, 0)
    );
  });

  it("builds category lanes with Uncategorized fallback", () => {
    const result = buildTimelineLanes([
      segment("Code", 0, 10, "development"),
      segment("Notes", 10, 5)
    ], "categories", [{ id: "development", name: "Development", rules: [] }]);
    expect(result.lanes.map((lane) => lane.label)).toEqual(["Development", "Uncategorized"]);
  });

  it("coalesces only matching presentation segments across tiny gaps", () => {
    const base = segment("Obsidian", 0, 1) as TimelinePresentationSegment;
    base.laneId = "Obsidian";
    base.label = "Obsidian";
    base.mergeKey = "Obsidian";
    const matching = { ...base, startMs: base.endMs + 1_000, endMs: base.endMs + 61_000 };
    const different = { ...matching, startMs: matching.endMs, endMs: matching.endMs + 60_000, mergeKey: "Chrome" };
    const result = coalesceTimelineSegments([base, matching, different]);
    expect(result).toHaveLength(2);
    expect(result[0]?.endMs).toBe(matching.endMs);
    expect(result[1]?.mergeKey).toBe("Chrome");

    const afterVisibleGap = { ...base, startMs: base.endMs + 3_000, endMs: base.endMs + 63_000 };
    expect(coalesceTimelineSegments([base, afterVisibleGap])).toHaveLength(2);
  });

  it("formats tiny and precise activity durations without zero-minute rows", () => {
    expect(formatActivityDuration(34)).toBe("34 sec");
    expect(formatActivityDuration(374)).toBe("6 min 14 sec");
    expect(formatActivityDuration(3_600)).toBe("1 h");
  });
});
