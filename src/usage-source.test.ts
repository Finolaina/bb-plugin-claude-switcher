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
      login: "yes",
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

  it("gives bb's panel no 5-hour window for an account without a session (Ultra, 2026-10-30)", () => {
    const measurement = toMeasurement(ACCOUNT, {
      observedAt: NOW,
      problem: null,
      login: "yes",
      usage: {
        blocked: false,
        session: { usedPercent: 0, resetsAt: null, absent: true },
        weekly: { usedPercent: 98, resetsAt: null },
        models: {},
      },
    });
    expect(
      measurement.usage.status === "ok"
        ? measurement.usage.windows.map((w) => w.id)
        : [],
    ).toEqual(["weekly"]);
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
        login: "no",
      }).usage,
    ).toEqual({ status: "unauthenticated", ...base });
    expect(
      toMeasurement(ACCOUNT, {
        observedAt: null,
        usage: null,
        problem: { kind: "error", message: "boom" },
        login: "unknown",
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
      login: "yes",
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

  // Codex ULTRA-R05: the badge said only the account's name. bb's panel
  // heads the card with the email and replaces planLabel by its own word
  // when it knows plan.id ("max", "team"), so the name would be lost: the
  // plan goes in the label, beside the name, and plan stays null.
  it("labels the card with the account's name and the plan's short text (planOf)", () => {
    const usage = (
      session: { usedPercent: number; resetsAt: number | null; absent?: true },
      weekly: { usedPercent: number; resetsAt: number | null; absent?: true },
    ) => ({
      observedAt: NOW,
      problem: null,
      login: "yes" as const,
      usage: { blocked: false, session, weekly, models: {} },
    });
    const ultraFree = toMeasurement(
      {
        ...ACCOUNT,
        name: "aitor",
        kind: "max",
        tier: "default_claude_max_20x",
      },
      usage(
        { usedPercent: 0, resetsAt: null, absent: true },
        { usedPercent: 98, resetsAt: null },
      ),
    ).usage;
    expect(ultraFree).toMatchObject({
      plan: null,
      planLabel: "aitor · Ultra · sin tope de 5 h",
    });
    const ultraFive = toMeasurement(
      { ...ACCOUNT, name: "mariscal", kind: "max", planName: "Ultra" },
      usage(
        { usedPercent: 10, resetsAt: null },
        { usedPercent: 40, resetsAt: null },
      ),
    ).usage;
    expect(ultraFive).toMatchObject({
      planLabel: "mariscal · Ultra · con 5 h",
    });
    const team = toMeasurement(
      { ...ACCOUNT, name: "team1", kind: "team" },
      usage(
        { usedPercent: 10, resetsAt: null },
        { usedPercent: 0, resetsAt: null, absent: true },
      ),
    ).usage;
    expect(team).toMatchObject({ plan: null, planLabel: "team1 · Team" });
    // Nothing known of the plan: the name alone, as before.
    expect(
      toMeasurement(ACCOUNT, {
        observedAt: null,
        usage: null,
        problem: { kind: "unauthenticated" },
        login: "no",
      }).usage,
    ).toMatchObject({ planLabel: "work" });
  });
});
