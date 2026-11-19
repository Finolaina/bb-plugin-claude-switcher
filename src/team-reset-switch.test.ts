// 0.2.55: every path that chooses among the Team seats passes the clock, so
// the Team seat that would lose weekly at its reset (teamLosesWeekly) ranks
// first there too. The 2026-11-19 case, names made up.
import { describe, expect, it } from "vitest";
import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import type { AccountUsage } from "./policy.js";
import {
  bestAccount,
  decideAhead,
  decidePlacement,
  decideSwitch,
  placedOn,
  reserveWait,
  type PlacementInput,
} from "./switch.js";

const MIN = 60 * 1_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-19T08:41:00.000Z");

function seat(
  name: string,
  session: number,
  weekly: number,
  resetsIn: number,
): AccountUsage {
  return {
    name,
    blocked: false,
    team: true,
    session: { usedPercent: session, resetsAt: NOW + 2 * HOUR },
    weekly: { usedPercent: weekly, resetsAt: NOW + resetsIn },
    models: {},
  };
}

const teams19 = () => [
  seat("tA", 60, 57, 3 * HOUR + 19 * MIN),
  seat("tB", 2, 18, 4 * DAY + 8 * HOUR),
  seat("tC", 0, 13, 5 * DAY + 1 * HOUR),
  seat("tD", 8, 45, 4 * DAY + 8 * HOUR),
  seat("tE", 0, 0, 6 * DAY + 22 * HOUR),
];

// An Ultra that keeps Fable: an Opus turn there waits or moves.
const ultra: AccountUsage = {
  name: "ultra",
  blocked: false,
  session: { usedPercent: 5, resetsAt: NOW + 2 * HOUR },
  weekly: { usedPercent: 30, resetsAt: NOW + 3 * DAY },
  models: { Fable: { usedPercent: 30, resetsAt: NOW + 3 * DAY } },
};

const reserve = { reserveModel: "Fable", reserveShare: 0.5 };

const placement = (more: Partial<PlacementInput> = {}): PlacementInput => ({
  currentAccount: "ultra",
  isNew: false,
  accounts: [ultra, ...teams19()],
  preferredModel: "Opus",
  ...reserve,
  freeSeats: () => 3,
  now: NOW,
  ...more,
});

describe("the step on every path that chooses a Team seat (0.2.55)", () => {
  it("a new project", () => {
    expect(decidePlacement(placement({ isNew: true }))).toMatchObject({
      kind: "move",
      account: "tA",
    });
  });

  it("an Opus turn off an Ultra that keeps Fable", () => {
    expect(decidePlacement(placement())).toMatchObject({
      kind: "move",
      account: "tA",
    });
  });

  it("an Opus turn on a full Team seat (current-full)", () => {
    expect(
      decidePlacement(
        placement({
          currentAccount: "tE",
          seatsFull: true,
          freeSeats: (n) => (n === "tE" ? 0 : 3),
        }),
      ),
    ).toMatchObject({ kind: "move", account: "tA", why: "current-full" });
  });

  it("the account a placement names (placedOn)", () => {
    expect(placedOn(placement())).toBe("tA");
  });

  it("a switch after a failure", () => {
    expect(
      decideSwitch({
        failure: makeTurnFailedEvent({
          threadId: "t",
          requestId: "r",
          errorInfo: {
            category: "rate-limit",
            providerCode: "usage_limit_reached",
            httpStatusCode: 429,
          },
          rateLimits: {
            providerId: "claude-code",
            status: "blocked",
            kind: "subscription-window",
            windows: [
              {
                providerKey: "primary",
                label: "Current session",
                status: "blocked",
                resetsAtMs: NOW + 2 * HOUR,
              },
            ],
            reachedReason: "rate_limit_reached",
            overageStatus: null,
            overageReason: null,
          },
        }),
        currentAccount: "tE",
        accounts: [ultra, ...teams19()],
        preferredModel: "Opus",
        ...reserve,
        freeSeats: () => 3,
        maximumWaitMs: null,
        now: NOW,
        random: 0,
      }),
    ).toMatchObject({ kind: "switch", account: "tA" });
  });

  it("a move ahead of the limit", () => {
    expect(
      decideAhead({
        currentAccount: "tE",
        accounts: [ultra, ...teams19().slice(0, 4), seat("tE", 96, 0, 6 * DAY)],
        preferredModel: "Opus",
        ...reserve,
        threshold: 95,
        freeSeats: () => 3,
        now: NOW,
      }),
    ).toMatchObject({ kind: "move", account: "tA" });
  });

  it("the best account for the header", () => {
    expect(
      bestAccount(
        teams19(),
        "Opus",
        NOW,
        "Fable",
        () => 3,
        undefined,
        undefined,
        0.5,
      ),
    ).toBe("tA");
  });

  it("the wait for a seat: with every Team seat full, the one in the step is waited for", () => {
    // Named last, so the name alone would not pick it.
    const accounts = [
      ultra,
      ...teams19().slice(1),
      seat("tZ", 60, 57, 3 * HOUR + 19 * MIN),
    ];
    expect(reserveWait(placement({ accounts, freeSeats: () => 0 }))).toEqual({
      account: "tZ",
      at: 0,
    });
  });
});
