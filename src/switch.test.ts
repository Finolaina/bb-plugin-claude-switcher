import { describe, expect, it } from "vitest";
import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { AccountUsage } from "./policy.js";
import {
  bestAccount,
  declineReason,
  decideAhead,
  decidePlacement,
  decideSwitch,
  modelFamily,
  opusInstead,
  opusInsteadText,
  settle,
  type SwitchInput,
} from "./switch.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
// Literal on purpose: the same values bb's provider-retry uses (15 s buffer,
// 30 s jitter, 5 attempts). Importing the constants would let them drift.
const BUFFER = 15_000;
const JITTER = 30_000;
const ATTEMPTS = 5;

function failure(
  overrides: Partial<PluginTurnFailedEvent> = {},
): PluginTurnFailedEvent {
  return makeTurnFailedEvent({
    threadId: "thread-1",
    requestId: "creq_1",
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
    ...overrides,
  });
}

function account(
  name: string,
  overrides: Partial<AccountUsage> = {},
): AccountUsage {
  return {
    name,
    blocked: false,
    session: { usedPercent: 10, resetsAt: NOW + HOUR },
    weekly: { usedPercent: 50, resetsAt: NOW + 3 * 24 * HOUR },
    models: {},
    ...overrides,
  };
}

function input(overrides: Partial<SwitchInput> = {}): SwitchInput {
  return {
    failure: failure(),
    currentAccount: "main",
    accounts: [
      account("main", {
        session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
      }),
      account("work"),
    ],
    preferredModel: "",
    maximumWaitMs: 6 * HOUR,
    now: NOW,
    random: 0,
    ...overrides,
  };
}

describe("settle", () => {
  it("keeps the absent mark of a Team seat's weekly and never adds one", () => {
    const seat = account("team1", {
      weekly: { usedPercent: 0, resetsAt: null, absent: true },
      models: { Fable: { usedPercent: 100, resetsAt: NOW - 1 } },
    });
    expect(settle(seat, NOW)).toEqual({
      ...seat,
      models: { Fable: { usedPercent: 0, resetsAt: null } },
    });
  });


  it("zeroes a window whose reset has passed and leaves the rest alone", () => {
    const stale = account("work", {
      session: { usedPercent: 100, resetsAt: NOW - 1 },
      weekly: { usedPercent: 100, resetsAt: NOW },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 1 },
        Opus: { usedPercent: 100, resetsAt: null },
      },
    });
    expect(settle(stale, NOW)).toEqual({
      ...stale,
      session: { usedPercent: 0, resetsAt: null },
      weekly: { usedPercent: 0, resetsAt: null },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 1 },
        Opus: { usedPercent: 100, resetsAt: null },
      },
    });
  });
});

