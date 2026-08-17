export interface DateRange {
  key: string;
  start: Date;
  end: Date;
}

export interface DateNavigationItem {
  key: string;
  date: Date;
  selected: boolean;
  today: boolean;
}

export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getLocalDateRange(date: Date | string): DateRange {
  const key = typeof date === "string" ? date : toLocalDateKey(date);
  const parts = key.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid date: ${key}`);
  }

  const start = new Date(year, month - 1, day);
  if (Number.isNaN(start.getTime()) || toLocalDateKey(start) !== key) {
    throw new Error(`Invalid date: ${key}`);
  }

  const end = new Date(year, month - 1, day + 1);
  return { key, start, end };
}

export function addLocalDays(date: Date | string, days: number): Date {
  const { start } = getLocalDateRange(date);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
}

export function isToday(date: Date | string, today = new Date()): boolean {
  const key = typeof date === "string" ? date : toLocalDateKey(date);
  return key === toLocalDateKey(today);
}

export function isFutureDate(date: Date | string, today = new Date()): boolean {
  const key = typeof date === "string" ? date : toLocalDateKey(date);
  return key > toLocalDateKey(today);
}

export function getDateNavigator(
  selectedDate: Date | string,
  today = new Date(),
  radius = 3
): DateNavigationItem[] {
  const selectedKey = typeof selectedDate === "string" ? selectedDate : toLocalDateKey(selectedDate);
  const todayKey = toLocalDateKey(today);
  const items: DateNavigationItem[] = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    const date = addLocalDays(selectedKey, offset);
    const key = toLocalDateKey(date);
    items.push({ key, date, selected: key === selectedKey, today: key === todayKey });
  }
  return items;
}

export function getLocalWeek(date: Date | string): Date[] {
  const selected = getLocalDateRange(date).start;
  const mondayOffset = (selected.getDay() + 6) % 7;
  const monday = addLocalDays(selected, -mondayOffset);
  return Array.from({ length: 7 }, (_, index) => addLocalDays(monday, index));
}

export function getTrailingLocalDates(date: Date | string, count: number): Date[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Date count must be a positive integer");
  return Array.from({ length: count }, (_, index) => addLocalDays(date, index - count + 1));
}
