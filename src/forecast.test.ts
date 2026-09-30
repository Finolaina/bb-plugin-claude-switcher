import { describe, expect, it } from "vitest";
import {
  SAME_RESET_MS,
  forecastWindow,
  recordSample,
  type Series,
} from "./forecast.js";

const T0 = Date.parse("2026-09-28T08:00:00.000Z");
const HOUR = 3_600_000;
const RESET = T0 + 5 * 24 * HOUR;

describe("forecastWindow", () => {
  it("projects when the window runs out at the average pace since its first sample", () => {
    // 10 % → 40 % in 24 h: 30 points a day; 60 points left → 2 days more.
    const series: Series = {
      resetsAt: RESET,
      points: [
        [T0, 10],
        [T0 + 12 * HOUR, 25],
        [T0 + 24 * HOUR, 40],
      ],
    };
    expect(forecastWindow(series, T0 + 24 * HOUR)).toEqual({
      kind: "runs-out",
      at: T0 + 72 * HOUR,
      percentPerDay: 30,
    });
  });

  it("says the window lasts until its reset when the pace does not reach 100 % first", () => {
    const series: Series = {
      resetsAt: T0 + 2 * 24 * HOUR,
      points: [
        [T0, 10],
        [T0 + 24 * HOUR, 20],
      ],
    };
    expect(forecastWindow(series, T0 + 24 * HOUR)).toEqual({
      kind: "lasts",
      until: T0 + 2 * 24 * HOUR,
      percentPerDay: 10,
    });
  });

  it("calls a window steady under one point a day", () => {
    const series: Series = {
      resetsAt: RESET,
      points: [
        [T0, 10],
        [T0 + 24 * HOUR, 10.5],
      ],
    };
    expect(forecastWindow(series, T0 + 24 * HOUR)).toEqual({ kind: "steady" });
  });

  it("has no forecast with less than two hours of history, no reset, or a reset already passed", () => {
    const short: Series = {
      resetsAt: RESET,
      points: [
        [T0, 10],
        [T0 + HOUR, 40],
      ],
    };
    expect(forecastWindow(short, T0 + HOUR)).toEqual({ kind: "unknown" });
    const noReset: Series = { resetsAt: null, points: [[T0, 10], [T0 + 24 * HOUR, 40]] };
    expect(forecastWindow(noReset, T0 + 24 * HOUR)).toEqual({ kind: "unknown" });
    const passed: Series = { resetsAt: RESET, points: [[T0, 10], [T0 + 24 * HOUR, 40]] };
    expect(forecastWindow(passed, RESET + 1)).toEqual({ kind: "unknown" });
    expect(forecastWindow(undefined, T0)).toEqual({ kind: "unknown" });
  });

  it("rounds the pace to a tenth of a point", () => {
    const series: Series = {
      resetsAt: RESET,
      points: [
        [T0, 0],
        [T0 + 7 * HOUR, 10],
      ],
    };
    // 10 points in 7 h = 34.2857 a day.
    expect(forecastWindow(series, T0 + 7 * HOUR)).toMatchObject({
      kind: "runs-out",
      percentPerDay: 34.3,
    });
  });
});

