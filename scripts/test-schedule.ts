import { strict as assert } from "node:assert";
import { nextScheduledRun, scheduleSummary } from "../src/lib/schedule";
import type { ScheduledTask } from "../src/types";

const base: ScheduledTask = {
  id: "test",
  name: "test",
  prompt: "test",
  cwd: "D:\\repo",
  frequency: "daily",
  hour: 9,
  minute: 15,
  weekday: 1,
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: "",
  lastMessage: "",
};

const localDate = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const hourly = { ...base, frequency: "hourly" as const, minute: 45 };
assert.equal(nextScheduledRun(hourly, localDate(2026, 8, 18, 10, 30)), localDate(2026, 8, 18, 10, 45));
assert.equal(nextScheduledRun(hourly, localDate(2026, 8, 18, 10, 50)), localDate(2026, 8, 18, 11, 45));

assert.equal(nextScheduledRun(base, localDate(2026, 8, 18, 8, 0)), localDate(2026, 8, 18, 9, 15));
assert.equal(nextScheduledRun(base, localDate(2026, 8, 18, 10, 0)), localDate(2026, 8, 19, 9, 15));

const weekdays = { ...base, frequency: "weekdays" as const };
assert.equal(nextScheduledRun(weekdays, localDate(2026, 8, 21, 10, 0)), localDate(2026, 8, 24, 9, 15));

const weekly = { ...base, frequency: "weekly" as const, weekday: 1 };
assert.equal(nextScheduledRun(weekly, localDate(2026, 8, 18, 10, 0)), localDate(2026, 8, 24, 9, 15));
assert.equal(scheduleSummary(weekly), "每周一 09:15");

console.log("schedule: all assertions passed");