describe("decideSwitch", () => {
  it("switches to another usable account and never to the one that just failed", () => {
    expect(decideSwitch(input())).toEqual({
      kind: "switch",
      account: "work",
      model: null,
    });
    const onlyFailed = input({
      accounts: [
        account("main", { session: { usedPercent: 10, resetsAt: NOW + HOUR } }),
      ],
    });
    // Our measurement says main is fine, but the provider just said it is
    // not: never chosen, and the wait honours the provider's reset.
    expect(decideSwitch(onlyFailed)).toEqual({
      kind: "wait",
      account: "main",
      sendAt: NOW + 2 * HOUR + BUFFER,
      reason: "Waiting for main",
    });
  });

  it("switches to an account whose exhausted window already reset, whatever the stale measurement says", () => {
    const accounts = [
      account("main", {
        session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
      }),
      account("work", { session: { usedPercent: 100, resetsAt: NOW - HOUR } }),
    ];
    expect(decideSwitch(input({ accounts }))).toEqual({
      kind: "switch",
      account: "work",
      model: null,
    });
  });

  it("honours the preferred model and reports which model the target can run", () => {
    const accounts = [
      account("main", { session: { usedPercent: 100, resetsAt: NOW + HOUR } }),
      account("work", {
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 4 * HOUR } },
      }),
      account("spare"),
    ];
    expect(decideSwitch(input({ accounts, preferredModel: "Fable" }))).toEqual({
      kind: "switch",
      account: "spare",
      model: "Fable",
    });
  });

  it("waits for the earliest reset of the preferred model when no account can run it now, naming that account", () => {
    const accounts = [
      account("main", {
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 5 * HOUR } },
      }),
      account("work", {
        models: { Fable: { usedPercent: 100, resetsAt: NOW + 3 * HOUR } },
      }),
    ];
    expect(decideSwitch(input({ accounts, preferredModel: "Fable" }))).toEqual({
      kind: "wait",
      account: "work",
      sendAt: NOW + 3 * HOUR + BUFFER,
      reason: "Waiting for Fable on work",
    });
    const jittered = decideSwitch(
      input({ accounts, preferredModel: "Fable", random: 0.999 }),
    );
    expect(jittered.kind).toBe("wait");
    if (jittered.kind !== "wait") return;
    expect(jittered.sendAt).toBeGreaterThan(NOW + 3 * HOUR + BUFFER);
    expect(jittered.sendAt).toBeLessThan(NOW + 3 * HOUR + BUFFER + JITTER);
  });

  it("under a warning report, waits on the failed account for the window that warned, not for the latest reset", () => {
    // bb's latest stored report when the provider refused the turn: the
    // session window warned, the weekly one did not and resets much later.
    const warned = failure();
    warned.rateLimits!.status = "warning";
    warned.rateLimits!.windows = [
      {
        providerKey: "five_hour",
        label: "Current session",
        status: "warning",
        resetsAtMs: NOW + 3 * HOUR,
      },
      {
        providerKey: "seven_day",
        label: "Weekly limit",
        status: "allowed",
        resetsAtMs: NOW + 26 * HOUR,
      },
    ];
    const accounts = [
      account("main"),
      account("work", {
        weekly: { usedPercent: 100, resetsAt: NOW + 20 * HOUR },
      }),
    ];
    expect(decideSwitch(input({ accounts, failure: warned }))).toEqual({
      kind: "wait",
      account: "main",
      sendAt: NOW + 3 * HOUR + BUFFER,
      reason: "Waiting for main",
    });
  });

  it("waits for another account's session or weekly reset, and never schedules in the past", () => {
    const accounts = [
      account("main", {
        session: { usedPercent: 100, resetsAt: NOW + 5 * HOUR },
      }),
      account("spare", { weekly: { usedPercent: 100, resetsAt: NOW + HOUR } }),
    ];
    expect(decideSwitch(input({ accounts, maximumWaitMs: null }))).toEqual({
      kind: "wait",
      account: "spare",
      sendAt: NOW + HOUR + BUFFER,
      reason: "Waiting for spare",
    });
    // The provider's report for the failed account is also in the past.
    const past = failure();
    past.rateLimits!.windows[0]!.resetsAtMs = NOW - HOUR;
    const stale = [
      account("main", { session: { usedPercent: 100, resetsAt: NOW - HOUR } }),
      account("work", {
        weekly: { usedPercent: 100, resetsAt: NOW + 20 * HOUR },
      }),
    ];
    expect(
      decideSwitch(
        input({ accounts: stale, maximumWaitMs: null, failure: past }),
      ),
    ).toEqual({
      kind: "wait",
      account: "main",
      sendAt: NOW + BUFFER,
      reason: "Waiting for main",
    });
  });

  it("on a tie between resets, waits on the current account first, then by name, whatever the order measured", () => {
    const exhausted = (name: string) =>
      account(name, {
        session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
      });
    const forward = decideSwitch(
      input({
        accounts: [exhausted("main"), exhausted("work"), exhausted("beta")],
      }),
    );
    const backward = decideSwitch(
      input({
        accounts: [exhausted("beta"), exhausted("work"), exhausted("main")],
      }),
    );
    expect(forward).toMatchObject({ kind: "wait", account: "main" });
    expect(backward).toEqual(forward);
    // The current account wins the tie even when another name sorts first
    // (zed is bound by the provider's report, +2 h: the same reset).
    const others = decideSwitch(
      input({
        currentAccount: "zed",
        accounts: [exhausted("work"), exhausted("beta"), exhausted("zed")],
      }),
    );
    expect(others).toMatchObject({ kind: "wait", account: "zed" });
    // Without the current account in the tie, the name decides.
    const noCurrent = decideSwitch(
      input({
        currentAccount: "gone",
        accounts: [exhausted("work"), exhausted("beta")],
      }),
    );
    expect(noCurrent).toMatchObject({ kind: "wait", account: "beta" });
  });

  it("waits for the LATEST blocked window the provider reports, ignoring allowed ones", () => {
    const two = failure();
    two.rateLimits!.windows = [
      {
        providerKey: "primary",
        label: "Session",
        status: "blocked",
        resetsAtMs: NOW + HOUR,
      },
      {
        providerKey: "secondary",
        label: "Weekly",
        status: "blocked",
        resetsAtMs: NOW + 4 * HOUR,
      },
      {
        providerKey: "other",
        label: "Other",
        status: "allowed",
        resetsAtMs: NOW + 9 * HOUR,
      },
    ];
    const accounts = [
      account("main", { session: { usedPercent: 100, resetsAt: NOW + HOUR } }),
    ];
    expect(decideSwitch(input({ accounts, failure: two }))).toEqual({
      kind: "wait",
      account: "main",
      sendAt: NOW + 4 * HOUR + BUFFER,
      reason: "Waiting for main",
    });
  });

  it("declines a wait beyond the maximum (exactly at it is fine), an unknown reset, or a locked account", () => {
    const far = [
      account("main", {
        session: { usedPercent: 100, resetsAt: NOW + 7 * HOUR },
      }),
    ];
    expect(decideSwitch(input({ accounts: far }))).toEqual({
      kind: "decline",
      reason: "beyond-maximum-wait",
    });
    expect(
      decideSwitch(input({ accounts: far, maximumWaitMs: 7 * HOUR })),
    ).toMatchObject({ kind: "wait" });
    expect(
      decideSwitch(input({ accounts: far, maximumWaitMs: 7 * HOUR - 1 })),
    ).toEqual({ kind: "decline", reason: "beyond-maximum-wait" });
    const unknown = [
      account("main", { session: { usedPercent: 100, resetsAt: null } }),
    ];
    expect(decideSwitch(input({ accounts: unknown }))).toEqual({
      kind: "decline",
      reason: "no-account-usable",
    });
    const locked = [
      account("main", {
        blocked: true,
        session: { usedPercent: 100, resetsAt: NOW + HOUR },
      }),
    ];
    expect(decideSwitch(input({ accounts: locked }))).toEqual({
      kind: "decline",
      reason: "no-account-usable",
    });
  });

  it("only acts on blocked subscription-window rate limits with attempts left", () => {
    const overloaded = failure({
      errorInfo: {
        category: "overloaded",
        providerCode: null,
        httpStatusCode: 529,
      },
    });
    expect(declineReason(overloaded)).toBe("not-rate-limit");
    expect(decideSwitch(input({ failure: overloaded }))).toEqual({
      kind: "decline",
      reason: "not-rate-limit",
    });
    expect(declineReason(failure({ rateLimits: null }))).toBe(
      "no-rate-limit-state",
    );
    // A limit the provider enforced while bb's latest report only warned is
    // judged; one with no limit reported is not.
    for (const [status, reason] of [
      ["warning", null],
      ["allowed", "no-rate-limit-state"],
      ["unknown", "no-rate-limit-state"],
    ] as const) {
      const report = failure();
      report.rateLimits!.status = status;
      expect(declineReason(report)).toBe(reason);
    }
    const spend = failure();
    spend.rateLimits!.kind = "spend-control";
    expect(declineReason(spend)).toBe("not-subscription-window");
    const codex = failure();
    codex.rateLimits!.providerId = "codex";
    expect(declineReason(codex)).toBe("not-claude-code");
    expect(decideSwitch(input({ failure: codex }))).toEqual({
      kind: "decline",
      reason: "not-claude-code",
    });
    expect(declineReason(failure({ attemptNumber: ATTEMPTS }))).toBe(
      "attempts-exhausted",
    );
    expect(declineReason(failure({ attemptNumber: ATTEMPTS - 1 }))).toBeNull();
    expect(declineReason(failure())).toBeNull();
  });
  it("applies the report's reset to the account the turn ran on, never chosen, not to the project's current account", () => {
    // The turn started on main before the project moved to work; its report
    // (main's session, 2 h) says nothing about work, measured out for 1 h.
    // main's own measurement says room: stale, the provider just said no.
    const moved = input({
      currentAccount: "work",
      failedAccount: "main",
      accounts: [
        account("main"),
        account("work", {
          session: { usedPercent: 100, resetsAt: NOW + HOUR },
        }),
      ],
    });
    expect(decideSwitch(moved)).toEqual({
      kind: "wait",
      account: "work",
      sendAt: NOW + HOUR + BUFFER,
      reason: "Waiting for work",
    });
    // Another account free: the move goes there, never back to main.
    expect(
      decideSwitch({
        ...moved,
        accounts: [...moved.accounts, account("spare")],
      }),
    ).toEqual({ kind: "switch", account: "spare", model: null });
    // The report's reset the earliest of all: the project waits there.
    expect(
      decideSwitch({
        ...moved,
        accounts: [
          account("main"),
          account("work", {
            session: { usedPercent: 100, resetsAt: NOW + 3 * HOUR },
          }),
        ],
      }),
    ).toEqual({
      kind: "wait",
      account: "main",
      sendAt: NOW + 2 * HOUR + BUFFER,
      reason: "Waiting for main",
    });
    // The current account usable (measured since the leftover was turned
    // away): waited for at once, not "switched" to.
    expect(
      decideSwitch({
        ...moved,
        accounts: [account("main"), account("work")],
      }),
    ).toEqual({
      kind: "wait",
      account: "work",
      sendAt: NOW + BUFFER,
      reason: "Waiting for work",
    });
    // The account the turn ran on unknown: the report (+2 h) is nobody's,
    // so work, measured out until +1 h, frees first (were the report
    // work's, main at +1.5 h would).
    expect(
      decideSwitch({
        ...moved,
        failedAccount: null,
        accounts: [
          account("main", {
            session: { usedPercent: 100, resetsAt: NOW + 1.5 * HOUR },
          }),
          account("work", {
            session: { usedPercent: 100, resetsAt: NOW + HOUR },
          }),
        ],
      }),
    ).toEqual({
      kind: "wait",
      account: "work",
      sendAt: NOW + HOUR + BUFFER,
      reason: "Waiting for work",
    });
    // Unknown and the current account measured with room: it runs again
    // there, no move to another account (code-reviewer r15).
    expect(
      decideSwitch({
        ...moved,
        failedAccount: null,
        accounts: [account("main"), account("work")],
      }),
    ).toEqual({ kind: "retry", account: "work", model: null });
  });
});

