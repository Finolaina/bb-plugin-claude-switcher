import { describe, expect, it } from "vitest";
import { parseUsage } from "./usage.js";

// Shape of GET https://api.anthropic.com/api/oauth/usage as observed on
// 2026-09-28 for a Max plan (values only; no credentials involved).
const payload = {
  limits: [
    { kind: "session", group: "session", percent: 20, severity: "normal",
      resets_at: "2026-09-28T23:59:59.921492+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 78, severity: "warning",
      resets_at: "2026-10-03T09:59:59.921515+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 100, severity: "critical",
      resets_at: "2026-10-03T09:59:59.921692+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
  ],
  five_hour: { utilization: 20.0, resets_at: "2026-09-28T23:59:59.921492+00:00",
    limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 78.0, resets_at: "2026-10-03T09:59:59.921515+00:00",
    limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
};

describe("parseUsage", () => {
  it("maps session, weekly and per-model windows from limits[]", () => {
    const usage = parseUsage(payload);
    expect(usage).toEqual({
      blocked: false,
      session: { usedPercent: 20, resetsAt: Date.parse("2026-09-28T23:59:59.921Z") },
      weekly: { usedPercent: 78, resetsAt: Date.parse("2026-10-03T09:59:59.921Z") },
      models: { Fable: { usedPercent: 100, resetsAt: Date.parse("2026-10-03T09:59:59.921Z") } },
    });
  });

  it("marks the account blocked when the provider reports a lock", () => {
    const locked = { ...payload, seven_day: { ...payload.seven_day, locked_reason: "abuse" } };
    expect(parseUsage(locked).blocked).toBe(true);
  });

  it("marks the account blocked when session or weekly is missing (no data, no choice)", () => {
    const partial = { ...payload, limits: payload.limits.filter((l) => l.kind !== "weekly_all") };
    expect(parseUsage(partial).blocked).toBe(true);
    expect(parseUsage(partial).weekly).toEqual({ usedPercent: 100, resetsAt: null });
    expect(parseUsage(partial).unknown).toBe(true);
  });

  it("takes a reported lock as proof even when a window is missing", () => {
    const lockedPartial = {
      ...payload,
      limits: payload.limits.filter((l) => l.kind !== "weekly_all"),
      five_hour: { ...payload.five_hour, locked_reason: "abuse" },
    };
    expect(parseUsage(lockedPartial).blocked).toBe(true);
    expect(parseUsage(lockedPartial).unknown).toBeUndefined();
  });

  it("keeps the fullest window when a model is listed twice (also in another case)", () => {
    const scoped = (display_name: string, percent: number) => ({
      kind: "weekly_scoped", group: "weekly", percent, severity: "normal",
      resets_at: "2026-10-03T09:59:59.921692+00:00",
      scope: { model: { id: null, display_name }, surface: null }, is_active: true,
    });
    const usage = parseUsage({
      ...payload,
      limits: [payload.limits[0], payload.limits[1], scoped("Fable", 100), scoped("fable", 3)],
    });
    expect(Object.keys(usage.models)).toEqual(["Fable"]);
    expect(usage.models["Fable"]?.usedPercent).toBe(100);
    const reversed = parseUsage({
      ...payload,
      limits: [payload.limits[0], payload.limits[1], scoped("fable", 3), scoped("Fable", 100)],
    });
    expect(reversed.models).toEqual({ fable: usage.models["Fable"] });
  });

  it("rejects a percent outside 0..100 or a reset without timezone", () => {
    const bad = { ...payload, limits: payload.limits.map((l) =>
      l.kind === "session" ? { ...l, percent: 250 } : l) };
    expect(() => parseUsage(bad)).toThrow(/percent/);
    const naive = { ...payload, limits: payload.limits.map((l) =>
      l.kind === "session" ? { ...l, resets_at: "2026-09-28T23:59:59" } : l) };
    expect(() => parseUsage(naive)).toThrow(/timezone/);
  });
});
