import { describe, expect, it } from "vitest";
import {
  canRunModel,
  chooseAccount,
  spendsNoWeekly,
  type AccountUsage,
} from "./policy.js";

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

describe("spendsNoWeekly", () => {
  it("is true only for an absent weekly with no window of the model", () => {
    const seat = account("team1", {
      weekly: { usedPercent: 0, resetsAt: null, absent: true },
      models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
    });
    expect(spendsNoWeekly(seat, "Opus")).toBe(true);
    expect(spendsNoWeekly(seat, "Fable")).toBe(false);
    // a window of the model that exists counts as spent, reset or not
    expect(
      spendsNoWeekly(
        { ...seat, models: { ...seat.models, Opus: { usedPercent: 3, resetsAt: NOW + HOUR } } },
        "Opus",
      ),
    ).toBe(false);
    expect(
      spendsNoWeekly(
        { ...seat, models: { ...seat.models, Opus: { usedPercent: 0, resetsAt: null } } },
        "Opus",
      ),
    ).toBe(false);
  });

  it("is false for a Max account, also when its weekly just expired and was settled to 0 % with no reset", () => {
    expect(spendsNoWeekly(account("max"), "Opus")).toBe(false);
    // Astra R0216-004 (2026-10-12): settle() turns an expired weekly into
    // { usedPercent: 0, resetsAt: null }; that is empty, not absent.
    expect(
      spendsNoWeekly(
        account("maxExpired", { weekly: { usedPercent: 0, resetsAt: null } }),
        "Opus",
      ),
    ).toBe(false);
  });
});