// 2026-10-13 ("the Max accounts are Fable's"): an Opus turn never spends the
// weekly of a Max account that keeps Fable, and never waits for one either:
// the wait only looks at the accounts the rule admits as the retry is sent.
describe("decideSwitch with a reserved model: a Max account that keeps it is no target and no wait", () => {
  const opus = (overrides: Partial<SwitchInput> = {}) =>
    input({ preferredModel: "Opus", reserveModel: "Fable", ...overrides });
  const failed = account("main", {
    session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
  });
  const maxWithFable = (overrides: Partial<AccountUsage> = {}) =>
    account("spare", {
      weekly: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
      models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
      ...overrides,
    });
  const seatOut = account("team1", {
    session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
    weekly: { usedPercent: 0, resetsAt: null, absent: true },
    models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
  });

  it("declines with its own reason when the only free account keeps the reserved model", () => {
    expect(decideSwitch(opus({ accounts: [failed, maxWithFable()] }))).toEqual({
      kind: "decline",
      reason: "reserved-for-preferred-model",
    });
  });

  it("waits for a Team seat's session rather than take the Max account that keeps the reserved model", () => {
    expect(
      decideSwitch(opus({ accounts: [failed, maxWithFable(), seatOut] })),
    ).toEqual({
      kind: "wait",
      account: "team1",
      sendAt: NOW + 2 * HOUR + BUFFER,
      reason: "Waiting for Opus on team1",
    });
  });

  it("does not wait for a Max account whose weekly and reserved window reset together: it keeps the reserve again as the retry is sent", () => {
    const together = maxWithFable({
      weekly: { usedPercent: 100, resetsAt: NOW + HOUR },
      models: { Fable: { usedPercent: 100, resetsAt: NOW + HOUR } },
    });
    expect(
      decideSwitch(opus({ accounts: [failed, together, seatOut] })),
    ).toMatchObject({ kind: "wait", account: "team1" });
    expect(decideSwitch(opus({ accounts: [failed, together] }))).toEqual({
      kind: "decline",
      reason: "reserved-for-preferred-model",
    });
  });

  it("does wait for a Max account out of the reserved model that is only blocked by its session", () => {
    const outOfFable = maxWithFable({
      session: { usedPercent: 100, resetsAt: NOW + HOUR },
      weekly: { usedPercent: 50, resetsAt: NOW + 60 * HOUR },
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
    });
    expect(
      decideSwitch(opus({ accounts: [failed, outOfFable, seatOut] })),
    ).toEqual({
      kind: "wait",
      account: "spare",
      sendAt: NOW + HOUR + BUFFER,
      reason: "Waiting for Opus on spare",
    });
  });

  it("projects from now, not from a reset already past: the failed account whose reserved window returns within the buffer is no wait", () => {
    // The provider reported main's session reset 60 s ago and the stale
    // measurement agrees; its Fable window returns in 10 s, inside the 15 s
    // buffer: by the time the retry is sent, main keeps Fable again.
    const past = failure();
    past.rateLimits!.windows[0]!.resetsAtMs = NOW - 60_000;
    const main = account("main", {
      session: { usedPercent: 100, resetsAt: NOW - 60_000 },
      weekly: { usedPercent: 50, resetsAt: NOW + 60 * HOUR },
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 10_000 } },
    });
    expect(
      decideSwitch(opus({ failure: past, accounts: [main] })),
    ).toEqual({ kind: "decline", reason: "reserved-for-preferred-model" });
    // Returning after the latest possible send instead: a wait on main.
    const later = { ...main, models: { Fable: { usedPercent: 100, resetsAt: NOW + 60_000 } } };
    expect(
      decideSwitch(opus({ failure: past, accounts: [later] })),
    ).toMatchObject({ kind: "wait", account: "main" });
  });

  it("still says no-account-usable when nothing is reserved either", () => {
    const locked = account("spare", {
      blocked: true,
      session: { usedPercent: 100, resetsAt: NOW + HOUR },
    });
    // The failed account is out of Fable: a wait for it is fine.
    const outOfFable = {
      ...failed,
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
    };
    expect(
      decideSwitch(opus({ accounts: [outOfFable, locked] })),
    ).toMatchObject({ kind: "wait", account: "main" });
    const unknown = {
      ...outOfFable,
      session: { usedPercent: 100, resetsAt: null },
    };
    expect(decideSwitch(opus({ accounts: [unknown, locked] }))).toEqual({
      kind: "decline",
      reason: "no-account-usable",
    });
    // A Max account with no window of Fable keeps it (Fable then counts
    // against its weekly): with it as the only account, the decline says so.
    expect(decideSwitch(opus({ accounts: [failed, locked] }))).toEqual({
      kind: "decline",
      reason: "reserved-for-preferred-model",
    });
  });
});

