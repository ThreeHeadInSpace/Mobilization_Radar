import { day, clock, type Config } from "../config/index.js";
// Manual checks never consume scheduled keys. Catch up slots crossed by a manual run,
// including midnight, before considering today's ordinary slots.
export function nextScheduledKey(
  c: Config,
  now: Date,
  runs: any[],
): string | undefined {
  const hours = c.MONITOR_HOURS.split(",")
    .map((h) => `${h.padStart(2, "0")}:00`)
    .sort();
  const today = day(now, c.APP_TIMEZONE),
    time = clock(now, c.APP_TIMEZONE);
  const keys = new Set(
    hours.filter((h) => h <= time).map((h) => `${today}:${h}`),
  );
  for (const run of runs.filter((r) => r.trigger_type === "manual-review")) {
    const start = new Date(run.started_at),
      end = new Date(run.finished_at ?? now);
    const first = day(start, c.APP_TIMEZONE),
      last = day(end, c.APP_TIMEZONE);
    for (
      let date = first;
      date <= last;
      date = new Date(Date.parse(date + "T12:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10)
    ) {
      for (const hour of hours) {
        if (date === first && hour < clock(start, c.APP_TIMEZONE)) continue;
        if (date === last && hour > clock(end, c.APP_TIMEZONE)) continue;
        if (date > today || (date === today && hour > time)) continue;
        keys.add(`${date}:${hour}`);
      }
    }
  }
  const done = new Set(
    runs
      .filter((r) => r.trigger_type === "scheduled")
      .map((r) => r.idempotency_key),
  );
  return [...keys].sort().find((key) => !done.has(key));
}