describe("canRunModel", () => {
  it('with no preferred model, ignores every model row, even one the provider named ""', () => {
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
    expect(chooseAccount([b, a], { preferredModel: "" })?.account).toBe(
      "alpha",
    );
    expect(chooseAccount([a, b], { preferredModel: "" })?.account).toBe(
      "alpha",
    );
  });

  // Measured 2026-10-11: a Team seat has no general weekly window (0 %, no
  // reset) and a Fable window with its own reset; five seats reset on
  // different days. The window that binds the turn is the one whose reset
  // orders the choice: what runs out first is spent first.
  it("ranks a Team seat by its preferred-model reset when it has no weekly reset", () => {
    const seat = (name: string, fableResetHours: number) =>
      account(name, {
        session: { usedPercent: 0, resetsAt: null },
        weekly: { usedPercent: 0, resetsAt: null },
        models: {
          Fable: { usedPercent: 2, resetsAt: NOW + fableResetHours * HOUR },
        },
      });
    // alphabetical order runs against the resets so the name cannot decide by luck
    const chosen = chooseAccount(
      [seat("team2", 96), seat("team3", 72), seat("team5", 24)],
      { preferredModel: "Fable" },
    );
    expect(chosen?.account).toBe("team5");
  });

  it("orders by the earliest of the weekly and the preferred-model resets", () => {
    const chosen = chooseAccount(
      [
        account("weeklySoon", {
          weekly: { usedPercent: 10, resetsAt: NOW + 48 * HOUR },
          models: { Fable: { usedPercent: 10, resetsAt: NOW + 60 * HOUR } },
        }),
        account("fableSoon", {
          weekly: { usedPercent: 10, resetsAt: NOW + 72 * HOUR },
          models: { Fable: { usedPercent: 10, resetsAt: NOW + 24 * HOUR } },
        }),
      ],
      { preferredModel: "Fable" },
    );
    expect(chosen?.account).toBe("fableSoon");
  });

  it("ignores the model reset when choosing for another model", () => {
    const chosen = chooseAccount(
      [
        account("fableSoon", {
          weekly: { usedPercent: 10, resetsAt: NOW + 72 * HOUR },
          models: { Fable: { usedPercent: 10, resetsAt: NOW + 24 * HOUR } },
        }),
        account("weeklySoon", {
          weekly: { usedPercent: 10, resetsAt: NOW + 48 * HOUR },
          models: { Fable: { usedPercent: 10, resetsAt: NOW + 60 * HOUR } },
        }),
      ],
      { preferredModel: "Opus" },
    );
    expect(chosen?.account).toBe("weeklySoon");
  });

  // A thread sent with Opus should not burn the Fable of an account that
  // still has it: accounts measured out of the reserved model come first.
  it("for another model, prefers accounts that can no longer run the reserved model", () => {
    const chosen = chooseAccount(
      [
        // its weekly resets sooner, so without the reserve it would win
        account("maxWithFable", {
          weekly: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
          models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
        }),
        account("viaulab", {
          weekly: { usedPercent: 91, resetsAt: NOW + 60 * HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen).toEqual({ account: "viaulab", model: "Opus" });
  });

  // Measured 2026-10-11: a Team seat has no general weekly window at all,
  // so a turn with another model there spends only its 5-hour session; on a
  // Max account it spends the weekly window Fable needs. Among the accounts
  // that keep the reserved model, the seats that spend no weekly go first.
  it("for another model, a Team seat (no weekly at all, no window of that model) ranks before a Max account that keeps the reserved model", () => {
    const chosen = chooseAccount(
      [
        // its weekly resets soonest: without the rule it wins by deadline
        account("maxWithFable", {
          weekly: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
          models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
        }),
        account("team1", {
          session: { usedPercent: 17, resetsAt: NOW + 4 * HOUR },
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen).toEqual({ account: "team1", model: "Opus" });
  });

  it("for another model, an account out of the reserved model still comes before a Team seat", () => {
    const chosen = chooseAccount(
      [
        account("team1", {
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
        }),
        // its weekly resets LATER than the seat's Fable: only the reserve puts it first
        account("viaulab", {
          weekly: { usedPercent: 91, resetsAt: NOW + 96 * HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 96 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen?.account).toBe("viaulab");
  });

  it("for another model, a Team seat out of the reserved model comes before a Team seat that keeps it", () => {
    // neither has a deadline for Opus and the seat that keeps Fable has the
    // emptier session: only the reserve puts the other one first
    const chosen = chooseAccount(
      [
        account("teamFable", {
          session: { usedPercent: 10, resetsAt: NOW + 4 * HOUR },
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
        }),
        account("teamNoFable", {
          session: { usedPercent: 60, resetsAt: NOW + 4 * HOUR },
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 72 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen?.account).toBe("teamNoFable");
  });

  // Decision 4 (2026-10-12): the seat preference only orders the accounts
  // that keep the reserve. Among those already out of it, what runs out
  // first is still spent first, Team seat or not.
  it("for another model, among accounts out of the reserved model a Team seat does not jump the queue", () => {
    const chosen = chooseAccount(
      [
        account("teamNoFable", {
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 72 * HOUR } },
        }),
        account("maxNoFable", {
          weekly: { usedPercent: 50, resetsAt: NOW + HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen?.account).toBe("maxNoFable");
  });

  it("for another model, among Team seats the emptiest session goes first, then the name", () => {
    const seat = (name: string, session: number) =>
      account(name, {
        session: { usedPercent: session, resetsAt: NOW + 4 * HOUR },
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        models: { Fable: { usedPercent: 40, resetsAt: NOW + 72 * HOUR } },
      });
    expect(
      chooseAccount([seat("team5", 52), seat("team1", 17), seat("team3", 26)], {
        preferredModel: "Opus",
        reserveModel: "Fable",
      })?.account,
    ).toBe("team1");
    expect(
      chooseAccount([seat("team5", 17), seat("team3", 17)], {
        preferredModel: "Opus",
        reserveModel: "Fable",
      })?.account,
    ).toBe("team3");
  });

  it("reserves nothing when choosing for the reserved model itself", () => {
    const chosen = chooseAccount(
      [
        account("hasFable", {
          weekly: { usedPercent: 0, resetsAt: NOW + 24 * HOUR },
          models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
        }),
        account("noFable", {
          weekly: { usedPercent: 0, resetsAt: NOW + 24 * HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 24 * HOUR } },
        }),
      ],
      { preferredModel: "Fable", reserveModel: "Fable" },
    );
    expect(chosen?.account).toBe("hasFable");
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