describe("recordSample", () => {
  it("starts a series with the first sample", () => {
    expect(
      recordSample(undefined, { at: T0, usedPercent: 10, resetsAt: RESET }),
    ).toEqual({ resetsAt: RESET, points: [[T0, 10]] });
  });

  it("keeps the first sample of the window and the latest one", () => {
    let series = recordSample(undefined, { at: T0, usedPercent: 10, resetsAt: RESET });
    series = recordSample(series, { at: T0 + 5 * 60_000, usedPercent: 11, resetsAt: RESET });
    expect(series.points).toEqual([
      [T0, 10],
      [T0 + 5 * 60_000, 11],
    ]);
    series = recordSample(series, { at: T0 + 40 * 60_000, usedPercent: 15, resetsAt: RESET });
    series = recordSample(series, { at: T0 + 3 * HOUR, usedPercent: 15, resetsAt: RESET });
    // A week of samples costs the storage of two.
    expect(series.points).toEqual([
      [T0, 10],
      [T0 + 3 * HOUR, 15],
    ]);
  });

  it("takes a reset that moved by seconds as the same window", () => {
    // The provider answers the same reset with a different fraction of a second each time.
    let series = recordSample(undefined, { at: T0, usedPercent: 10, resetsAt: RESET + 612 });
    series = recordSample(series, { at: T0 + HOUR, usedPercent: 12, resetsAt: RESET - 377 });
    series = recordSample(series, { at: T0 + 2 * HOUR, usedPercent: 14, resetsAt: RESET + 45 });
    expect(series).toEqual({
      resetsAt: RESET + 45,
      points: [
        [T0, 10],
        [T0 + 2 * HOUR, 14],
      ],
    });
    // Up to five minutes, not one millisecond more.
    const moved = recordSample(series, {
      at: T0 + 3 * HOUR,
      usedPercent: 16,
      resetsAt: RESET + 45 + SAME_RESET_MS - 1,
    });
    expect(moved.points).toHaveLength(2);
    const another = recordSample(series, {
      at: T0 + 3 * HOUR,
      usedPercent: 16,
      resetsAt: RESET + 45 + SAME_RESET_MS,
    });
    expect(another).toEqual({
      resetsAt: RESET + 45 + SAME_RESET_MS,
      points: [[T0 + 3 * HOUR, 16]],
    });
    const earlier = recordSample(series, {
      at: T0 + 3 * HOUR,
      usedPercent: 16,
      resetsAt: RESET + 45 - SAME_RESET_MS,
    });
    expect(earlier.points).toEqual([[T0 + 3 * HOUR, 16]]);
  });

  it("starts over when the window resets: another reset, or the share fell", () => {
    const series: Series = { resetsAt: RESET, points: [[T0, 10], [T0 + HOUR, 40]] };
    expect(
      recordSample(series, { at: T0 + 2 * HOUR, usedPercent: 3, resetsAt: RESET + 7 * 24 * HOUR }),
    ).toEqual({ resetsAt: RESET + 7 * 24 * HOUR, points: [[T0 + 2 * HOUR, 3]] });
    // Another reset is another window, even with more used than before.
    expect(
      recordSample(series, { at: T0 + 2 * HOUR, usedPercent: 55, resetsAt: RESET + 7 * 24 * HOUR }),
    ).toEqual({ resetsAt: RESET + 7 * 24 * HOUR, points: [[T0 + 2 * HOUR, 55]] });
    expect(
      recordSample(series, { at: T0 + 2 * HOUR, usedPercent: 3, resetsAt: RESET }),
    ).toEqual({ resetsAt: RESET, points: [[T0 + 2 * HOUR, 3]] });
    // The same share is not a fall.
    expect(
      recordSample(series, { at: T0 + 2 * HOUR, usedPercent: 40, resetsAt: RESET }).points,
    ).toHaveLength(2);
  });

  it("keeps a single point while the provider gives no reset", () => {
    let series = recordSample(undefined, { at: T0, usedPercent: 10, resetsAt: null });
    series = recordSample(series, { at: T0 + HOUR, usedPercent: 12, resetsAt: null });
    series = recordSample(series, { at: T0 + 2 * HOUR, usedPercent: 14, resetsAt: null });
    expect(series).toEqual({ resetsAt: null, points: [[T0 + 2 * HOUR, 14]] });
    // The window starts to count when its reset is known.
    series = recordSample(series, { at: T0 + 3 * HOUR, usedPercent: 15, resetsAt: RESET });
    expect(series).toEqual({ resetsAt: RESET, points: [[T0 + 3 * HOUR, 15]] });
  });
});
