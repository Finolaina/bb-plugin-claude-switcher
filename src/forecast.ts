// Pace of a usage window and when it runs out at that pace.
//
// One series per window (the weekly window, each model's window) holds the
// first sample taken inside the CURRENT window and the latest one: a new
// reset starts a new series. The forecast is the average pace between the
// two ("at this pace"): plain and explainable, and a quiet night does not
// hide a busy week the way a short-term slope would.

export interface Sample {
  at: number;
  usedPercent: number;
  resetsAt: number | null;
}

export interface Series {
  /** The window's reset; null when the provider gave none (no forecast then). */
  resetsAt: number | null;
  /** [at, usedPercent]: the first sample of the window and, after it, the latest. */
  points: [number, number][];
}

export type Forecast =
  /** At this pace the window hits 100 % at `at`, before its reset. */
  | { kind: "runs-out"; at: number; percentPerDay: number }
  /** At this pace the window lasts until its reset. */
  | { kind: "lasts"; until: number; percentPerDay: number }
  /** No use worth measuring since the first sample of the window. */
  | { kind: "steady" }
  /** Too little history in this window, or no reset to measure against. */
  | { kind: "unknown" };

/** Below this span the pace is guesswork. */
export const MIN_SPAN_MS = 2 * 3_600_000;
/**
 * Two resets closer than this are the same window: the provider answers
 * one reset with a different fraction of a second at each query, and no
 * window is this short.
 */
export const SAME_RESET_MS = 5 * 60_000;
/** Under this pace (points per day) the window counts as idle. */
const STEADY_PER_DAY = 1;
const DAY_MS = 24 * 3_600_000;

export function forecastWindow(
  series: Series | undefined,
  now: number,
): Forecast {
  // A reset already passed: the window is new and the series belongs to the old one.
  if (
    series === undefined ||
    series.resetsAt === null ||
    series.resetsAt <= now
  )
    return { kind: "unknown" };
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  if (first === undefined || last === undefined) return { kind: "unknown" };
  const span = last[0] - first[0];
  if (span < MIN_SPAN_MS) return { kind: "unknown" };
  const percentPerDay = ((last[1] - first[1]) / span) * DAY_MS;
  if (percentPerDay < STEADY_PER_DAY) return { kind: "steady" };
  const left = 100 - last[1];
  const at = last[0] + (left / percentPerDay) * DAY_MS;
  // The projected moment passed and the last measurement was not full: the
  // pace was not kept (or nothing was measured since). No "runs out now".
  if (left > 0 && at <= now) return { kind: "unknown" };
  const rounded = Math.round(percentPerDay * 10) / 10;
  return at < series.resetsAt
    ? { kind: "runs-out", at: Math.round(at), percentPerDay: rounded }
    : { kind: "lasts", until: series.resetsAt, percentPerDay: rounded };
}

/**
 * The series with `sample` added: a new window (another reset, or the used
 * share fell, which only a reset does) starts a fresh series; otherwise the
 * sample replaces the latest one, so a series never grows past two points.
 * Without a reset there is no window to follow: one point, no forecast.
 */
export function recordSample(
  series: Series | undefined,
  sample: Sample,
): Series {
  const first = series?.points[0];
  const last = series?.points[series.points.length - 1];
  if (
    series === undefined ||
    first === undefined ||
    last === undefined ||
    series.resetsAt === null ||
    sample.resetsAt === null ||
    Math.abs(series.resetsAt - sample.resetsAt) >= SAME_RESET_MS ||
    sample.usedPercent < last[1]
  )
    return {
      resetsAt: sample.resetsAt,
      points: [[sample.at, sample.usedPercent]],
    };
  return {
    resetsAt: sample.resetsAt,
    points: [first, [sample.at, sample.usedPercent]],
  };
}
