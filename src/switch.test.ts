import { describe, expect, it } from "vitest";
import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { AccountUsage } from "./policy.js";
import {
  declineReason,
  decidePlacement,
  decideSwitch,
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
      account(name, { session: { usedPercent: 100, resetsAt: NOW + 2 * HOUR } });
    const forward = decideSwitch(
      input({ accounts: [exhausted("main"), exhausted("work"), exhausted("beta")] }),
    );
    const backward = decideSwitch(
      input({ accounts: [exhausted("beta"), exhausted("work"), exhausted("main")] }),
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
          account("main", { session: { usedPercent: 1, resetsAt: NOW + HOUR } }),
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
          account("main", { session: { usedPercent: 90, resetsAt: NOW + HOUR }, models: fable(99) }),
          account("work", { session: { usedPercent: 0, resetsAt: NOW + HOUR } }),
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
          account("main", { weekly: { usedPercent: 100, resetsAt: NOW + 3 * 24 * HOUR } }),
          account("work"),
        ],
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
