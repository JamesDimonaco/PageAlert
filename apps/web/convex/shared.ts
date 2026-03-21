/** Maximum retry attempts before marking a monitor as error */
export const MAX_RETRIES = 3;

/** Convert a check interval string to milliseconds */
export function intervalToMs(interval: string): number {
  const map: Record<string, number> = {
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "6h": 6 * 60 * 60_000,
    "24h": 24 * 60 * 60_000,
  };
  return map[interval] ?? 60 * 60_000;
}