describe("a turn the account refused", () => {
  // As bb reported it on 2026-09-30 for an account whose organization turned
  // off subscription access: no rate-limit report comes with it.
  const refused = (overrides: Partial<PluginTurnFailedEvent> = {}) =>
    failure({
      errorInfo: {
        category: "unauthorized",
        providerCode: null,
        httpStatusCode: 403,
      },
      rateLimits: null,
      ...overrides,
    });

  it("moves the project to another account that can run, however well the refusing one measures", () => {
    expect(declineReason(refused())).toBeNull();
    expect(
      decideSwitch(
        input({
          failure: refused(),
          accounts: [account("main"), account("work")],
        }),
      ),
    ).toEqual({ kind: "switch", account: "work", model: null });
  });

  it("waits for another account's reset when none can run now, and never for the account that refused", () => {
    const out = { usedPercent: 100, resetsAt: NOW + HOUR };
    expect(
      decideSwitch(
        input({
          failure: refused(),
          accounts: [account("main"), account("work", { session: out })],
        }),
      ),
    ).toEqual({
      kind: "wait",
      account: "work",
      sendAt: NOW + HOUR + BUFFER,
      reason: "Waiting for work",
    });
    expect(
      decideSwitch(input({ failure: refused(), accounts: [account("main")] })),
    ).toEqual({ kind: "decline", reason: "no-account-usable" });
    // Whatever the attempt: the account must be marked (code-reviewer r9).
    expect(declineReason(refused({ attemptNumber: ATTEMPTS }))).toBeNull();
  });
});

describe("decidePlacement", () => {
  const fable = (usedPercent: number) => ({
    Fable: { usedPercent, resetsAt: NOW + 4 * HOUR },
  });

  it("puts a new project on the best account for the preferred model, even when the default could still run", () => {
    const accounts = [
      account("main", { session: { usedPercent: 30, resetsAt: NOW + HOUR } }),
      account("spare", { models: fable(100) }),
      account("work", { session: { usedPercent: 5, resetsAt: NOW + HOUR } }),
    ];
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: true,
        accounts,
        preferredModel: "Fable",
        now: NOW,
      }),
    ).toEqual({ kind: "move", account: "work", why: "new-project" });
  });

  it("leaves a new project where it is when that is already the best account", () => {
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: true,
        accounts: [
          account("main", {
            session: { usedPercent: 1, resetsAt: NOW + HOUR },
          }),
          account("work"),
        ],
        preferredModel: "",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
  });

  it("never moves a known project whose account can still run the preferred model, whatever ranks better", () => {
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [
          account("main", {
            session: { usedPercent: 90, resetsAt: NOW + HOUR },
            models: fable(99),
          }),
          account("work", {
            session: { usedPercent: 0, resetsAt: NOW + HOUR },
          }),
        ],
        preferredModel: "Fable",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
  });

  it("moves a known project off an account measured unable to run the preferred model, before the turn", () => {
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [
          account("main", { models: fable(100) }),
          account("spare", { models: fable(100) }),
          account("work", { models: fable(40) }),
        ],
        preferredModel: "Fable",
        now: NOW,
      }),
    ).toEqual({ kind: "move", account: "work", why: "current-blocked" });
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [
          account("main", {
            weekly: { usedPercent: 100, resetsAt: NOW + 3 * 24 * HOUR },
          }),
          account("work"),
        ],
        preferredModel: "",
        now: NOW,
      }),
    ).toEqual({ kind: "move", account: "work", why: "current-blocked" });
  });

  it("keeps a known project whose account answered without a session or weekly window: unknown is not out", () => {
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [
          account("main", {
            blocked: true,
            unknown: true,
            session: { usedPercent: 100, resetsAt: null },
          }),
          account("work"),
        ],
        preferredModel: "",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
    // A lock the provider reported is evidence: that one moves.
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [account("main", { blocked: true }), account("work")],
        preferredModel: "",
        now: NOW,
      }),
    ).toEqual({ kind: "move", account: "work", why: "current-blocked" });
  });

  it("keeps the project when its block already reset, when its account was never measured, or when no other account can run", () => {
    const reset = account("main", {
      session: { usedPercent: 100, resetsAt: NOW - 1 },
    });
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [reset, account("work")],
        preferredModel: "",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [account("work")],
        preferredModel: "",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: false,
        accounts: [
          account("main", { models: fable(100) }),
          account("work", { models: fable(100) }),
        ],
        preferredModel: "Fable",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
    expect(
      decidePlacement({
        currentAccount: "main",
        isNew: true,
        accounts: [
          account("main", { models: fable(100) }),
          account("work", { models: fable(100) }),
        ],
        preferredModel: "Fable",
        now: NOW,
      }),
    ).toEqual({ kind: "keep" });
  });
});

