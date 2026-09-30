// What to do when a turn fails on a subscription limit: move the project to
// another account (policy.ts decides which), or wait for the earliest reset
// that frees an account (moving the project to it), or leave the failure
// alone.
//
// Buffer, jitter and attempt cap mirror bb's built-in provider-retry plugin
// so a wait scheduled here lands where that plugin would have put it.
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import {
  canRunModel,
  chooseAccount,
  isUsable,
  modelWindow,
  type AccountUsage,
  type UsageWindow,
} from "./policy.js";

export const RESET_BUFFER_MS = 15_000;
export const RESET_JITTER_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** bb provider id whose accounts this plugin manages. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

export type DeclineReason =
  | "not-rate-limit"
  | "no-rate-limit-state"
  | "not-subscription-window"
  | "not-claude-code"
  | "attempts-exhausted"
  | "no-account-usable"
  | "beyond-maximum-wait";

export type SwitchDecision =
  | { kind: "switch"; account: string; model: string | null }
  | { kind: "wait"; account: string; sendAt: number; reason: string }
  | { kind: "decline"; reason: DeclineReason };

export interface SwitchInput {
  failure: PluginTurnFailedEvent;
  currentAccount: string;
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  maximumWaitMs: number | null;
  now: number;
  random: number;
}

/**
 * Why this failure is none of this plugin's business, or null when it is.
 * Cheap and pure: call it before measuring anything.
 */
export function declineReason(
  failure: PluginTurnFailedEvent,
): DeclineReason | null {
  if (failure.attemptNumber >= MAX_ATTEMPTS) return "attempts-exhausted";
  if (failure.errorInfo?.category !== "rate-limit") return "not-rate-limit";
  const rateLimits = failure.rateLimits;
  if (rateLimits === null || rateLimits.status !== "blocked")
    return "no-rate-limit-state";
  if (rateLimits.kind !== "subscription-window")
    return "not-subscription-window";
  if (rateLimits.providerId !== CLAUDE_CODE_PROVIDER) return "not-claude-code";
  return null;
}

/**
 * The usage API's name for the model a bb model id runs
 * ("claude-opus-5-5" → "Opus"), or null when the id is not a Claude model id
 * (none resolved yet, an alias): the preferred model decides then.
 */
export function modelFamily(modelId: string | null): string | null {
  const family = /^claude-([a-z]+)-/.exec(modelId ?? "")?.[1];
  return family === undefined
    ? null
    : family[0]!.toUpperCase() + family.slice(1);
}

/** A window whose reset has passed is free again, whatever a stale measurement says. */
export function settle(account: AccountUsage, now: number): AccountUsage {
  const window = (w: UsageWindow): UsageWindow =>
    w.resetsAt !== null && w.resetsAt <= now
      ? { usedPercent: 0, resetsAt: null }
      : w;
  return {
    ...account,
    session: window(account.session),
    weekly: window(account.weekly),
    models: Object.fromEntries(
      Object.entries(account.models).map(([m, w]) => [m, window(w)]),
    ),
  };
}

/** When the account can run `model` again, or null if unknown or locked. */
function freeAt(account: AccountUsage, model: string): number | null {
  if (account.blocked) return null;
  const windows: UsageWindow[] = [account.session, account.weekly];
  const scoped = model === "" ? undefined : modelWindow(account, model);
  if (scoped !== undefined) windows.push(scoped);
  const blocking = windows.filter((w) => w.usedPercent >= 100);
  if (blocking.length === 0) return 0;
  if (blocking.some((w) => w.resetsAt === null)) return null;
  return Math.max(...blocking.map((w) => w.resetsAt as number));
}

export function decideSwitch(input: SwitchInput): SwitchDecision {
  const declined = declineReason(input.failure);
  if (declined !== null) return { kind: "decline", reason: declined };
  const rateLimits = input.failure.rateLimits!;

  const accounts = input.accounts.map((a) => settle(a, input.now));
  const others = accounts.filter((a) => a.name !== input.currentAccount);
  const choice = chooseAccount(others, {
    preferredModel: input.preferredModel,
  });
  if (choice !== null) {
    return {
      kind: "switch",
      account: choice.account,
      model: choice.model === "" ? null : choice.model,
    };
  }

  // The provider's own report wins over our (possibly stale) measurement of
  // the account that just failed: it is blocked at least until its reset.
  const blocked = rateLimits.windows.filter((w) => w.status === "blocked");
  const reported = (blocked.length > 0 ? blocked : rateLimits.windows)
    .map((w) => w.resetsAtMs)
    .filter((ms): ms is number => ms !== null);
  const failedFreeAt = reported.length === 0 ? null : Math.max(...reported);

  // Ties: the current account (no move needed), then the name. Never the
  // order the accounts were measured in.
  const before = (a: string, b: string) =>
    a === input.currentAccount || (b !== input.currentAccount && a < b);
  let earliest: { account: string; at: number } | null = null;
  for (const account of accounts) {
    let at = freeAt(account, input.preferredModel);
    if (account.name === input.currentAccount) {
      at =
        at === null || failedFreeAt === null
          ? null
          : Math.max(at, failedFreeAt);
    }
    if (at === null) continue;
    if (
      earliest === null ||
      at < earliest.at ||
      (at === earliest.at && before(account.name, earliest.account))
    )
      earliest = { account: account.name, at };
  }
  if (earliest === null)
    return { kind: "decline", reason: "no-account-usable" };
  if (
    input.maximumWaitMs !== null &&
    earliest.at - input.now > input.maximumWaitMs
  ) {
    return { kind: "decline", reason: "beyond-maximum-wait" };
  }
  const base = Math.max(earliest.at, input.now);
  const what = input.preferredModel === "" ? "" : `${input.preferredModel} on `;
  return {
    kind: "wait",
    account: earliest.account,
    sendAt: base + RESET_BUFFER_MS + Math.floor(input.random * RESET_JITTER_MS),
    reason: `Waiting for ${what}${earliest.account}`,
  };
}

