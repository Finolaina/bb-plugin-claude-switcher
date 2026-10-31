// The day's pace of an account's weekly window: the brake that replaces the
// 5-hour window on an Ultra account (Optimizador informes/2026-10-30/ultra/
// SPEC.md §2). Without that window a night of background work can eat two
// days of the week (measured 22-30 Oct 2026: nights of 24-29 points against
// ~14 a day spread evenly). Each day gets an even share of what is left of
// the week; at 90 % of it the account takes no more background work and is
// kept for the user. Pure: the caller keeps the day's first reading.
import type { UsageWindow } from "./policy.js";

/** The zone the day is counted in. */
export const DAY_ZONE = "Europe/Madrid";
/** From this share of the day's budget on, no background work. */
export const BACKGROUND_STOP_PERCENT = 90;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Two readings of one weekly window may report its reset this far apart. */
const SAME_RESET_MS = 5 * 60_000;

/** The day's first reading of the weekly window, as the caller keeps it. */
export interface DayStart {
  at: number;
  usedPercent: number;
  resetsAt: number;
}

export interface Pace {
  /** Points of the week for today. */
  budget: number;
  /** Points spent since the day's first reading. */
  spent: number;
  /** Spent as a share of the budget (100 with no budget). */
  dayPercent: number;
  /** Below BACKGROUND_STOP_PERCENT: background work may still come here. */
  background: boolean;
}

/** How far `timeZone`'s clock is ahead of UTC at `at`, in ms. */
export function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour"),
    n("minute"),
    n("second"),
  );
  return local - Math.floor(at / 1000) * 1000;
}

/** The latest `hour`:00 in `timeZone` at or before `now`: when today's budget began. */
export function dayStart(
  now: number,
  hour: number,
  timeZone: string = DAY_ZONE,
): number {
  const local = new Date(now + zoneOffsetMs(now, timeZone));
  let startLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
  );
  if (startLocal > local.getTime()) startLocal -= DAY;
  // The offset at the start itself, which a change of time in between moves.
  const guess = startLocal - zoneOffsetMs(now, timeZone);
  return startLocal - zoneOffsetMs(guess, timeZone);
}

/** When the day counts from for a week resetting at `resetsAt`: its start, or the week's when the week began today. */
function countsFrom(resetsAt: number, now: number, hour: number): number {
  return Math.max(dayStart(now, hour), resetsAt - WEEK);
}

/** Whether `start` is the day's first reading of the week resetting at `resetsAt`. */
function startsToday(
  start: DayStart | undefined,
  resetsAt: number,
  now: number,
  hour: number,
): start is DayStart {
  return (
    start !== undefined &&
    start.at >= countsFrom(resetsAt, now, hour) &&
    Math.abs(start.resetsAt - resetsAt) <= SAME_RESET_MS
  );
}

/**
 * The day's pace of `weekly` read now, from the day's first reading
 * `start` (the reading now when there is none of today's week). Null when
 * it cannot be told: no general weekly (a Team seat) or no reset of it.
 */
export function paceOf(
  weekly: UsageWindow,
  start: DayStart | undefined,
  now: number,
  hour: number,
): Pace | null {
  if (weekly.absent === true || weekly.resetsAt === null) return null;
  const from = countsFrom(weekly.resetsAt, now, hour);
  const p0 = startsToday(start, weekly.resetsAt, now, hour)
    ? start.usedPercent
    : weekly.usedPercent;
  const daysLeft = Math.max(1, (weekly.resetsAt - from) / DAY);
  const budget = Math.max(0, 100 - p0) / daysLeft;
  const spent = Math.max(0, weekly.usedPercent - p0);
  const dayPercent = budget === 0 ? 100 : (spent / budget) * 100;
  return {
    budget,
    spent,
    dayPercent,
    background: dayPercent < BACKGROUND_STOP_PERCENT,
  };
}

/**
 * What to keep as the day's first reading after `reading`: the one kept
 * while it is still today's, of the same week (its reset within 5 min);
 * else the reading itself when it is today's. A reading without a reset
 * (an incomplete answer) replaces nothing: the kept one stays, or else
 * the next good reading would be the day's first and give away what was
 * spent before it (Codex ULTRA-R04). The caller drops the kept one of a
 * Team seat, which has no general weekly at all.
 */
export function nextDayStart(
  kept: DayStart | undefined,
  reading: { at: number; usedPercent: number; resetsAt: number | null },
  hour: number,
): DayStart | undefined {
  if (reading.resetsAt === null) return kept;
  if (startsToday(kept, reading.resetsAt, reading.at, hour)) return kept;
  return reading.at >= countsFrom(reading.resetsAt, reading.at, hour)
    ? {
        at: reading.at,
        usedPercent: reading.usedPercent,
        resetsAt: reading.resetsAt,
      }
    : kept;
}

/** The share of the week kept for the user by default (Inbox #150, 2026-10-31: proposed, provisional). */
export const DEFAULT_FABLE_RESERVE_PERCENT = 20;

export interface FableRoom {
  /** Background work may still run Fable here. */
  open: boolean;
  /** Why not: the day's share is spent, the user's reserve reached, or the week's reset unknown. */
  why: "pace" | "reserve" | "unknown" | null;
  /** Percent of the week that can still run Fable (the fuller of its window and the general week). */
  left: number;
  /** The percent kept for the user. */
  reserve: number;
  /** The day's pace of the Fable window; null when its reset is unknown. */
  pace: Pace | null;
  /** When it may open again: the next day's start or the reset, whichever comes first; null when unknown. */
  nextAt: number | null;
  /** When the Fable week resets. */
  resetsAt: number | null;
}

/**
 * Whether background work may run Fable on an account with a week of its own
 * (Aitor, 2026-10-31): not past the day's pace of the Fable window (what is
 * left over the days to the reset, as paceOf counts it) nor down to the
 * reserve kept for the user. Equal to the reserve is closed: one more turn
 * would go under it. Unknown is closed too. Pure, as paceOf; the caller
 * keeps the day's first reading of the Fable window.
 */
export function fableRoom(input: {
  fable: UsageWindow;
  weekly: UsageWindow;
  start: DayStart | undefined;
  now: number;
  hour: number;
  reservePercent: number;
}): FableRoom {
  const { fable, weekly, start, now, hour, reservePercent } = input;
  const left = Math.max(
    0,
    100 - Math.max(fable.usedPercent, weekly.absent === true ? 0 : weekly.usedPercent),
  );
  const pace = paceOf(fable, start, now, hour);
  const resetsAt = fable.resetsAt ?? weekly.resetsAt;
  const nextDay = dayStart(now, hour) + DAY;
  const nextAt = resetsAt === null ? null : Math.min(nextDay, resetsAt);
  const why: FableRoom["why"] =
    pace === null
      ? "unknown"
      : left <= reservePercent
        ? "reserve"
        : pace.background
          ? null
          : "pace";
  return { open: why === null, why, left, reserve: reservePercent, pace, nextAt, resetsAt };
}
