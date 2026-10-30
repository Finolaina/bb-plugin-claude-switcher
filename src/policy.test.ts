import { describe, expect, it } from "vitest";
import {
  canRunModel,
  chooseAccount,
  spendsNoWeekly,
  spendsReservedWeekly,
  type AccountUsage,
  type ChoiceOptions,
  type UsageWindow,
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
        {
          ...seat,
          models: {
            ...seat.models,
            Opus: { usedPercent: 3, resetsAt: NOW + HOUR },
          },
        },
        "Opus",
      ),
    ).toBe(false);
    expect(
      spendsNoWeekly(
        {
          ...seat,
          models: { ...seat.models, Opus: { usedPercent: 0, resetsAt: null } },
        },
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

  it("for the preferred model, a Team seat and a Max account are still ordered by deadline (the seat preference is for other models)", () => {
    const seat = (fableResetsAt: number) =>
      account("team", {
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        models: { Fable: { usedPercent: 40, resetsAt: fableResetsAt } },
      });
    const max = account("max", {
      weekly: { usedPercent: 50, resetsAt: NOW + 48 * HOUR },
      models: { Fable: { usedPercent: 40, resetsAt: NOW + 48 * HOUR } },
    });
    const options = { preferredModel: "Fable", reserveModel: "Fable" };
    expect(chooseAccount([seat(NOW + 72 * HOUR), max], options)?.account).toBe(
      "max",
    );
    expect(chooseAccount([seat(NOW + 24 * HOUR), max], options)?.account).toBe(
      "team",
    );
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

  // 2026-10-13 ("the Max accounts are Fable's"): on a Max account the
  // general weekly window and Fable's reset together, so an Opus turn there
  // spends what Fable needs. Such an account is not a candidate for another
  // model at all, not even as the last resort: the turn waits or stays.
  describe("for another model, an account that keeps the reserved model AND has a weekly window is never chosen", () => {
    const maxWithFable = account("maxWithFable", {
      weekly: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
      models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
    });
    const options = { preferredModel: "Opus", reserveModel: "Fable" };

    it("not even when it is the only usable account", () => {
      expect(chooseAccount([maxWithFable], options)).toBeNull();
    });

    it("nor when it has no window of the reserved model (it then counts against the weekly)", () => {
      expect(
        chooseAccount([account("maxNoRow", { models: {} })], options),
      ).toBeNull();
    });

    it("while a Team seat that keeps the reserved model is, with or without a window of the other model", () => {
      const seat = account("team1", {
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
      });
      expect(chooseAccount([maxWithFable, seat], options)?.account).toBe(
        "team1",
      );
      const seatWithOpus = account("team2", {
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        models: {
          Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR },
          Opus: { usedPercent: 5, resetsAt: NOW + 72 * HOUR },
        },
      });
      expect(
        chooseAccount([maxWithFable, seatWithOpus], options)?.account,
      ).toBe("team2");
    });

    it("and a Max account out of the reserved model is", () => {
      const out = account("viaulab", {
        weekly: { usedPercent: 91, resetsAt: NOW + 60 * HOUR },
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
      });
      expect(chooseAccount([maxWithFable, out], options)?.account).toBe(
        "viaulab",
      );
    });

    it("but nothing changes without a reserve, or for the reserved model itself", () => {
      expect(
        chooseAccount([maxWithFable], { preferredModel: "Opus" })?.account,
      ).toBe("maxWithFable");
      expect(
        chooseAccount([maxWithFable], { preferredModel: "Fable", reserveModel: "Fable" })?.account,
      ).toBe("maxWithFable");
    });

    it("spendsReservedWeekly says which accounts the rule excludes", () => {
      expect(spendsReservedWeekly(maxWithFable, options)).toBe(true);
      expect(spendsReservedWeekly(account("maxNoRow"), options)).toBe(true);
      expect(
        spendsReservedWeekly(
          account("team1", {
            weekly: { usedPercent: 0, resetsAt: null, absent: true },
            models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
          }),
          options,
        ),
      ).toBe(false);
      expect(
        spendsReservedWeekly(
          account("viaulab", {
            models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
          }),
          options,
        ),
      ).toBe(false);
      expect(spendsReservedWeekly(maxWithFable, { preferredModel: "Opus" })).toBe(false);
      expect(
        spendsReservedWeekly(maxWithFable, { preferredModel: "Fable", reserveModel: "Fable" }),
      ).toBe(false);
    });
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

// Session quarters (0.2.19). Measured 9-16 Oct 2026: ordering by deadline
// alone sent every new session to one account until its 5-hour window
// burned (52 h a week with one account at >= 80 % session while another
// with the preferred model sat under 20 %; 7 h with the preferred model
// left but its account's session at 100 %). The session now goes first in
// quarters (0-24, 25-49, 50-74, 75-99); within a quarter what runs out
// first is still spent first. For another model the reserve keys stay in
// front ("the Max accounts are the preferred model's"). The scenario names
// (S1...) are shared with the author's shell switcher's suite, which must
// choose the same account for the same input.
describe("session quarter before the deadline (S1-S7, S12)", () => {
  const seat = (
    name: string,
    session: number,
    fable: number,
    fableResetHours: number,
    extra: Record<string, UsageWindow> = {},
  ) =>
    account(name, {
      session: { usedPercent: session, resetsAt: NOW + 4 * HOUR },
      weekly: { usedPercent: 0, resetsAt: null, absent: true },
      models: {
        Fable: { usedPercent: fable, resetsAt: NOW + fableResetHours * HOUR },
        ...extra,
      },
    });
  const max = (
    name: string,
    session: number,
    weekly: number,
    weeklyResetHours: number,
    fable: number,
  ) =>
    account(name, {
      session: { usedPercent: session, resetsAt: NOW + 4 * HOUR },
      weekly: { usedPercent: weekly, resetsAt: NOW + weeklyResetHours * HOUR },
      models: {
        Fable: { usedPercent: fable, resetsAt: NOW + weeklyResetHours * HOUR },
      },
    });
  const fable = { preferredModel: "Fable", reserveModel: "Fable" };
  const opus = { preferredModel: "Opus", reserveModel: "Fable" };
  const pick = (accounts: AccountUsage[], options: ChoiceOptions) =>
    chooseAccount(accounts, options)?.account ?? null;

  it("S1: for the preferred model, a seat at 7 % session beats one at 82 % (quarter 0 before 3)", () => {
    expect(
      pick([seat("team-a", 82, 35, 61), seat("team-b", 7, 23, 56)], fable),
    ).toBe("team-b");
  });

  it("S2: for the preferred model, a lower quarter beats a closer deadline", () => {
    // team-a's Fable resets 5 h sooner: by deadline alone it would win
    expect(
      pick([seat("team-a", 30, 23, 56), seat("team-b", 10, 35, 61)], fable),
    ).toBe("team-b");
  });

  it("S3: within a quarter the closest deadline still wins over a lower session", () => {
    expect(
      pick([seat("team-a", 5, 10, 144), seat("team-b", 10, 60, 2)], fable),
    ).toBe("team-b");
  });

  it("S4: 24 % and 25 % fall in different quarters, two sessions in one quarter are ordered by deadline", () => {
    expect(
      pick([seat("team-a", 25, 40, 144), seat("team-b", 24, 40, 2)], fable),
    ).toBe("team-b");
    // the exact cuts: one point under a cut beats the cut even when the
    // cut resets sooner
    for (const cut of [25, 50, 75]) {
      expect(
        pick(
          [seat("team-a", cut, 40, 2), seat("team-b", cut - 1, 40, 144)],
          fable,
        ),
      ).toBe("team-b");
    }
    expect(
      pick([seat("team-a", 25, 40, 144), seat("team-b", 25, 40, 2)], fable),
    ).toBe("team-b");
  });

  it("S5: for another model, a Max account out of the preferred model still goes first by its deadline", () => {
    expect(
      pick(
        [
          max("max-a", 0, 60, 24, 100),
          seat("team-b", 0, 100, 80),
          seat("team-c", 7, 23, 56),
        ],
        opus,
      ),
    ).toBe("max-a");
  });

  it("S6: for another model, between seats out of the preferred model the lower quarter beats a closer deadline", () => {
    const opusWindow = (hours: number) => ({
      Opus: { usedPercent: 5, resetsAt: NOW + hours * HOUR },
    });
    expect(
      pick(
        [
          seat("team-a", 90, 100, 80, opusWindow(10)),
          seat("team-b", 10, 100, 80, opusWindow(100)),
        ],
        opus,
      ),
    ).toBe("team-b");
  });

  it("S7: for another model, a Max account that keeps the preferred model is still never chosen", () => {
    expect(pick([max("max-a", 0, 20, 24, 20)], opus)).toBeNull();
  });

  it("S12: for another model, a seat at 0 % beats a Max account out of the preferred model at 30 % whose weekly resets in 1 h; at 10 % the Max wins", () => {
    expect(
      pick([max("max-a", 30, 60, 1, 100), seat("team-b", 0, 100, 80)], opus),
    ).toBe("team-b");
    expect(
      pick([max("max-a", 10, 60, 1, 100), seat("team-b", 0, 100, 80)], opus),
    ).toBe("max-a");
  });
});

describe("chooseAccount with seats", () => {
  it("leaves out the accounts with no free seat, in the same quota order among the rest", () => {
    const accounts = [
      account("full", { weekly: { usedPercent: 90, resetsAt: NOW + 6 * HOUR } }),
      account("second", { weekly: { usedPercent: 50, resetsAt: NOW + 24 * HOUR } }),
      account("third", { weekly: { usedPercent: 10, resetsAt: NOW + 72 * HOUR } }),
    ];
    const free: Record<string, number> = { full: 0, second: 1, third: 3 };
    expect(chooseAccount(accounts, { preferredModel: "" })?.account).toBe("full");
    expect(
      chooseAccount(accounts, {
        preferredModel: "",
        freeSeats: (name) => free[name] ?? 0,
      })?.account,
    ).toBe("second");
    expect(
      chooseAccount(accounts, { preferredModel: "", freeSeats: () => 0 }),
    ).toBeNull();
  });
});

describe("chooseAccount for background work (SPEC 2026-10-30 §2)", () => {
  const soon = account("soon", { weekly: { usedPercent: 60, resetsAt: NOW + 6 * HOUR } });
  const late = account("late", { weekly: { usedPercent: 10, resetsAt: NOW + 90 * HOUR } });
  const saved = (name: string) => name === "soon";

  it("puts the accounts saved for the user behind every other usable one", () => {
    expect(chooseAccount([soon, late], { preferredModel: "" })?.account).toBe("soon");
    expect(
      chooseAccount([soon, late], { preferredModel: "", savedForUser: saved })?.account,
    ).toBe("late");
  });

  it("still chooses a saved account when it is the only one: never work left without one", () => {
    expect(
      chooseAccount([soon, account("out", { weekly: { usedPercent: 100, resetsAt: NOW + HOUR } })], {
        preferredModel: "",
        savedForUser: saved,
      })?.account,
    ).toBe("soon");
  });

  it("takes an account without a session (Ultra) as one at 0 % of it", () => {
    const ultra = account("ultra", {
      session: { usedPercent: 0, resetsAt: null, absent: true },
      weekly: { usedPercent: 60, resetsAt: NOW + 6 * HOUR },
    });
    const busy = account("busy", {
      session: { usedPercent: 30, resetsAt: NOW + HOUR },
      weekly: { usedPercent: 60, resetsAt: NOW + 5 * HOUR },
    });
    expect(chooseAccount([busy, ultra], { preferredModel: "" })?.account).toBe("ultra");
  });
});
