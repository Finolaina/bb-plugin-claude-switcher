import { describe, expect, it } from "vitest";
import { canRunModel, chooseAccount, type AccountUsage } from "./policy.js";

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse("2026-09-29T10:00:00.000Z");

function account(
  name: string,
  overrides: Partial<AccountUsage> = {},
): AccountUsage {
  return {
    name,
    blocked: false,
    session: { usedPercent: 10, resetsAt: NOW + 2 * HOUR },
    weekly: { usedPercent: 50, resetsAt: NOW + 48 * HOUR },
    models: {},
    ...overrides,
  };
}

describe("chooseAccount", () => {
  it("picks the account whose weekly window resets soonest", () => {
    const chosen = chooseAccount(
      [
        account("late", {
          weekly: { usedPercent: 10, resetsAt: NOW + 72 * HOUR },
        }),
        account("soon", {
          weekly: { usedPercent: 90, resetsAt: NOW + 6 * HOUR },
        }),
      ],
      { preferredModel: "Fable" },
    );
    expect(chosen).toEqual({ account: "soon", model: "Fable" });
  });

  it("ranks an account with no known weekly reset after every account that has one", () => {
    const chosen = chooseAccount(
      [
        account("unknown", { weekly: { usedPercent: 1, resetsAt: null } }),
        account("late", {
          weekly: { usedPercent: 90, resetsAt: NOW + 160 * HOUR },
        }),
      ],
      { preferredModel: "" },
    );
    expect(chosen?.account).toBe("late");
  });
});

describe("canRunModel", () => {
  it("with no preferred model, ignores every model row, even one the provider named \"\"", () => {
    const odd = account("odd", {
      models: { "": { usedPercent: 100, resetsAt: NOW + HOUR } },
    });
    expect(canRunModel(odd, "")).toBe(true);
    expect(canRunModel(odd, "Fable")).toBe(true);
    const fable = account("fable", {
      models: { Fable: { usedPercent: 100, resetsAt: NOW + HOUR } },
    });
    expect(canRunModel(fable, "")).toBe(true);
    expect(canRunModel(fable, "fable")).toBe(false);
  });
});

describe("chooseAccount: limits", () => {
  it("breaks a weekly-reset tie by the lower session usage", () => {
    const chosen = chooseAccount(
      [
        account("busy", { session: { usedPercent: 60, resetsAt: NOW + HOUR } }),
        account("idle", { session: { usedPercent: 5, resetsAt: NOW + HOUR } }),
      ],
      { preferredModel: "Fable" },
    );
    expect(chosen?.account).toBe("idle");
  });

  it("breaks a full tie by name, whatever the input order", () => {
    const b = account("beta");
    const a = account("alpha");
    expect(chooseAccount([b, a], { preferredModel: "" })?.account).toBe("alpha");
    expect(chooseAccount([a, b], { preferredModel: "" })?.account).toBe("alpha");
  });

  it("excludes exactly 100 % and keeps 99 % (session and weekly)", () => {
    const full = account("full", {
      session: { usedPercent: 100, resetsAt: NOW + HOUR },
    });
    const almost = account("almost", {
      session: { usedPercent: 99, resetsAt: NOW + HOUR },
      weekly: { usedPercent: 99, resetsAt: NOW + 99 * HOUR },
    });
    const weeklyFull = account("weekly-full", {
      weekly: { usedPercent: 100, resetsAt: NOW + HOUR },
    });
    expect(
      chooseAccount([full, weeklyFull, almost], { preferredModel: "Fable" })
        ?.account,
    ).toBe("almost");
    expect(
      chooseAccount([full, weeklyFull], { preferredModel: "Fable" }),
    ).toBeNull();
  });

  it("skips blocked accounts", () => {
    expect(
      chooseAccount([account("locked", { blocked: true })], {
        preferredModel: "Fable",
      }),
    ).toBeNull();
  });

  it("prefers an account with the preferred model free, even if it resets later", () => {
    const chosen = chooseAccount(
      [
        account("fable-out", {
          weekly: { usedPercent: 20, resetsAt: NOW + HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 30 * HOUR } },
        }),
        account("fable-ok", {
          weekly: { usedPercent: 20, resetsAt: NOW + 50 * HOUR },
          models: { Fable: { usedPercent: 40, resetsAt: NOW + 50 * HOUR } },
        }),
      ],
      { preferredModel: "Fable" },
    );
    expect(chosen).toEqual({ account: "fable-ok", model: "Fable" });
  });

  it("no account able to run the preferred model means no choice (Fable waits for Fable)", () => {
    const out = account("out", {
      models: { Fable: { usedPercent: 100, resetsAt: NOW + HOUR } },
    });
    expect(chooseAccount([out], { preferredModel: "Fable" })).toBeNull();
  });

  it("matches the model name case-insensitively and echoes the name as configured", () => {
    const out = account("out", {
      models: { Fable: { usedPercent: 100, resetsAt: NOW + HOUR } },
    });
    expect(chooseAccount([out], { preferredModel: "fable" })).toBeNull();
    expect(chooseAccount([out], { preferredModel: "opus" })).toEqual({
      account: "out",
      model: "opus",
    });
  });

  it("treats a missing model row as free (it counts against the weekly window)", () => {
    expect(
      chooseAccount([account("plain")], { preferredModel: "Opus" }),
    ).toEqual({
      account: "plain",
      model: "Opus",
    });
  });
});
