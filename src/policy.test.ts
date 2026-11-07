import { describe, expect, it } from "vitest";
import {
  canRunModel,
  chooseAccount,
  opusRoom,
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
  it("a Team seat that reports a weekly and no window of the model goes first, as one that reports none", () => {
    const seat = (name: string, session: number, models: AccountUsage["models"]) =>
      account(name, { session: { usedPercent: session, resetsAt: NOW + 2 * HOUR }, models, team: true });
    expect(
      chooseAccount(
        [seat("withOpus", 0, { Opus: { usedPercent: 5, resetsAt: null }, Fable: { usedPercent: 5, resetsAt: null } }), seat("noOpus", 60, { Fable: { usedPercent: 5, resetsAt: null } })],
        { preferredModel: "Opus", reserveModel: "Fable" },
      )?.account,
    ).toBe("noOpus");
  });

  it("is true only for an absent weekly with no window of the model", () => {
    const seat = account("team1", {
      weekly: { usedPercent: 0, resetsAt: null, absent: true },
      team: true,
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

  // Until 2026-11-06 a Max account out of Fable took Opus first; since
  // («los Opus tienen que salir por Team sí o sí») no Max or Ultra does,
  // but one out of Fable until its weekly resets (Aitor 2026-11-06 later:
  // «si fable llega al 100 se abre opus en esa cuenta»).
  it("for another model, a Max account out of the reserved model is chosen only when its weekly resets with Fable (2026-11-06)", () => {
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
    expect(chosen?.account).toBe("viaulab");
    const later = chooseAccount(
      [
        account("viaulab", {
          weekly: { usedPercent: 91, resetsAt: NOW + 72 * HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(later).toBeNull();
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
          team: true,
          models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen).toEqual({ account: "team1", model: "Opus" });
  });

  it("for another model, a Team seat comes before a Max account out of the reserved model, which is never chosen (2026-11-06)", () => {
    const chosen = chooseAccount(
      [
        account("team1", {
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          team: true,
          models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
        }),
        account("viaulab", {
          weekly: { usedPercent: 91, resetsAt: NOW + 96 * HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 96 * HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen?.account).toBe("team1");
  });

  it("for another model, a Team seat out of the reserved model comes before a Team seat that keeps it", () => {
    // neither has a deadline for Opus and the seat that keeps Fable has the
    // emptier session: only the reserve puts the other one first
    const chosen = chooseAccount(
      [
        account("teamFable", {
          session: { usedPercent: 10, resetsAt: NOW + 4 * HOUR },
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          team: true,
          models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
        }),
        account("teamNoFable", {
          session: { usedPercent: 60, resetsAt: NOW + 4 * HOUR },
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          team: true,
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
        team: true,
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

  // Decision 4 (2026-10-12) let a Max account out of the reserve compete
  // with the seats by deadline; since 2026-11-06 only the seat is a target.
  it("for another model, a Team seat out of the reserved model goes, not the Max out of it whose weekly resets sooner (2026-11-06)", () => {
    const chosen = chooseAccount(
      [
        account("teamNoFable", {
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          team: true,
          models: { Fable: { usedPercent: 100, resetsAt: NOW + 72 * HOUR } },
        }),
        account("maxNoFable", {
          weekly: { usedPercent: 50, resetsAt: NOW + HOUR },
          models: { Fable: { usedPercent: 100, resetsAt: NOW + HOUR } },
        }),
      ],
      { preferredModel: "Opus", reserveModel: "Fable" },
    );
    expect(chosen?.account).toBe("teamNoFable");
  });

  it("for another model, among Team seats the emptiest session goes first, then the name", () => {
    const seat = (name: string, session: number) =>
      account(name, {
        session: { usedPercent: session, resetsAt: NOW + 4 * HOUR },
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        team: true,
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
        team: true,
        models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
      });
      expect(chooseAccount([maxWithFable, seat], options)?.account).toBe(
        "team1",
      );
      const seatWithOpus = account("team2", {
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        team: true,
        models: {
          Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR },
          Opus: { usedPercent: 5, resetsAt: NOW + 72 * HOUR },
        },
      });
      expect(
        chooseAccount([maxWithFable, seatWithOpus], options)?.account,
      ).toBe("team2");
    });

    it("nor a Max account out of the reserved model whose weekly outlives Fable's window (2026-11-06, «sí o sí»)", () => {
      const out = account("viaulab", {
        weekly: { usedPercent: 91, resetsAt: NOW + 72 * HOUR },
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
      });
      expect(chooseAccount([maxWithFable, out], options)).toBeNull();
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
            team: true,
            models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
          }),
          options,
        ),
      ).toBe(false);
      expect(
        spendsReservedWeekly(
          account("viaulab", {
            weekly: { usedPercent: 50, resetsAt: NOW + 72 * HOUR },
            models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
          }),
          options,
        ),
      ).toBe(true);
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
      team: true,
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

  it("S5: for another model, a Max account out of the preferred model is not chosen: the seat out of it goes first (2026-11-06)", () => {
    expect(
      pick(
        [
          max("max-a", 0, 60, 24, 100),
          seat("team-b", 0, 100, 80),
          seat("team-c", 7, 23, 56),
        ],
        opus,
      ),
    ).toBe("team-b");
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

  it("S12: for another model, a seat beats a Max account out of the preferred model whatever its session (2026-11-06; before, at 10 % the Max won)", () => {
    expect(
      pick([max("max-a", 30, 60, 1, 100), seat("team-b", 0, 100, 80)], opus),
    ).toBe("team-b");
    expect(
      pick([max("max-a", 10, 60, 1, 100), seat("team-b", 0, 100, 80)], opus),
    ).toBe("team-b");
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

// Aitor 2026-11-06 («los Opus tienen que salir por Team sí o sí»): a turn in
// Opus or Sonnet while Fable is reserved runs on a Team seat only. A Max or
// Ultra account is Fable's whatever its margin (`reserveSpareUpTo`, the
// 0.2.41 share, no longer counts for them) and whatever Fable has left there:
// with every Team seat full the turn waits. Haiku keeps the old rule.
describe("Opus solo por Team (2026-11-06)", () => {
  // "a-ultra" sorts before "team": the Team goes first by rule, not by name.
  const ultra = (weekly: number, fable: number) =>
    account("a-ultra", {
      weekly: { usedPercent: weekly, resetsAt: NOW + 48 * HOUR },
      models: { Fable: { usedPercent: fable, resetsAt: NOW + 48 * HOUR } },
    });
  const team = account("team", { team: true, models: { Fable: { usedPercent: 4, resetsAt: NOW + 48 * HOUR } } });
  const as = (model: string, upTo?: number): ChoiceOptions => ({
    preferredModel: model,
    reserveModel: "Fable",
    ...(upTo === undefined ? {} : { reserveSpareUpTo: upTo }),
  });
  const seats = (o: ChoiceOptions, free: Record<string, number>) => ({ ...o, freeSeats: (a: string) => free[a] ?? 0 });

  it("canario: Opus with every Team seat full is not placed on an Ultra that keeps Fable, with margin or idle", () => {
    for (const [weekly, fable] of [[0, 0], [50, 50], [20, 99], [99, 99]] as const) {
      expect(chooseAccount([ultra(weekly, fable), team], seats(as("Opus", 50), { "a-ultra": 6, team: 0 }))).toBeNull();
      expect(spendsReservedWeekly(ultra(weekly, fable), as("Opus", 50))).toBe(true);
    }
  });

  it("an account not known as a Team seat that reports no weekly (a Max login) is no target either (Codex r1 high 3)", () => {
    const noWeekly = account("a-max", {
      weekly: { usedPercent: 0, resetsAt: null, absent: true },
      models: { Fable: { usedPercent: 10, resetsAt: NOW + 48 * HOUR } },
    });
    expect(spendsReservedWeekly(noWeekly, as("Opus"))).toBe(true);
    expect(chooseAccount([noWeekly, team], seats(as("Opus"), { "a-max": 6, team: 0 }))).toBeNull();
    // Haiku keeps the rule before: no weekly, nothing of Fable's spent.
    expect(spendsReservedWeekly(noWeekly, as("Haiku"))).toBe(false);
  });

  // Aitor 2026-11-06 («si fable llega al 100 se abre opus en esa cuenta»):
  // with Fable spent until the weekly resets with it, what is left of the
  // weekly is lost at the reset; Opus may use it, behind the Team seats.
  describe("an Ultra out of Fable until its weekly resets (Aitor 2026-11-06)", () => {
    const spent = (weekly: number, fable: number, weeklyLater = 0, fableResets: number | null = NOW + 48 * HOUR) =>
      account("a-ultra", {
        weekly: { usedPercent: weekly, resetsAt: NOW + 48 * HOUR + weeklyLater },
        models: { Fable: { usedPercent: fable, resetsAt: fableResets } },
      });
    const MIN = 60 * 1_000;

    it("takes Opus and Sonnet with no Team seat free", () => {
      expect(spendsReservedWeekly(spent(20, 100), as("Opus"))).toBe(false);
      expect(chooseAccount([spent(20, 100), team], seats(as("Opus"), { "a-ultra": 6, team: 0 }))?.account).toBe("a-ultra");
      expect(chooseAccount([spent(20, 100), team], seats(as("Sonnet"), { "a-ultra": 6, team: 0 }))?.account).toBe("a-ultra");
    });

    it("comes after every Team seat with room, also one out of Fable", () => {
      const teamOutOfFable = account("team", { team: true, models: { Fable: { usedPercent: 100, resetsAt: NOW + 48 * HOUR } } });
      expect(chooseAccount([spent(20, 100), team], seats(as("Opus"), { "a-ultra": 6, team: 1 }))?.account).toBe("team");
      expect(chooseAccount([spent(20, 100), teamOutOfFable], seats(as("Opus"), { "a-ultra": 6, team: 1 }))?.account).toBe("team");
    });

    it("comes after a Team seat that reports an Opus window and a fuller session (Codex R047-002)", () => {
      const busyTeam = account("team", {
        team: true,
        session: { usedPercent: 60, resetsAt: NOW + 2 * HOUR },
        models: {
          Fable: { usedPercent: 10, resetsAt: NOW + 48 * HOUR },
          Opus: { usedPercent: 5, resetsAt: NOW + 48 * HOUR },
        },
      });
      const idle = account("a-ultra", {
        session: { usedPercent: 0, resetsAt: NOW + 2 * HOUR },
        weekly: { usedPercent: 20, resetsAt: NOW + 48 * HOUR },
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 48 * HOUR } },
      });
      expect(chooseAccount([idle, busyTeam], seats(as("Opus"), { "a-ultra": 6, team: 1 }))?.account).toBe("team");
    });

    it("comes after a Team seat saved for the user's own threads (Codex R047-R2-001)", () => {
      const saved = { ...seats(as("Opus"), { "a-ultra": 6, team: 1 }), savedForUser: (a: string) => a === "team" };
      expect(chooseAccount([spent(20, 100), team], saved)?.account).toBe("team");
    });

    it("Fable at 99 % keeps it Fable's", () => {
      expect(spendsReservedWeekly(spent(20, 99), as("Opus"))).toBe(true);
    });

    it("a weekly that resets more than 10 min after Fable's window is still Fable's when Fable comes back", () => {
      expect(spendsReservedWeekly(spent(20, 100, 10 * MIN), as("Opus"))).toBe(false);
      expect(spendsReservedWeekly(spent(20, 100, 10 * MIN + 1), as("Opus"))).toBe(true);
    });

    it("no reset known for Fable's window, or no weekly reported: kept", () => {
      expect(spendsReservedWeekly(spent(20, 100, 0, null), as("Opus"))).toBe(true);
      const noWeekly = account("a-max", {
        weekly: { usedPercent: 0, resetsAt: null, absent: true },
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 48 * HOUR } },
      });
      expect(spendsReservedWeekly(noWeekly, as("Opus"))).toBe(true);
    });

    it("Haiku keeps its order: an account out of Fable first, before a Team seat", () => {
      expect(chooseAccount([spent(20, 100), team], seats(as("Haiku", 50), { "a-ultra": 6, team: 1 }))?.account).toBe("a-ultra");
    });

    it("a weekly at 100 % takes nothing", () => {
      expect(chooseAccount([spent(100, 100), team], seats(as("Opus"), { "a-ultra": 6, team: 0 }))).toBeNull();
    });
  });

  it("Sonnet too", () => {
    expect(chooseAccount([ultra(0, 99), team], seats(as("Sonnet", 50), { "a-ultra": 6, team: 0 }))).toBeNull();
  });

  it("a Team seat with a free seat takes Opus", () => {
    expect(chooseAccount([ultra(0, 0), team], seats(as("Opus", 50), { "a-ultra": 6, team: 1 }))?.account).toBe("team");
  });

  it("Fable still runs on the Ultra", () => {
    expect(chooseAccount([ultra(30, 30)], as("Fable", 50))?.account).toBe("a-ultra");
    expect(spendsReservedWeekly(ultra(80, 80), as("Fable", 50))).toBe(false);
  });

  it("Haiku keeps the margin rule: an Ultra at the threshold spares the reserve, one point above does not", () => {
    expect(spendsReservedWeekly(ultra(50, 50), as("Haiku", 50))).toBe(false);
    expect(spendsReservedWeekly(ultra(51, 10), as("Haiku", 50))).toBe(true);
    expect(spendsReservedWeekly(ultra(0, 100), as("Haiku", 50))).toBe(false);
  });
});

// Aitor 2026-11-07: «la cuenta de viaulab, se sigue disparando el tema la
// cuenta semanal y fable se queda sin gastar». The general weekly an Ultra
// has left beyond what its own Fable still needs (PLAN §B1, reparto-fable).
describe("opusRoom: the general weekly left beyond what Fable needs (0.2.48)", () => {
  const ultra = (weekly: number, fable: number, more: Partial<AccountUsage> = {}) =>
    account("ultra", {
      weekly: { usedPercent: weekly, resetsAt: NOW + 48 * HOUR },
      models: { Fable: { usedPercent: fable, resetsAt: NOW + 48 * HOUR } },
      ...more,
    });

  it("(100 - weekly) - share * (100 - Fable): the plan's three measured accounts", () => {
    expect(opusRoom(ultra(86, 53), "Fable", 0.5)).toBeCloseTo(-9.5, 10);
    expect(opusRoom(ultra(100, 65), "Fable", 0.5)).toBeCloseTo(-17.5, 10);
    expect(opusRoom(ultra(10, 12), "Fable", 0.5)).toBeCloseTo(46, 10);
  });

  it("the share weighs Fable's room", () => {
    expect(opusRoom(ultra(10, 12), "Fable", 0)).toBeCloseTo(90, 10);
    expect(opusRoom(ultra(10, 12), "Fable", 1)).toBeCloseTo(2, 10);
  });

  it("the reserved model is matched case-insensitively", () => {
    expect(opusRoom(ultra(86, 53), "fable", 0.5)).toBeCloseTo(-9.5, 10);
  });

  it("null for a Team seat, an incomplete read, no weekly, no window of the reserved model or no reserved model", () => {
    expect(opusRoom(ultra(10, 12, { team: true }), "Fable", 0.5)).toBeNull();
    expect(opusRoom(ultra(10, 12, { unknown: true, blocked: true }), "Fable", 0.5)).toBeNull();
    expect(opusRoom(ultra(10, 12, { weekly: { usedPercent: 0, resetsAt: null, absent: true } }), "Fable", 0.5)).toBeNull();
    expect(opusRoom(ultra(10, 12, { models: {} }), "Fable", 0.5)).toBeNull();
    expect(opusRoom(ultra(10, 12), "", 0.5)).toBeNull();
  });
});

// PLAN §B2 (reparto-fable, 2026-11-07): Fable goes where the general weekly
// has the most room beyond what Fable still needs, in tiers of 10 points;
// within a tier the session quarter and the deadline decide as before. A
// Team seat comes last for Fable: the weekly it spends there is Opus's.
describe("the reserved model ranks by opusRoom (0.2.48, B2)", () => {
  // `resets` hours from now for both windows: the deadline.
  const ultra = (name: string, weekly: number, fable: number, resets = 48) =>
    account(name, {
      weekly: { usedPercent: weekly, resetsAt: NOW + resets * HOUR },
      models: { Fable: { usedPercent: fable, resetsAt: NOW + resets * HOUR } },
    });
  const fable = (more: Partial<ChoiceOptions> = {}): ChoiceOptions => ({
    preferredModel: "Fable",
    reserveModel: "Fable",
    reserveShare: 0.5,
    ...more,
  });

  it("the plan's case: viaulab -9.5, siloeads 46, mariscal 45.5 → siloeads (same tier as mariscal, earlier deadline)", () => {
    const accounts = [
      ultra("viaulab", 86, 53, 10),
      ultra("mariscal", 9, 9, 72),
      ultra("siloeads", 10, 12, 60),
    ];
    expect(chooseAccount(accounts, fable())?.account).toBe("siloeads");
    // Before 0.2.48 (no share): the earliest deadline, viaulab.
    expect(chooseAccount(accounts, fable({ reserveShare: undefined }))?.account).toBe("viaulab");
  });

  it("cut: room 9.9 and 10.0 are different tiers, 10.0 wins over an earlier deadline", () => {
    // (100 - 89.1) - 0.5 * 2 = 9.9; (100 - 89) - 0.5 * 2 = 10.
    expect(chooseAccount([ultra("a", 89.1, 98, 10), ultra("b", 89, 98, 60)], fable())?.account).toBe("b");
  });

  it("cut: room 10 and 19 are the same tier, the deadline decides", () => {
    expect(chooseAccount([ultra("a", 89, 98, 10), ultra("b", 80, 98, 60)], fable())?.account).toBe("a");
    expect(chooseAccount([ultra("a", 89, 98, 60), ultra("b", 80, 98, 10)], fable())?.account).toBe("b");
  });

  it("a Team seat goes last for Fable, also with a sooner deadline and an Ultra with negative room", () => {
    const team = account("team", {
      team: true,
      models: { Fable: { usedPercent: 10, resetsAt: NOW + 2 * HOUR } },
    });
    expect(chooseAccount([team, ultra("viaulab", 86, 53)], fable())?.account).toBe("viaulab");
    // The Team still takes Fable with no Ultra able to.
    expect(chooseAccount([team, ultra("viaulab", 100, 53)], fable())?.account).toBe("team");
  });

  it("the session quarter still comes after the tier", () => {
    const busy = account("busy", {
      session: { usedPercent: 80, resetsAt: NOW + 2 * HOUR },
      weekly: { usedPercent: 10, resetsAt: NOW + 48 * HOUR },
      models: { Fable: { usedPercent: 12, resetsAt: NOW + 48 * HOUR } },
    });
    expect(chooseAccount([busy, ultra("idle", 60, 60)], fable())?.account).toBe("busy");
  });

  it("an account with no room known (no Fable window) ranks as room 0-9.9", () => {
    const blank = account("blank", { weekly: { usedPercent: 50, resetsAt: NOW + 10 * HOUR }, models: {} });
    // room 8: same tier, blank's deadline is sooner; room 10: the next tier.
    expect(chooseAccount([blank, ultra("z", 91, 98, 60)], fable())?.account).toBe("blank");
    expect(chooseAccount([blank, ultra("z", 89, 98, 60)], fable())?.account).toBe("z");
  });

  it("Opus among the Ultras out of Fable (0.2.47): the most room first", () => {
    const spent = (name: string, weekly: number, resets: number) => ultra(name, weekly, 100, resets);
    const opus: ChoiceOptions = { preferredModel: "Opus", reserveModel: "Fable", reserveShare: 0.5 };
    expect(chooseAccount([spent("a", 80, 10), spent("b", 20, 10)], opus)?.account).toBe("b");
    // Haiku keeps its order: the deadline.
    expect(chooseAccount([spent("a", 80, 10), spent("b", 20, 60)], { ...opus, preferredModel: "Haiku" })?.account).toBe("a");
  });
});

// PLAN §B5 [SUPUESTO] (2026-11-07). Aitor: «los Opus tienen que salir por
// Team sí o sí» (11-06) is the order, Team always first; «tampoco quiero que
// hilos se queden parados … el trabajo prima» (11-07): with no Team able to
// take it, Opus does not wait while an Ultra has general weekly Fable will
// not need; «Esperar siempre» (11-03) stays for the Ultras without such room.
describe("Opus with no Team able to take it: the Ultra with the most room (0.2.48, B5)", () => {
  const ultra = (name: string, weekly: number, fable: number, more: Partial<AccountUsage> = {}) =>
    account(name, {
      weekly: { usedPercent: weekly, resetsAt: NOW + 48 * HOUR },
      models: { Fable: { usedPercent: fable, resetsAt: NOW + 72 * HOUR } },
      ...more,
    });
  const team = account("team", { team: true, models: { Fable: { usedPercent: 4, resetsAt: NOW + 48 * HOUR } } });
  const opus = (more: Partial<ChoiceOptions> = {}): ChoiceOptions => ({
    preferredModel: "Opus",
    reserveModel: "Fable",
    reserveShare: 0.5,
    opusOverflowRoom: 15,
    noTeamTakes: () => true,
    freeSeats: (n) => (n === "team" ? 0 : 6),
    ...more,
  });

  it("every Team full: Ultra A at room 46 goes, not B at -9.5", () => {
    expect(chooseAccount([ultra("b", 86, 53), ultra("a", 10, 12), team], opus())?.account).toBe("a");
  });

  it("a Team seat with one seat goes first (no overflow while a Team takes it)", () => {
    const free = { freeSeats: (n: string) => (n === "team" ? 1 : 6) };
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ ...free, noTeamTakes: () => false }))?.account).toBe("team");
    // Even with the server's flag stale, the Team ranks first.
    expect(chooseAccount([ultra("a", 10, 12), team], opus(free))?.account).toBe("team");
    // Also a Team seat that reports an Opus window (it spends a weekly too: Codex R047-002).
    const opusTeam = account("team", {
      team: true,
      models: { Fable: { usedPercent: 4, resetsAt: NOW + 48 * HOUR }, Opus: { usedPercent: 5, resetsAt: NOW + 48 * HOUR } },
    });
    expect(chooseAccount([ultra("a", 10, 12), opusTeam], opus(free))?.account).toBe("team");
  });

  it("cut: room 14.9 waits, 15.0 enters", () => {
    // (100 - 80.1) - 0.5 * 10 = 14.9; (100 - 80) - 0.5 * 10 = 15.
    expect(chooseAccount([ultra("a", 80.1, 90), team], opus())).toBeNull();
    expect(chooseAccount([ultra("a", 80, 90), team], opus())?.account).toBe("a");
    expect(spendsReservedWeekly(ultra("a", 80.1, 90), opus())).toBe(true);
    expect(spendsReservedWeekly(ultra("a", 80, 90), opus())).toBe(false);
  });

  it("an Ultra not read whole never takes it", () => {
    expect(chooseAccount([ultra("a", 10, 12, { unknown: true }), team], opus())).toBeNull();
    expect(spendsReservedWeekly(ultra("a", 10, 12, { unknown: true }), opus())).toBe(true);
  });

  it("opusOverflowRoom 100 turns it off; unset, no share or no flag too", () => {
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ opusOverflowRoom: 100 }))).toBeNull();
    expect(chooseAccount([ultra("a", 0, 99), team], opus({ opusOverflowRoom: 100 }))).toBeNull();
    // Room 100: weekly 0, Fable 100 whose window resets a day before the weekly (not 0.2.47's case).
    const hundred = account("a", {
      weekly: { usedPercent: 0, resetsAt: NOW + 72 * HOUR },
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 48 * HOUR } },
    });
    expect(chooseAccount([hundred, team], opus({ opusOverflowRoom: 100 }))).toBeNull();
    expect(chooseAccount([hundred, team], opus({ opusOverflowRoom: 99.9 }))?.account).toBe("a");
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ opusOverflowRoom: undefined }))).toBeNull();
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ reserveShare: undefined }))).toBeNull();
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ noTeamTakes: () => false }))).toBeNull();
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ noTeamTakes: undefined }))).toBeNull();
  });

  it("the flag is asked for the turn's model", () => {
    const asked: string[] = [];
    chooseAccount([ultra("a", 10, 12), team], opus({ noTeamTakes: (m) => (asked.push(m), true) }));
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["Opus"]));
  });

  it("Sonnet too; Haiku and Fable keep their rules", () => {
    expect(chooseAccount([ultra("a", 10, 12), team], opus({ preferredModel: "Sonnet" }))?.account).toBe("a");
    // Room 20 ≥ 15, weekly 60 over Haiku's margin of 50: still Fable's for Haiku.
    expect(spendsReservedWeekly(ultra("a", 60, 60), opus({ preferredModel: "Haiku", reserveSpareUpTo: 50 }))).toBe(true);
    expect(spendsReservedWeekly(ultra("a", 10, 12), opus({ preferredModel: "Fable" }))).toBe(false);
  });

  it("a Team seat is never one: it spends nothing of Fable's anyway", () => {
    expect(spendsReservedWeekly(team, opus())).toBe(false);
  });
});
