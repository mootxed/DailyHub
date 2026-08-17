import { afterEach, describe, expect, it } from "vitest";
import {
  addLocalDays,
  getDateNavigator,
  getLocalDateRange,
  getTrailingLocalDates,
  getLocalWeek,
  isFutureDate,
  isToday,
  toLocalDateKey
} from "../src/date";

const originalTimezone = process.env.TZ;

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe("local date helpers", () => {
  it("generates seven navigator days centered on the selected date", () => {
    const items = getDateNavigator("2026-08-17", new Date(2026, 7, 17, 18));
    expect(items.map((item) => item.key)).toEqual([
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20"
    ]);
    expect(items[3]).toMatchObject({ selected: true, today: true });
  });

  it("keeps local calendar arithmetic correct across month and year boundaries", () => {
    expect(toLocalDateKey(addLocalDays("2026-12-31", 1))).toBe("2027-01-01");
    expect(toLocalDateKey(addLocalDays("2026-03-01", -1))).toBe("2026-02-28");
  });

  it("returns Monday through Sunday for the selected local week", () => {
    expect(getLocalWeek("2026-08-20").map(toLocalDateKey)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23"
    ]);
  });

  it("detects Today and future dates from local date keys", () => {
    const now = new Date(2026, 7, 17, 23, 30);
    expect(isToday("2026-08-17", now)).toBe(true);
    expect(isToday("2026-08-16", now)).toBe(false);
    expect(isFutureDate("2026-08-18", now)).toBe(true);
    expect(isFutureDate("2026-08-17", now)).toBe(false);
  });

  it("uses calendar midnights rather than 24-hour arithmetic across DST", () => {
    process.env.TZ = "America/New_York";
    const spring = getLocalDateRange("2026-03-08");
    const fall = getLocalDateRange("2026-11-01");
    expect(toLocalDateKey(spring.start)).toBe("2026-03-08");
    expect(toLocalDateKey(addLocalDays(spring.start, 1))).toBe("2026-03-09");
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });

  it("generates exactly 30 trailing local calendar days across boundaries and DST", () => {
    process.env.TZ = "America/New_York";
    const august = getTrailingLocalDates("2026-08-17", 30).map(toLocalDateKey);
    expect(august).toHaveLength(30);
    expect(august[0]).toBe("2026-07-19");
    expect(august.at(-1)).toBe("2026-08-17");
    expect(august).not.toContain("2026-07-18");

    const january = getTrailingLocalDates("2026-01-10", 30).map(toLocalDateKey);
    expect(january[0]).toBe("2025-12-12");
    expect(january.at(-1)).toBe("2026-01-10");

    const dst = getTrailingLocalDates("2026-03-20", 30);
    expect(dst.map(toLocalDateKey)).toHaveLength(30);
    expect(dst.some((date, index) => index > 0 && date.getTime() - (dst[index - 1]?.getTime() ?? 0) !== 86_400_000))
      .toBe(true);
    expect(() => getTrailingLocalDates("2026-08-17", 0)).toThrow("positive integer");
  });
});