export type PlacementDecision =
  | { kind: "keep" }
  | { kind: "move"; account: string; why: "new-project" | "current-blocked" };

export interface PlacementInput {
  currentAccount: string;
  /** The project has never been seen by this plugin (created after it was installed). */
  isNew: boolean;
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  now: number;
}

/** The account a project would best run on now, for the thread header. */
export function bestAccount(
  accounts: AccountUsage[],
  preferredModel: string,
  now: number,
): string | null {
  return (
    chooseAccount(
      accounts.map((a) => settle(a, now)),
      { preferredModel },
    )?.account ?? null
  );
}

/**
 * Where a project should run before a new thread's first turn. A new project
 * goes to the best account (the same choice a switch makes); a known one is
 * moved only when its account is MEASURED unable to run, so a project the user
 * pinned by hand stays put while it works. An unmeasured account (or one whose
 * answer lacked a window), or no other account able to run, keeps the
 * project: the failure path then decides, exactly as before this check existed.
 */
export function decidePlacement(input: PlacementInput): PlacementDecision {
  const accounts = input.accounts.map((a) => settle(a, input.now));
  const options = { preferredModel: input.preferredModel };
  if (input.isNew) {
    const choice = chooseAccount(accounts, options);
    return choice === null || choice.account === input.currentAccount
      ? { kind: "keep" }
      : { kind: "move", account: choice.account, why: "new-project" };
  }
  const current = accounts.find((a) => a.name === input.currentAccount);
  if (
    current === undefined ||
    current.unknown === true ||
    (isUsable(current) && canRunModel(current, input.preferredModel))
  )
    return { kind: "keep" };
  const choice = chooseAccount(
    accounts.filter((a) => a.name !== input.currentAccount),
    options,
  );
  return choice === null
    ? { kind: "keep" }
    : { kind: "move", account: choice.account, why: "current-blocked" };
}

export type AheadDecision =
  | { kind: "keep" }
  | { kind: "move"; account: string; used: number; window: string };

export interface AheadInput {
  currentAccount: string;
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  /** Share of a window (session, weekly or the preferred model's) at which the project moves ahead of the limit. */
  threshold: number;
  now: number;
}

/** The fullest of the windows a turn counts against, by name. */
function fullestWindow(
  account: AccountUsage,
  preferredModel: string,
): { window: string; used: number } {
  const windows: [string, UsageWindow][] = [
    ["session", account.session],
    ["weekly", account.weekly],
  ];
  const scoped = modelWindow(account, preferredModel);
  if (scoped !== undefined) windows.push([preferredModel, scoped]);
  let fullest = windows[0]!;
  for (const w of windows) if (w[1].usedPercent > fullest[1].usedPercent) fullest = w;
  return { window: fullest[0], used: fullest[1].usedPercent };
}

/**
 * Whether to move a project after a turn, before its account runs out: when
 * the account is at or above `threshold` in any window a turn counts against
 * and another account is below it in all of them. The target is chosen as a
 * switch would choose it. An unmeasured current account keeps the project:
 * only a measured number moves it.
 */
export function decideAhead(input: AheadInput): AheadDecision {
  const accounts = input.accounts.map((a) => settle(a, input.now));
  const current = accounts.find((a) => a.name === input.currentAccount);
  if (current === undefined || current.unknown === true) return { kind: "keep" };
  const { window, used } = fullestWindow(current, input.preferredModel);
  if (used < input.threshold) return { kind: "keep" };
  const roomy = accounts.filter(
    (a) =>
      a.name !== input.currentAccount &&
      a.unknown !== true &&
      fullestWindow(a, input.preferredModel).used < input.threshold,
  );
  const choice = chooseAccount(roomy, { preferredModel: input.preferredModel });
  return choice === null
    ? { kind: "keep" }
    : { kind: "move", account: choice.account, used, window };
}