describe("decidePlacement with a reserved model (2026-10-13: the Max accounts are Fable's)", () => {
  const maxWithFable = account("spare", {
    weekly: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
    models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
  });
  const seat = account("team1", {
    session: { usedPercent: 17, resetsAt: NOW + 4 * HOUR },
    weekly: { usedPercent: 0, resetsAt: null, absent: true },
    models: { Fable: { usedPercent: 42, resetsAt: NOW + 72 * HOUR } },
  });
  const known = {
    currentAccount: "spare",
    isNew: false,
    reserveModel: "Fable",
    now: NOW,
  };

  it("moves a known project off the Max account that keeps the reserved model before an Opus turn, to a Team seat", () => {
    expect(
      decidePlacement({
        ...known,
        accounts: [maxWithFable, seat],
        preferredModel: "Opus",
      }),
    ).toEqual({ kind: "move", account: "team1", why: "current-reserved" });
  });

  it("keeps it there, saying why, when no account spares the reserve", () => {
    expect(
      decidePlacement({
        ...known,
        accounts: [maxWithFable],
        preferredModel: "Opus",
      }),
    ).toEqual({ kind: "keep", why: "current-reserved" });
    const otherMax = account("main", {
      weekly: { usedPercent: 10, resetsAt: NOW + 30 * HOUR },
      models: { Fable: { usedPercent: 5, resetsAt: NOW + 30 * HOUR } },
    });
    expect(
      decidePlacement({
        ...known,
        accounts: [maxWithFable, otherMax],
        preferredModel: "Opus",
      }),
    ).toEqual({ kind: "keep", why: "current-reserved" });
  });

  it("keeps a Fable turn on that same account, as before", () => {
    expect(
      decidePlacement({
        ...known,
        accounts: [maxWithFable, seat],
        preferredModel: "Fable",
      }),
    ).toEqual({ kind: "keep" });
  });

  it("places a new project for an Opus turn on the seat, or keeps it when only the Max is there", () => {
    expect(
      decidePlacement({
        ...known,
        isNew: true,
        accounts: [maxWithFable, seat],
        preferredModel: "Opus",
      }),
    ).toEqual({ kind: "move", account: "team1", why: "new-project" });
    expect(
      decidePlacement({
        ...known,
        isNew: true,
        accounts: [maxWithFable],
        preferredModel: "Opus",
      }),
    ).toEqual({ kind: "keep" });
  });

  describe("the way back from an excursion (the project left `excursionFrom` for another model)", () => {
    const onSeat = {
      ...known,
      currentAccount: "team1",
      preferredModel: "Fable",
      excursionFrom: "spare",
    };

    it("takes a Fable turn back to the account the project left, when it can run Fable now", () => {
      expect(
        decidePlacement({ ...onSeat, accounts: [seat, maxWithFable] }),
      ).toEqual({ kind: "move", account: "spare", why: "back-from-excursion" });
      // Even when the seat could not run Fable either: home first.
      expect(
        decidePlacement({
          ...onSeat,
          accounts: [
            { ...seat, models: { Fable: { usedPercent: 100, resetsAt: NOW + 72 * HOUR } } },
            maxWithFable,
          ],
        }),
      ).toEqual({ kind: "move", account: "spare", why: "back-from-excursion" });
    });

    it("keeps the project on the seat while home is out of Fable, blocked, unmeasured or vetoed (excursionFrom null)", () => {
      const out = { ...maxWithFable, models: { Fable: { usedPercent: 100, resetsAt: NOW + 24 * HOUR } } };
      expect(decidePlacement({ ...onSeat, accounts: [seat, out] })).toEqual({ kind: "keep" });
      const blocked = { ...maxWithFable, session: { usedPercent: 100, resetsAt: NOW + HOUR } };
      expect(decidePlacement({ ...onSeat, accounts: [seat, blocked] })).toEqual({ kind: "keep" });
      expect(decidePlacement({ ...onSeat, accounts: [seat] })).toEqual({ kind: "keep" });
      expect(
        decidePlacement({ ...onSeat, accounts: [seat, maxWithFable], excursionFrom: null }),
      ).toEqual({ kind: "keep" });
    });

    it("falls back to current-blocked when neither home nor the seat can run Fable", () => {
      const out = { ...maxWithFable, models: { Fable: { usedPercent: 100, resetsAt: NOW + 24 * HOUR } } };
      const other = account("main", { models: { Fable: { usedPercent: 3, resetsAt: NOW + 30 * HOUR } } });
      expect(
        decidePlacement({
          ...onSeat,
          accounts: [
            { ...seat, models: { Fable: { usedPercent: 100, resetsAt: NOW + 72 * HOUR } } },
            out,
            other,
          ],
        }),
      ).toEqual({ kind: "move", account: "main", why: "current-blocked" });
    });

    it("goes home even when the seat's own measurement is missing or incomplete (Sol r1, BM-INSPECT-006)", () => {
      expect(decidePlacement({ ...onSeat, accounts: [maxWithFable] })).toEqual({
        kind: "move",
        account: "spare",
        why: "back-from-excursion",
      });
      expect(
        decidePlacement({
          ...onSeat,
          accounts: [{ ...seat, blocked: true, unknown: true }, maxWithFable],
        }),
      ).toEqual({ kind: "move", account: "spare", why: "back-from-excursion" });
      // Home unmeasured or incomplete: the seat keeps it, measured or not.
      expect(
        decidePlacement({
          ...onSeat,
          accounts: [
            { ...seat, blocked: true, unknown: true },
            { ...maxWithFable, blocked: true, unknown: true },
          ],
        }),
      ).toEqual({ kind: "keep" });
    });

    it("means nothing to a turn in another model", () => {
      expect(
        decidePlacement({ ...onSeat, preferredModel: "Opus", accounts: [seat, maxWithFable] }),
      ).toEqual({ kind: "keep" });
    });
  });
});

describe("decideAhead", () => {
  const base = {
    currentAccount: "main",
    preferredModel: "Fable",
    threshold: 90,
    now: NOW,
  };

  it("moves the project when its account reached the threshold and another has room", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            models: { Fable: { usedPercent: 92, resetsAt: NOW + HOUR } },
          }),
          account("spare", {
            models: { Fable: { usedPercent: 40, resetsAt: NOW + HOUR } },
          }),
        ],
      }),
    ).toEqual({ kind: "move", account: "spare", used: 92, window: "Fable" });
  });

  it("keeps the project under the threshold", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            models: { Fable: { usedPercent: 89, resetsAt: NOW + HOUR } },
          }),
          account("spare", {
            models: { Fable: { usedPercent: 40, resetsAt: NOW + HOUR } },
          }),
        ],
      }),
    ).toEqual({ kind: "keep" });
  });

  it("moves at exactly the threshold", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            models: { Fable: { usedPercent: 90, resetsAt: NOW + HOUR } },
          }),
          account("spare", {
            models: { Fable: { usedPercent: 89, resetsAt: NOW + HOUR } },
          }),
        ],
      }),
    ).toEqual({ kind: "move", account: "spare", used: 90, window: "Fable" });
  });

  it("looks at the session and weekly windows too, naming the fullest", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            session: { usedPercent: 95, resetsAt: NOW + HOUR },
          }),
          account("spare"),
        ],
      }),
    ).toEqual({ kind: "move", account: "spare", used: 95, window: "session" });
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            weekly: { usedPercent: 91, resetsAt: NOW + HOUR },
          }),
          account("spare"),
        ],
      }),
    ).toEqual({ kind: "move", account: "spare", used: 91, window: "weekly" });
  });

  it("never moves to an account that is itself at the threshold, or cannot run the model", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            models: { Fable: { usedPercent: 92, resetsAt: NOW + HOUR } },
          }),
          account("spare", {
            models: { Fable: { usedPercent: 90, resetsAt: NOW + HOUR } },
          }),
          account("work", {
            session: { usedPercent: 90, resetsAt: NOW + HOUR },
          }),
          account("other", { blocked: true }),
        ],
      }),
    ).toEqual({ kind: "keep" });
  });

  it("keeps the project when its account is not measured", () => {
    expect(decideAhead({ ...base, accounts: [account("spare")] })).toEqual({
      kind: "keep",
    });
  });

  it("settles a window whose reset has passed before judging", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", { session: { usedPercent: 95, resetsAt: NOW - 1 } }),
          account("spare"),
        ],
      }),
    ).toEqual({ kind: "keep" });
  });

  it("picks the best of the accounts with room, like a switch would", () => {
    expect(
      decideAhead({
        ...base,
        accounts: [
          account("main", {
            session: { usedPercent: 99, resetsAt: NOW + HOUR },
          }),
          account("spare", {
            weekly: { usedPercent: 50, resetsAt: NOW + 5 * 24 * HOUR },
          }),
          account("work", {
            weekly: { usedPercent: 50, resetsAt: NOW + 2 * 24 * HOUR },
          }),
        ],
      }),
    ).toEqual({ kind: "move", account: "work", used: 99, window: "session" });
  });
});

describe("modelFamily", () => {
  it("names the model of a bb model id as the usage API does", () => {
    // Ids as `bb provider models claude-code` lists them (2026-09-30).
    expect(modelFamily("claude-opus-5-5")).toBe("Opus");
    expect(modelFamily("claude-fable-5-1")).toBe("Fable");
    expect(modelFamily("claude-sonnet-5")).toBe("Sonnet");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("Haiku");
  });

  it("names nothing for a model bb has not resolved, an alias or another provider's model", () => {
    for (const id of [
      null,
      "",
      "opusplan",
      "opus",
      "gpt-6-astra",
      "claude-",
      "claude-opus",
      "claude-3-5-sonnet-20241022",
      "my-claude-opus-5-5",
    ])
      expect(modelFamily(id)).toBeNull();
  });
});

