import { describe, expect, it } from "vitest";
import { dayStart, nextDayStart, paceOf, type DayStart } from "./pace.js";

const H = 3_600_000;
const D = 24 * H;
// 09:00 in Madrid on 2026-10-30 (CET, UTC+1 since 2026-10-25).
const T0 = Date.parse("2026-10-30T09:00:00+01:00");

describe("dayStart (the day runs from 09:00 to 09:00 in Madrid)", () => {
  it("is today's 09:00 after nine and yesterday's before", () => {
    expect(dayStart(Date.parse("2026-10-30T21:55:58+01:00"), 9)).toBe(T0);
    expect(dayStart(Date.parse("2026-10-31T08:59:00+01:00"), 9)).toBe(T0);
    expect(dayStart(Date.parse("2026-10-31T09:00:00+01:00"), 9)).toBe(T0 + D);
  });

  it("follows summer time", () => {
    expect(dayStart(Date.parse("2026-07-01T10:00:00Z"), 9)).toBe(
      Date.parse("2026-07-01T09:00:00+02:00"),
    );
    // The night of the change (25 Oct 2026, 03:00 CEST → 02:00 CET).
    expect(dayStart(Date.parse("2026-10-25T10:00:00+01:00"), 9)).toBe(
      Date.parse("2026-10-25T09:00:00+01:00"),
    );
  });

  it("takes another hour", () => {
    expect(dayStart(Date.parse("2026-10-30T07:00:00+01:00"), 6)).toBe(
      Date.parse("2026-10-30T06:00:00+01:00"),
    );
  });
});

describe("paceOf (SPEC 2026-10-30 §2)", () => {
  const reset = T0 + 7 * D;
  const start: DayStart = { at: T0 + 60_000, usedPercent: 30, resetsAt: reset };
  const now = T0 + 2 * H;

  it("stops background work at 90 % of the day's budget, exactly (canary 4)", () => {
    // 70 points left over 7 days: 10 for today.
    const at90 = paceOf({ usedPercent: 39, resetsAt: reset }, start, now, 9);
    expect(at90).toEqual({
      budget: 10,
      spent: 9,
      dayPercent: 90,
      background: false,
    });
    const below = paceOf({ usedPercent: 38.9, resetsAt: reset }, start, now, 9);
    expect(below?.background).toBe(true);
    expect(below?.spent).toBeCloseTo(8.9, 9);
  });

  it("counts the day from the week's start when the week began today", () => {
    const weekStart = T0 + 3 * H;
    const p = paceOf(
      { usedPercent: 5, resetsAt: weekStart + 7 * D },
      { at: weekStart + 60_000, usedPercent: 0, resetsAt: weekStart + 7 * D },
      weekStart + 4 * H,
      9,
    );
    expect(p).toMatchObject({ budget: 100 / 7, spent: 5 });
  });

  it("takes the reading now as the day's first when the stored one is of another day or week", () => {
    const yesterday: DayStart = { ...start, at: T0 - H };
    expect(
      paceOf({ usedPercent: 50, resetsAt: reset }, yesterday, now, 9),
    ).toMatchObject({
      spent: 0,
      background: true,
    });
    const otherWeek: DayStart = { ...start, resetsAt: reset - 10 * 60_000 };
    expect(
      paceOf({ usedPercent: 50, resetsAt: reset }, otherWeek, now, 9)?.spent,
    ).toBe(0);
    // Within 5 minutes it is the same week.
    const sameWeek: DayStart = { ...start, resetsAt: reset - 4 * 60_000 };
    expect(
      paceOf({ usedPercent: 50, resetsAt: reset }, sameWeek, now, 9)?.spent,
    ).toBe(20);
    expect(
      paceOf({ usedPercent: 50, resetsAt: reset }, undefined, now, 9)?.spent,
    ).toBe(0);
  });

  it("is unknown without a weekly reset and on a Team seat (no general weekly)", () => {
    expect(
      paceOf({ usedPercent: 40, resetsAt: null }, start, now, 9),
    ).toBeNull();
    expect(
      paceOf({ usedPercent: 0, resetsAt: null, absent: true }, start, now, 9),
    ).toBeNull();
  });

  it("gives no budget and no background work to a week already spent", () => {
    expect(
      paceOf(
        { usedPercent: 100, resetsAt: reset },
        { ...start, usedPercent: 100 },
        now,
        9,
      ),
    ).toEqual({ budget: 0, spent: 0, dayPercent: 100, background: false });
  });

  it("gives the last day the whole rest of the week", () => {
    const lastReset = T0 + 5 * H;
    const p = paceOf(
      { usedPercent: 82, resetsAt: lastReset },
      { at: T0 + 60_000, usedPercent: 80, resetsAt: lastReset },
      now,
      9,
    );
    expect(p).toMatchObject({ budget: 20, spent: 2, dayPercent: 10 });
  });
});

describe("nextDayStart (what is kept as the day's first reading)", () => {
  const reset = T0 + 7 * D;
  const kept: DayStart = { at: T0 + 60_000, usedPercent: 30, resetsAt: reset };

  it("keeps the day's first reading of the same week", () => {
    expect(
      nextDayStart(
        kept,
        { at: T0 + 2 * H, usedPercent: 35, resetsAt: reset },
        9,
      ),
    ).toBe(kept);
  });

  it("starts again with the reading on a new day or a new week", () => {
    const tomorrow = { at: T0 + D + 60_000, usedPercent: 40, resetsAt: reset };
    expect(nextDayStart(kept, tomorrow, 9)).toEqual(tomorrow);
    const newWeek = { at: T0 + 2 * H, usedPercent: 1, resetsAt: T0 + H + 7 * D };
    expect(nextDayStart(kept, newWeek, 9)).toEqual(newWeek);
    expect(nextDayStart(undefined, newWeek, 9)).toEqual(newWeek);
  });

  it("keeps nothing for a window without a reset", () => {
    expect(
      nextDayStart(kept, { at: T0 + H, usedPercent: 0, resetsAt: null }, 9),
    ).toBeUndefined();
  });
});
