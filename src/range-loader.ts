export interface RangeLoadResult<T> {
  dateKey: string;
  value: T | undefined;
  error: unknown;
}

export async function loadDateRange<T>(
  dateKeys: string[],
  load: (dateKey: string) => Promise<T>,
  concurrency = 6
): Promise<RangeLoadResult<T>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }

  const uniqueKeys = [...new Set(dateKeys)];
  const results = new Map<string, RangeLoadResult<T>>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < uniqueKeys.length) {
      const dateKey = uniqueKeys[nextIndex];
      nextIndex += 1;
      if (dateKey === undefined) continue;
      try {
        results.set(dateKey, { dateKey, value: await load(dateKey), error: undefined });
      } catch (error) {
        results.set(dateKey, { dateKey, value: undefined, error });
      }
    }
  }

  const workerCount = Math.min(concurrency, uniqueKeys.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return dateKeys.map((dateKey) => results.get(dateKey) ?? { dateKey, value: undefined, error: undefined });
}
