import { describe, expect, it } from "vitest";
import type { Account } from "./accounts.js";
import { toMeasurement, toResource } from "./usage-source.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const ACCOUNT: Account = {
  name: "work",
  configDir: "/x/work",
  email: "work@example.com",
  accountUuid: "uuid-work",
};

describe("provider-usage source mapping", () => {
  it("lists an account as a shared claude-code resource keyed by its account uuid", () => {
    expect(toResource(ACCOUNT)).toEqual({
      id: "work",
      accountKey: "anthropic:account:uuid-work",
      providerId: "claude-code",
      label: "work · work@example.com",
      scope: { kind: "shared" },
    });
    expect(
      toResource({ ...ACCOUNT, accountUuid: null, email: null }),
    ).toMatchObject({
      accountKey: null,
      label: "work",
    });
  });

  it("maps session, weekly and per-model windows to the panel's window kinds", () => {
    const measurement = toMeasurement(ACCOUNT, {
      observedAt: NOW,
      problem: null,
      usage: {
        blocked: false,
        session: { usedPercent: 20, resetsAt: NOW + 3_600_000 },
        weekly: { usedPercent: 78, resetsAt: null },
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 7_200_000 } },
      },
    });
    expect(measurement).toEqual({
      accountKey: "anthropic:account:uuid-work",
      observedAt: NOW,
      usage: {
        status: "ok",
        plan: null,
        accountEmail: "work@example.com",
        planLabel: "work",
        windows: [
          {
            kind: "five-hour",
            id: "session",
            label: "Current session",
            usedPercent: 20,
            resetsAt: new Date(NOW + 3_600_000).toISOString(),
            model: null,
            cost: null,
          },
          {
            kind: "weekly",
            id: "weekly",
            label: "Weekly limit",
            usedPercent: 78,
            resetsAt: null,
            model: null,
            cost: null,
          },
          {
            kind: "weekly",
            id: "weekly:Fable",
            label: "Weekly · Fable",
            usedPercent: 100,
            resetsAt: new Date(NOW + 7_200_000).toISOString(),
            model: "Fable",
            cost: null,
          },
        ],
      },
    });
  });

  it("reports no login, a failed collection and a never-observed account as usage states", () => {
    const base = {
      accountEmail: "work@example.com",
      plan: null,
      planLabel: "work",
    };
    expect(
      toMeasurement(ACCOUNT, {
        observedAt: null,
        usage: null,
        problem: { kind: "unauthenticated" },
      }).usage,
    ).toEqual({ status: "unauthenticated", ...base });
    expect(
      toMeasurement(ACCOUNT, {
        observedAt: null,
        usage: null,
        problem: { kind: "error", message: "boom" },
      }).usage,
    ).toEqual({ status: "error", ...base, message: "boom" });
    expect(toMeasurement(ACCOUNT, undefined).usage).toEqual({
      status: "error",
      ...base,
      message: "Usage has not been observed for this account yet.",
    });
  });

  it("still returns stale usage after a failed refresh, with the old observedAt", () => {
    const measurement = toMeasurement(ACCOUNT, {
      observedAt: NOW - 60_000,
      problem: { kind: "error", message: "rate-limited" },
      usage: {
        blocked: false,
        session: { usedPercent: 1, resetsAt: null },
        weekly: { usedPercent: 2, resetsAt: null },
        models: {},
      },
    });
    expect(measurement.observedAt).toBe(NOW - 60_000);
    expect(measurement.usage.status).toBe("ok");
  });
});
