export interface DateRange {
  key: string;
  start: Date;
  end: Date;
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
