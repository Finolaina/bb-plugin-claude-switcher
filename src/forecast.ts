// Pace of a usage window and when it runs out at that pace.
//
// One series per window (the weekly window, each model's window) holds the
// samples taken inside the CURRENT window: a new reset starts a new series.
// The forecast is the average pace since the first sample of the window
// ("at this pace"): plain and explainable, and a quiet night does not hide a
// busy week the way a short-term slope would.

export interface Sample {
  at: number;
  usedPercent: number;
  resetsAt: number | null;
}

export interface Series {
  /** The window's reset; null when the provider gave none (no forecast then). */
  resetsAt: number | null;
  /** [at, usedPercent], oldest first. */
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
/** Samples closer than this to the previous one are folded into it. */
export const SAMPLE_SPACING_MS = 30 * 60_000;
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
  const rounded = Math.round(percentPerDay * 10) / 10;
  return at < series.resetsAt
    ? { kind: "runs-out", at: Math.round(at), percentPerDay: rounded }
    : { kind: "lasts", until: series.resetsAt, percentPerDay: rounded };
}

/**
 * The series with `sample` added: a new window (another reset, or the used
 * share fell, which only a reset does) starts a fresh series; a sample too
 * close to the previous one replaces it, so a busy hour costs no storage.
 */
export function recordSample(
  series: Series | undefined,
  sample: Sample,
): Series {
  const last = series?.points[series.points.length - 1];
  if (
    series === undefined ||
    last === undefined ||
    series.resetsAt !== sample.resetsAt ||
    sample.usedPercent < last[1]
  )
    return {
      resetsAt: sample.resetsAt,
      points: [[sample.at, sample.usedPercent]],
    };
  const points = series.points.slice();
  const previous = points[points.length - 2];
  if (previous !== undefined && sample.at - previous[0] < SAMPLE_SPACING_MS)
    points.pop();
  points.push([sample.at, sample.usedPercent]);
  return { resetsAt: series.resetsAt, points };
}
