// 0.2.55, Aitor 2026-11-19: «La Team que va a perder cuota en su reinicio
// recibe los hilos antes, desde unos 2 días antes». The case read in
// production on 2026-11-19 at 08:41, with names made up: five Team seats
// with free seats; A loses 43 points of weekly in 3 h 19 min.
import { describe, expect, it } from "vitest";
import {
  chooseAccount,
  teamLosesWeekly,
  type AccountUsage,
  type ChoiceOptions,
} from "./policy.js";

const MIN = 60 * 1_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-19T08:41:00.000Z");

function seat(
  name: string,
  session: number,
  weekly: number,
  resetsIn: number | null,
  more: Partial<AccountUsage> = {},
): AccountUsage {
  return {
    name,
    blocked: false,
    team: true,
    session: { usedPercent: session, resetsAt: NOW + 2 * HOUR },
    weekly: {
      usedPercent: weekly,
      resetsAt: resetsIn === null ? null : NOW + resetsIn,
    },
    models: {},
    ...more,
  };
}

const teams19 = () => [
  seat("tA", 60, 57, 3 * HOUR + 19 * MIN),
  seat("tB", 2, 18, 4 * DAY + 8 * HOUR),
  seat("tC", 0, 13, 5 * DAY + 1 * HOUR),
  seat("tD", 8, 45, 4 * DAY + 8 * HOUR),
  seat("tE", 0, 0, 6 * DAY + 22 * HOUR),
];

const opus = (more: Partial<ChoiceOptions> = {}): ChoiceOptions => ({
  preferredModel: "Opus",
  reserveModel: "Fable",
  reserveShare: 0.5,
  freeSeats: () => 3,
  now: NOW,
  ...more,
});

describe("a Team seat that would lose weekly at its reset ranks first among the Team seats (0.2.55)", () => {
  it("the 2026-11-19 case: an Opus turn goes to A, which loses 43 points at its reset, not to B", () => {
    expect(chooseAccount(teams19(), opus())?.account).toBe("tA");
  });

  it("without the clock the order is the one before 0.2.55: B", () => {
    expect(chooseAccount(teams19(), opus({ now: undefined }))?.account).toBe(
      "tB",
    );
  });
});

describe("teamLosesWeekly: the cut", () => {
  // 43 points left: 43 / 10 × 5 h × 1.5 = 32.25 h; 78 → 58.5 h; 15 → 11.25 h.
  const cases: [number, number][] = [
    [57, 32.25 * HOUR],
    [22, 58.5 * HOUR],
    [85, 11.25 * HOUR],
  ];
  it.each(cases)(
    "weekly at %d %%: in at exactly its hours, out 1 ms later",
    (used, hours) => {
      expect(teamLosesWeekly(seat("t", 0, used, hours), NOW)).toBe(true);
      expect(teamLosesWeekly(seat("t", 0, used, hours + 1), NOW)).toBe(false);
    },
  );

  it("a weekly at 100 % is out, at 99 % in with its 0.75 h", () => {
    expect(teamLosesWeekly(seat("t", 0, 100, 1 * MIN), NOW)).toBe(false);
    expect(teamLosesWeekly(seat("t", 0, 99, 0.75 * HOUR), NOW)).toBe(true);
  });

  it("a reset unknown is out", () => {
    expect(teamLosesWeekly(seat("t", 0, 57, null), NOW)).toBe(false);
  });

  it("a reset past (a stale read) or at this very instant is out", () => {
    expect(teamLosesWeekly(seat("t", 0, 57, -1 * MIN), NOW)).toBe(false);
    expect(teamLosesWeekly(seat("t", 0, 57, 0), NOW)).toBe(false);
    expect(teamLosesWeekly(seat("t", 0, 57, 1), NOW)).toBe(true);
  });

  it("a Max or Ultra account never is, whatever it would lose", () => {
    expect(
      teamLosesWeekly(seat("u", 0, 57, 1 * HOUR, { team: undefined }), NOW),
    ).toBe(false);
  });
});

describe("the step among the other rules", () => {
  it("a Max or Ultra about to reset does not jump ahead of a Team seat for Opus", () => {
    // An Ultra out of Fable until its weekly resets (0.2.47) comes after
    // every Team seat, also when it would lose much at its reset.
    const ultra = seat("u", 0, 10, 2 * HOUR, {
      team: undefined,
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 2 * HOUR } },
    });
    expect(chooseAccount([ultra, ...teams19().slice(1)], opus())?.account).toBe(
      "tB",
    );
  });

  it("the Team seat in the step with no free seat is not chosen: the next one is", () => {
    expect(
      chooseAccount(teams19(), opus({ freeSeats: (n) => (n === "tA" ? 0 : 3) }))
        ?.account,
    ).toBe("tB");
  });

  it("in the step the session quarter and the deadline still decide", () => {
    const both = [
      seat("t1", 60, 57, 3 * HOUR),
      seat("t2", 10, 57, 30 * HOUR),
      seat("t3", 10, 57, 20 * HOUR),
      seat("t4", 0, 10, 6 * DAY),
    ];
    expect(chooseAccount(both, opus())?.account).toBe("t3");
  });

  it("the step comes before the session quarter: A at 99 % of its session still wins", () => {
    const teams = teams19();
    teams[0] = seat("tA", 99, 57, 3 * HOUR + 19 * MIN);
    expect(chooseAccount(teams, opus())?.account).toBe("tA");
  });
});

describe("Fable and the step", () => {
  const ultra = (name: string, weekly: number, fable: number) => ({
    name,
    blocked: false,
    session: { usedPercent: 10, resetsAt: NOW + 2 * HOUR },
    weekly: { usedPercent: weekly, resetsAt: NOW + 3 * DAY },
    models: { Fable: { usedPercent: fable, resetsAt: NOW + 3 * DAY } },
  });
  const fable = (more: Partial<ChoiceOptions> = {}): ChoiceOptions =>
    opus({ preferredModel: "Fable", ...more });

  it("with an Ultra with room and a seat, Fable goes to the Ultra before the Team seat in the step", () => {
    expect(
      chooseAccount([...teams19(), ultra("u", 30, 30)], fable())?.account,
    ).toBe("u");
  });

  it("with no Ultra able, Fable goes to the Team seat in the step before the other Team seats", () => {
    expect(
      chooseAccount([...teams19(), ultra("u", 100, 30)], fable())?.account,
    ).toBe("tA");
    // Before 0.2.55 it went to the session most empty.
    expect(
      chooseAccount(
        [...teams19(), ultra("u", 100, 30)],
        fable({ now: undefined }),
      )?.account,
    ).toBe("tB");
  });
});
