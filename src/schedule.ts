import type { Config } from "./config.js";
export function inWindow(c: Config["schedule"], date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: c.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
  const day =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  const t = `${p.hour}:${p.minute}`;
  return c.weekdays.includes(day) && t >= c.start && t < c.end;
}
export function backoff(attempt: number, base = 10_000) {
  return Math.min(Math.max(300_000, base), base * 2 ** Math.min(Math.max(0, attempt - 1), 10));
}