// The reserve must reach every decision that chooses for the model a
// message is sent with: if `reserveModel` is dropped from the options of
// any of them, these go red while the policy's own tests stay green.
describe("reserveModel reaches each decision", () => {
  // Its weekly resets sooner, so without the reserve it wins every ranking.
  const keepsFable = account("keepsFable", {
    weekly: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
    models: { Fable: { usedPercent: 2, resetsAt: NOW + 24 * HOUR } },
  });
  const noFable = account("noFable", {
    weekly: { usedPercent: 91, resetsAt: NOW + 60 * HOUR },
    models: { Fable: { usedPercent: 100, resetsAt: NOW + 60 * HOUR } },
  });

  it("decideSwitch moves an Opus turn to the account out of Fable", () => {
    const base = input({
      accounts: [
        account("main", {
          session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
        }),
        keepsFable,
        noFable,
      ],
      preferredModel: "Opus",
    });
    expect(decideSwitch(base)).toMatchObject({
      kind: "switch",
      account: "keepsFable",
    });
    expect(decideSwitch({ ...base, reserveModel: "Fable" })).toMatchObject({
      kind: "switch",
      account: "noFable",
    });
  });

  it("decidePlacement places a new project and moves a blocked one with the reserve", () => {
    const fresh = {
      currentAccount: "main",
      isNew: true,
      accounts: [account("main"), keepsFable, noFable],
      preferredModel: "Opus",
      now: NOW,
    };
    expect(decidePlacement(fresh)).toMatchObject({
      kind: "move",
      account: "keepsFable",
    });
    expect(decidePlacement({ ...fresh, reserveModel: "Fable" })).toMatchObject({
      kind: "move",
      account: "noFable",
    });
    const blocked = {
      ...fresh,
      isNew: false,
      accounts: [
        account("main", {
          session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
        }),
        keepsFable,
        noFable,
      ],
    };
    expect(decidePlacement(blocked)).toMatchObject({
      kind: "move",
      account: "keepsFable",
    });
    expect(
      decidePlacement({ ...blocked, reserveModel: "Fable" }),
    ).toMatchObject({
      kind: "move",
      account: "noFable",
    });
  });

  it("bestAccount takes the reserve as its fourth argument", () => {
    expect(bestAccount([keepsFable, noFable], "Opus", NOW)).toBe("keepsFable");
    expect(bestAccount([keepsFable, noFable], "Opus", NOW, "Fable")).toBe(
      "noFable",
    );
  });
});

// D3 (2026-10-17): bb gives a plugin no model for a retry, so a thread in
// the preferred model that no account can run is told to switch to Opus,
// naming where an Opus turn of it would go. Whether Fable is left is judged
// apart from the decision's reason: a wait, a wait beyond the maximum and
// no usable account all say it.
describe("opusInstead: a Fable thread no account can run is told to switch to Opus (D3, S15)", () => {
  /** A Team seat: no general weekly (measured 2026-10-11). */
  const seat = (name: string, overrides: Partial<AccountUsage> = {}) =>
    account(name, {
      weekly: { usedPercent: 0, resetsAt: null, absent: true },
      ...overrides,
    });
  // Where the turn failed: its report (a blocked session) and its numbers agree.
  const team5 = seat("team5", {
    session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
    models: { Fable: { usedPercent: 100, resetsAt: NOW + 5 * HOUR } },
  });
  // Fable back first, but its session is out: no Opus there now either.
  const team1 = seat("team1", {
    session: { usedPercent: 100, resetsAt: NOW + HOUR },
    models: { Fable: { usedPercent: 100, resetsAt: NOW + 3 * HOUR } },
  });
  const team2 = seat("team2", {
    session: { usedPercent: 0, resetsAt: null },
    models: {
      Fable: { usedPercent: 100, resetsAt: NOW + 6 * HOUR },
      Opus: { usedPercent: 20, resetsAt: NOW + 96 * HOUR },
    },
  });
  const fable = (overrides: Partial<SwitchInput> = {}) =>
    input({
      currentAccount: "team5",
      accounts: [team5, team1, team2],
      preferredModel: "Fable",
      reserveModel: "Fable",
      ...overrides,
    });
  const advice = (i: SwitchInput, unread: string[] = []) =>
    opusInstead(decideSwitch(i), i, unread);

  it("S15: every Fable at 100 % with a known reset (a wait) and team2 with Opus: the wait stands and names team2 for Opus", () => {
    const i = fable();
    expect(decideSwitch(i)).toEqual({
      kind: "wait",
      account: "team1",
      sendAt: NOW + 3 * HOUR + BUFFER,
      reason: "Waiting for Fable on team1",
    });
    expect(advice(i)).toBe("team2");
  });

  it("says it on a wait beyond the maximum too", () => {
    const i = fable({ maximumWaitMs: HOUR });
    expect(decideSwitch(i)).toEqual({
      kind: "decline",
      reason: "beyond-maximum-wait",
    });
    expect(advice(i)).toBe("team2");
  });

  it("says it when no account is usable at all (no reset known)", () => {
    const unknownReset = (a: AccountUsage): AccountUsage => ({
      ...a,
      models: {
        ...a.models,
        Fable: { usedPercent: 100, resetsAt: null },
      },
    });
    const i = fable({
      accounts: [team5, team1, team2].map(unknownReset),
      failure: failure({
        rateLimits: { ...failure().rateLimits!, windows: [] },
      }),
    });
    expect(decideSwitch(i)).toEqual({
      kind: "decline",
      reason: "no-account-usable",
    });
    expect(advice(i)).toBe("team2");
  });

  it("without an account that can run Opus, says nothing (the wait as before)", () => {
    const opusOut = seat("team2", {
      session: { usedPercent: 0, resetsAt: null },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 6 * HOUR },
        Opus: { usedPercent: 100, resetsAt: NOW + 96 * HOUR },
      },
    });
    const i = fable({ accounts: [team5, team1, opusOut] });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(i)).toBeNull();
  });

  it("a failed read (429) of the only account with Fable is no proof that Fable is gone: nothing said", () => {
    // Its last good numbers may show Fable spent; its latest read failed.
    const team3 = seat("team3", {
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 4 * HOUR } },
    });
    const i = fable({ accounts: [team5, team1, team2, team3] });
    expect(advice(i, ["team3"])).toBeNull();
    // Left out of the measurements altogether (stale and failing): the same.
    expect(advice(fable(), ["team3"])).toBeNull();
    // Read, the same numbers say it.
    expect(advice(i)).toBe("team2");
  });

  it("an account whose answer lacked a window is unknown, not out of Fable: nothing said", () => {
    const unknown = seat("team3", {
      blocked: true,
      unknown: true,
      models: {},
    });
    expect(advice(fable({ accounts: [team5, team1, team2, unknown] }))).toBeNull();
  });

  it("a Max account with Fable usable as the only one that could run Opus: nothing said (it has Fable, and the Max accounts are Fable's)", () => {
    const max1 = account("max1", {
      session: { usedPercent: 30, resetsAt: NOW + 3 * HOUR },
      weekly: { usedPercent: 50, resetsAt: NOW + 72 * HOUR },
      models: { Fable: { usedPercent: 40, resetsAt: NOW + 72 * HOUR } },
    });
    // A leftover: the turn ran on team5; the project already sits on max1.
    const leftover = fable({
      currentAccount: "max1",
      failedAccount: "team5",
      accounts: [team5, team1, max1],
    });
    expect(decideSwitch(leftover)).toMatchObject({ kind: "wait", account: "max1" });
    expect(advice(leftover)).toBeNull();
    // The turn failed on it: its report rules it out, while its numbers,
    // not read again yet, still keep Fable. Never named for Opus.
    const failedOnMax = fable({ currentAccount: "max1", accounts: [max1, team1] });
    expect(decideSwitch(failedOnMax)).toMatchObject({ kind: "wait", account: "max1" });
    expect(advice(failedOnMax)).toBeNull();
    // With a seat that can run Opus, that seat is named, not the Max.
    expect(advice(fable({ currentAccount: "max1", accounts: [max1, team1, team2] }))).toBe("team2");
  });

  it("never names the account the turn just failed on, whose report blocked a window an Opus turn counts against; left in error, its numbers decide", () => {
    // team5's numbers predate its failure: they still show room in its
    // session, and an Opus window that runs out first.
    const stale = seat("team5", {
      session: { usedPercent: 10, resetsAt: NOW + HOUR },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 5 * HOUR },
        Opus: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
      },
    });
    const failed = fable({ accounts: [stale, team1, team2] });
    expect(decideSwitch(failed)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(failed)).toBe("team2");
    // Declined, the project stays on team5: still not named.
    expect(opusInstead({ kind: "decline", reason: "no-account-usable" }, failed, [])).toBe("team2");
    // Left in error the report may be an earlier account's: team5 is
    // judged on its numbers, and its Opus window runs out first.
    const rescued = { ...failed, stuck: true };
    expect(decideSwitch(rescued)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(rescued)).toBe("team5");
  });

  it("a blocked report not proven the failed turn's own rules no account out for Opus: the account it failed on is judged on its numbers (Sol B2-R2-002)", () => {
    // team5's numbers show room in its session and an Opus window that runs
    // out first; the report may be an earlier turn's, of another account.
    const team5Now = seat("team5", {
      session: { usedPercent: 10, resetsAt: NOW + HOUR },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 5 * HOUR },
        Opus: { usedPercent: 10, resetsAt: NOW + 24 * HOUR },
      },
    });
    const inherited = fable({ accounts: [team5Now, team1, team2], ownReport: false });
    expect(decideSwitch(inherited)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(inherited)).toBe("team5");
    // Proven its own (the default), it rules team5 out.
    expect(advice({ ...inherited, ownReport: true })).toBe("team2");
    // Never for Fable: the turn just failed there.
    const fableLeft = seat("team5", {
      session: { usedPercent: 10, resetsAt: NOW + HOUR },
      models: { Fable: { usedPercent: 40, resetsAt: NOW + 5 * HOUR } },
    });
    expect(advice(fable({ accounts: [fableLeft, team1, team2], ownReport: false }))).toBe("team5");
  });

  /** Refused for Fable while the stored report only warned on the session (bb's report lags the refusal). */
  const warning = failure({
    rateLimits: {
      ...failure().rateLimits!,
      status: "warning",
      windows: [
        {
          providerKey: "primary",
          label: "Current session",
          status: "warning",
          resetsAtMs: NOW + HOUR,
        },
      ],
    },
  });

  it("under a warning report the account the turn failed on is judged on its numbers for Opus (no window is blocked), never for Fable", () => {
    // Its fresh numbers: Fable spent, the session at 85 %, Opus room.
    const warned = seat("team5", {
      session: { usedPercent: 85, resetsAt: NOW + HOUR },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 2 * HOUR },
        Opus: { usedPercent: 10, resetsAt: NOW + 96 * HOUR },
      },
    });
    const i = fable({ failure: warning, accounts: [warned, team1, team2] });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "team5" });
    // The wait leaves the project on team5, which runs Opus: the placement
    // before an Opus turn keeps it there.
    expect(advice(i)).toBe("team5");
    // The only account that runs Opus: still said.
    const opusOut = seat("team2", {
      session: { usedPercent: 0, resetsAt: null },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 6 * HOUR },
        Opus: { usedPercent: 100, resetsAt: NOW + 96 * HOUR },
      },
    });
    expect(advice(fable({ failure: warning, accounts: [warned, team1, opusOut] }))).toBe("team5");
    // Numbers read before the refusal that still show Fable: it was just
    // refused Fable, so they do not stop the advice.
    const stale = seat("team5", {
      session: { usedPercent: 85, resetsAt: NOW + HOUR },
      models: { Fable: { usedPercent: 40, resetsAt: NOW + 72 * HOUR } },
    });
    const j = fable({ failure: warning, accounts: [stale, team1, team2] });
    expect(decideSwitch(j)).toMatchObject({ kind: "wait", account: "team5" });
    expect(advice(j)).toBe("team5");
    // Its session at 100 % by its numbers: no Opus there either.
    const full = seat("team5", {
      session: { usedPercent: 100, resetsAt: NOW + HOUR },
      models: { Fable: { usedPercent: 100, resetsAt: NOW + 2 * HOUR } },
    });
    expect(advice(fable({ failure: warning, accounts: [full, team1, team2] }))).toBe("team2");
  });

  it("under a warning report a Max account the turn failed on, whose numbers still keep Fable, is never named for Opus (the Max accounts are Fable's)", () => {
    const max1 = account("max1", {
      session: { usedPercent: 85, resetsAt: NOW + HOUR },
      weekly: { usedPercent: 50, resetsAt: NOW + 72 * HOUR },
      models: { Fable: { usedPercent: 40, resetsAt: NOW + 72 * HOUR } },
    });
    const i = fable({
      currentAccount: "max1",
      failure: warning,
      accounts: [max1, team1, team2],
    });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "max1" });
    expect(advice(i)).toBe("team2");
  });

  it("an account with Fable left whose session is at 100 % has no usable Fable (S9): said", () => {
    const sessionOut = seat("team1", {
      session: { usedPercent: 100, resetsAt: NOW + HOUR },
      models: { Fable: { usedPercent: 23, resetsAt: NOW + 72 * HOUR } },
    });
    const i = fable({ accounts: [team5, sessionOut, team2] });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(i)).toBe("team2");
  });

  it("an account with Fable left whose weekly is at 100 % has no usable Fable: said", () => {
    const weeklyOut = account("max2", {
      session: { usedPercent: 10, resetsAt: NOW + 3 * HOUR },
      weekly: { usedPercent: 100, resetsAt: NOW + 4 * HOUR },
      models: { Fable: { usedPercent: 60, resetsAt: NOW + 4 * HOUR } },
    });
    const i = fable({ accounts: [team5, team1, team2, weeklyOut] });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(i)).toBe("team2");
  });

  it("a locked account with Fable left has no usable Fable: said", () => {
    const locked = seat("team3", {
      blocked: true,
      models: { Fable: { usedPercent: 10, resetsAt: NOW + 72 * HOUR } },
    });
    const i = fable({ accounts: [team5, team1, team2, locked] });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(i)).toBe("team2");
  });

  it("while an account other than the failed one can run Fable, nothing said, whatever the decision", () => {
    // A leftover: the turn ran on team5, the project already sits on team3,
    // which its numbers say runs Fable: the decision waits a moment there.
    const team3 = seat("team3", {
      models: { Fable: { usedPercent: 30, resetsAt: NOW + 72 * HOUR } },
    });
    const leftover = fable({
      currentAccount: "team3",
      failedAccount: "team5",
      accounts: [team5, team1, team2, team3],
    });
    expect(decideSwitch(leftover)).toMatchObject({
      kind: "wait",
      account: "team3",
    });
    expect(advice(leftover)).toBeNull();
    // Asked straight, with any decision that could carry it.
    for (const decision of [
      { kind: "decline", reason: "no-account-usable" },
      { kind: "decline", reason: "beyond-maximum-wait" },
    ] as const)
      expect(opusInstead(decision, leftover, [])).toBeNull();
  });

  it("names the account the project waits on when it can run Opus, as the placement before the turn would keep it there", () => {
    // team1's session is half spent (a higher quarter than team2's), yet an
    // Opus turn of a project on team1 stays on team1: it runs Opus there.
    const halfSession = seat("team1", {
      session: { usedPercent: 60, resetsAt: NOW + HOUR },
      models: {
        Fable: { usedPercent: 100, resetsAt: NOW + 3 * HOUR },
        Opus: { usedPercent: 10, resetsAt: NOW + 96 * HOUR },
      },
    });
    const i = fable({ accounts: [team5, halfSession, team2] });
    expect(decideSwitch(i)).toMatchObject({ kind: "wait", account: "team1" });
    expect(advice(i)).toBe("team1");
    // Declined, the project stays on team5, which cannot run Opus: team2.
    expect(opusInstead({ kind: "decline", reason: "no-account-usable" }, i, [])).toBe("team2");
  });

  it("says nothing for a switch, a retry or any other decline", () => {
    const i = fable();
    for (const decision of [
      { kind: "switch", account: "team2", model: "Fable" },
      { kind: "retry", account: "team5", model: "Fable" },
      { kind: "decline", reason: "attempts-exhausted" },
      { kind: "decline", reason: "not-rate-limit" },
      { kind: "decline", reason: "reserved-for-preferred-model" },
    ] as const)
      expect(opusInstead(decision, i, [])).toBeNull();
  });

  it("only for a thread in the preferred model: not for an Opus thread, nor without a preferred model", () => {
    expect(advice(fable({ preferredModel: "Opus" }))).toBeNull();
    expect(advice(fable({ reserveModel: "" }))).toBeNull();
    expect(advice(fable({ reserveModel: undefined }))).toBeNull();
    // Opus as the preferred model: Opus is no way out of itself, even when
    // the account that just refused it still shows Opus in its numbers.
    const opusLeft = seat("team5", {
      models: { Opus: { usedPercent: 10, resetsAt: NOW + 96 * HOUR } },
    });
    const opusThread = fable({
      preferredModel: "Opus",
      reserveModel: "Opus",
      accounts: [opusLeft, team1],
    });
    expect(decideSwitch(opusThread)).toMatchObject({
      kind: "wait",
      account: "team1",
    });
    expect(advice(opusThread)).toBeNull();
    // The model's case does not matter (bb's family vs. the setting).
    expect(advice(fable({ preferredModel: "fable" }))).toBe("team2");
  });

  it("Opus as the preferred model is never told to switch to Opus, also under a warning report that lets the account it failed on run Opus by its numbers (Sol B2-005)", () => {
    // The turn failed on team5 under a warning report; its numbers still
    // show room in the session and in Opus; every other account is out.
    const opusLeft = seat("team5", {
      session: { usedPercent: 10, resetsAt: NOW + HOUR },
      models: { Opus: { usedPercent: 10, resetsAt: NOW + 96 * HOUR } },
    });
    const sessionOut = seat("team1", {
      session: { usedPercent: 100, resetsAt: NOW + HOUR },
      models: { Opus: { usedPercent: 10, resetsAt: NOW + 96 * HOUR } },
    });
    for (const model of ["Opus", "opus", "OPUS"]) {
      const opusThread = fable({
        preferredModel: model,
        reserveModel: model,
        failure: warning,
        accounts: [opusLeft, sessionOut],
      });
      expect(decideSwitch(opusThread)).toMatchObject({ kind: "wait" });
      expect(advice(opusThread)).toBeNull();
      for (const decision of [
        { kind: "decline", reason: "no-account-usable" },
        { kind: "decline", reason: "beyond-maximum-wait" },
      ] as const)
        expect(opusInstead(decision, opusThread, [])).toBeNull();
    }
  });

  it("left in error, the account it ran on is judged on its numbers like any other", () => {
    // A rescue: the log's report may be an earlier account's. team5's
    // numbers say it is out of Fable: said; if they said it runs Fable,
    // the rescue would retry there and say nothing.
    expect(advice(fable({ stuck: true }))).toBe("team2");
    const fresh = seat("team5", {
      models: { Fable: { usedPercent: 30, resetsAt: NOW + 72 * HOUR } },
    });
    const stuck = fable({ stuck: true, accounts: [fresh, team1, team2] });
    expect(decideSwitch(stuck)).toMatchObject({ kind: "retry" });
    expect(opusInstead({ kind: "decline", reason: "no-account-usable" }, stuck, [])).toBeNull();
  });

  it("the text names the model, Opus and the account", () => {
    expect(opusInsteadText("Fable", "team2")).toBe(
      "No Fable on any account: switch this thread to Opus with the model picker; it will go to team2",
    );
  });
});
