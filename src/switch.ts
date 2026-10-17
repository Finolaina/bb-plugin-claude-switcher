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
  reserving,
  spendsReservedWeekly,
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
  /** Every account that could run the turn keeps the reserved model's weekly (see spendsReservedWeekly). */
  | "reserved-for-preferred-model"
  | "beyond-maximum-wait";

export type SwitchDecision =
  | { kind: "switch"; account: string; model: string | null }
  /** The project's own account has room now (a thread left in error): no move. */
  | { kind: "retry"; account: string; model: string | null }
  | { kind: "wait"; account: string; sendAt: number; reason: string }
  | { kind: "decline"; reason: DeclineReason };

export interface SwitchInput {
  failure: PluginTurnFailedEvent;
  currentAccount: string;
  /**
   * The account the failed turn ran on, when the project has moved since
   * (a leftover that outlived the grace): the provider's report is that
   * account's, which is never switched to (a wait may still move the
   * project there, when its reported reset is the earliest), and the
   * current account is judged on its measurements alone. Default: the
   * current account. Null: unknown (the project moved as the turn started):
   * the report is nobody's and the measurements alone decide.
   */
  failedAccount?: string | null;
  /**
   * Whether the failure's limit report came while the failed turn ran, so
   * from the account it ran on. bb sends the thread's latest report with
   * every failure, whichever turn it came from: a Fable limit comes with
   * none of its own (measured 2026-10-17), and after a move the latest may
   * be the old account's. False: not proven so (Sol B2-R2-002): the report
   * rules no account out for Opus (see opusInstead), and the numbers
   * decide. Default true.
   */
  ownReport?: boolean;
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  /** The model kept for its own threads; see ChoiceOptions.reserveModel. */
  reserveModel?: string;
  maximumWaitMs: number | null;
  now: number;
  random: number;
  /**
   * Judged on a refresh for a thread left in error, not on its failure: the
   * refresh paces the retries, so the attempt cap does not apply, and a log
   * without a limit report is judged on the measurements alone.
   */
  stuck?: boolean;
}

/**
 * The account itself refused the turn (its login, or its organization turned
 * subscription access off): another account may run it. No rate-limit report
 * comes with it, so nothing in the failure says whose provider refused: the
 * caller checks the thread's.
 */
export function isRefusal(failure: PluginTurnFailedEvent): boolean {
  return failure.errorInfo?.category === "unauthorized";
}

/**
 * Why this failure is none of this plugin's business, or null when it is.
 * Cheap and pure: call it before measuring anything.
 */
export function declineReason(
  failure: PluginTurnFailedEvent,
  stuck = false,
): DeclineReason | null {
  // A refusal (no login) is judged whatever the attempt: the account must
  // be marked, or a thread left in error and retried there on each refresh
  // would be refused there for good (code-reviewer r9).
  if (isRefusal(failure)) return null;
  if (!stuck && failure.attemptNumber >= MAX_ATTEMPTS)
    return "attempts-exhausted";
  if (failure.errorInfo?.category !== "rate-limit") return "not-rate-limit";
  const rateLimits = failure.rateLimits;
  if (rateLimits === null) return stuck ? null : "no-rate-limit-state";
  // bb sends the thread's latest stored report: when the provider refuses a
  // turn before reporting the limit reached, that is still a warning. Left
  // in error, that report may be an earlier turn's (allowed, unknown): the
  // measurements decide, as when there is none.
  if (
    !stuck &&
    rateLimits.status !== "blocked" &&
    rateLimits.status !== "warning"
  )
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

/**
 * When the provider's report says the account it came from runs again: the
 * latest reset of the windows it blocked (of those it warned on, under a
 * warning report: the one that warned is the one the provider enforced,
 * not the one that resets last; of any, when it flags none). Null when it
 * names none: a refusal reports no reset.
 */
export function reportedReset(failure: PluginTurnFailedEvent): number | null {
  const windows = failure.rateLimits?.windows ?? [];
  const blocked = windows.filter((w) => w.status === "blocked");
  const warned = windows.filter((w) => w.status === "warning");
  const flagged =
    blocked.length > 0 ? blocked : warned.length > 0 ? warned : windows;
  const reported = flagged
    .map((w) => w.resetsAtMs)
    .filter((ms): ms is number => ms !== null);
  return reported.length === 0 ? null : Math.max(...reported);
}

export function decideSwitch(input: SwitchInput): SwitchDecision {
  const declined = declineReason(input.failure, input.stuck === true);
  if (declined !== null) return { kind: "decline", reason: declined };

  const accounts = input.accounts.map((a) => settle(a, input.now));
  const stuck = input.stuck === true;
  const failedOn =
    input.failedAccount === undefined
      ? input.currentAccount
      : input.failedAccount;
  const options = {
    preferredModel: input.preferredModel,
    reserveModel: input.reserveModel,
  };
  // A failure just reported rules its account out. Left in error, the thread
  // is judged on the measurements: the project may have moved since, and its
  // log reports the account it failed on, not the one it sits on now. The
  // same when the account it ran on is unknown: the current account first,
  // on its measurements (code-reviewer r15).
  if (stuck || failedOn === null) {
    const own = accounts.filter((a) => a.name === input.currentAccount);
    const here = chooseAccount(own, options);
    if (here !== null) {
      return {
        kind: "retry",
        account: here.account,
        model: here.model === "" ? null : here.model,
      };
    }
  }
  const others = accounts.filter(
    (a) => a.name !== input.currentAccount && a.name !== failedOn,
  );
  const choice = chooseAccount(others, options);
  if (choice !== null) {
    return {
      kind: "switch",
      account: choice.account,
      model: choice.model === "" ? null : choice.model,
    };
  }

  // The provider's own report wins over our (possibly stale) measurement of
  // the account that just failed: it is blocked at least until its reset.
  // A refusal reports no reset: the account that refused is never waited for.
  const failedFreeAt = reportedReset(input.failure);

  // Ties: the current account (no move needed), then the name. Never the
  // order the accounts were measured in.
  const before = (a: string, b: string) =>
    a === input.currentAccount || (b !== input.currentAccount && a < b);
  let earliest: { account: string; at: number } | null = null;
  let reserved = false;
  for (const account of accounts) {
    let at = freeAt(account, input.preferredModel);
    if (account.name === failedOn && !stuck) {
      at =
        at === null || failedFreeAt === null
          ? null
          : Math.max(at, failedFreeAt);
    }
    if (at === null) continue;
    // Never a wait for an account the rule would not choose as the retry
    // is sent: the account as it will be at the latest possible send (a
    // Max account whose weekly and reserved window reset together keeps
    // the reserve again then). From now at the earliest: a reset already
    // past, reported or measured, does not date the send before now.
    const sendBy =
      Math.max(at, input.now) + RESET_BUFFER_MS + RESET_JITTER_MS;
    if (spendsReservedWeekly(settle(account, sendBy), options)) {
      reserved = true;
      continue;
    }
    if (
      earliest === null ||
      at < earliest.at ||
      (at === earliest.at && before(account.name, earliest.account))
    )
      earliest = { account: account.name, at };
  }
  if (earliest === null)
    return {
      kind: "decline",
      reason: reserved ? "reserved-for-preferred-model" : "no-account-usable",
    };
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

/** The model a thread is told to switch to when no account can run the preferred one. */
export const FALLBACK_MODEL = "Opus";

/**
 * Where an Opus turn of the failed thread would go, when the thread is told
 * to switch to Opus; null when there is nothing to tell (D3, 2026-10-17: with
 * every account out of Fable "nothing works", while Team seats still have
 * Opus). Judged apart from the decision's reason: a wait, a wait beyond the
 * maximum and no usable account all say it. Told only when
 *  - the turn is in the preferred model (the reserved one), and that model
 *    is not Opus itself: Opus is no way out of Opus (Sol B2-005);
 *  - every account's latest read counts: `unread` names those whose read
 *    failed (a 429), is missing or is old, and an answer that lacked a
 *    window is unknown. A failed read is no proof that the model is gone;
 *  - no account can run the model: none unlocked with its session, its
 *    weekly and the model's window all under 100 %;
 *  - an account can run Opus without spending the reserve (chooseAccount: a
 *    Max account that keeps the preferred model is never named).
 * The account the turn just failed on never counts as running the model:
 * the provider refused it the turn, as decideSwitch has it. For Opus it is
 * out by a blocked report (the windows Claude Code reports, the five-hour
 * and the weekly ones, count against an Opus turn too); under a warning
 * report no window is blocked and its numbers decide, read just before the
 * judgment (code-reviewer 0.2.20, CR-03). Left in error, it is judged on
 * its numbers like the rest (a Fable limit comes with no such report,
 * measured 2026-10-17: it is judged there), and so it is under a report
 * not proven its turn's own (`ownReport`, Sol B2-R2-002).
 * The account named is the one the placement before an Opus turn would
 * keep or move the project to, from where the decision leaves it (a wait
 * moves it to the account waited for): that account when it runs Opus,
 * else the best other.
 *
 * ponytail: an advice, not the move. SDK 0.6.15 takes no model on
 * threads.retry. threads.send and threads.update do take one (update's is
 * presumably a model kept for the next turns: the types do not say), but a
 * retry re-submits the failed turn by reference and whether it then runs
 * in that model is not verified. Once a retry can
 * be sent in a model (threads.retry with `model`, or update then retry
 * measured to run in it), make the switch here (the plan's D2) instead of
 * telling it.
 */
export function opusInstead(
  decision: SwitchDecision,
  input: SwitchInput,
  unread: readonly string[],
): string | null {
  const model = input.preferredModel.toLowerCase();
  const reserve = input.reserveModel ?? "";
  if (
    model === "" ||
    model !== reserve.toLowerCase() ||
    model === FALLBACK_MODEL.toLowerCase()
  )
    return null;
  const told =
    decision.kind === "wait" ||
    (decision.kind === "decline" &&
      (decision.reason === "no-account-usable" ||
        decision.reason === "beyond-maximum-wait"));
  if (!told || unread.length > 0) return null;
  const accounts = input.accounts.map((a) => settle(a, input.now));
  if (accounts.some((a) => a.unknown === true)) return null;
  const failedOn =
    input.failedAccount === undefined
      ? input.currentAccount
      : input.failedAccount;
  const ruledOut = input.stuck === true ? null : failedOn;
  const outForOpus =
    input.failure.rateLimits?.status === "warning" || input.ownReport === false
      ? null
      : ruledOut;
  const runs = (a: AccountUsage) =>
    !a.blocked &&
    a.session.usedPercent < 100 &&
    a.weekly.usedPercent < 100 &&
    canRunModel(a, input.preferredModel);
  if (accounts.some((a) => a.name !== ruledOut && runs(a))) return null;
  const opus = { preferredModel: FALLBACK_MODEL, reserveModel: reserve };
  const open = accounts.filter((a) => a.name !== outForOpus);
  const from =
    decision.kind === "wait" ? decision.account : input.currentAccount;
  return (
    (
      chooseAccount(
        open.filter((a) => a.name === from),
        opus,
      ) ??
      chooseAccount(
        open.filter((a) => a.name !== from),
        opus,
      )
    )?.account ?? null
  );
}

/** What the thread and the history say when opusInstead names an account. */
export function opusInsteadText(model: string, account: string): string {
  return `No ${model} on any account: switch this thread to ${FALLBACK_MODEL} with the model picker; it will go to ${account}`;
}

export type PlacementDecision =
  /** `why`: kept although its account spends the reserve, because no account spares it. */
  | { kind: "keep"; why?: "current-reserved" }
  | {
      kind: "move";
      account: string;
      why:
        | "new-project"
        | "current-blocked"
        /** A turn in another model: its account spends the reserved model's weekly. */
        | "current-reserved"
        /** A turn in the reserved model: back to the account the project left for another model. */
        | "back-from-excursion";
    };

export interface PlacementInput {
  currentAccount: string;
  /** The project has never been seen by this plugin (created after it was installed). */
  isNew: boolean;
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  /** The model kept for its own threads; see ChoiceOptions.reserveModel. */
  reserveModel?: string;
  /**
   * The account the project left for a turn in another model (its excursion),
   * for a turn in the reserved model to go back to; null when the caller
   * rules it out (left ahead of the limit and still above the share).
   * Nothing to a turn in another model.
   */
  excursionFrom?: string | null;
  now: number;
}

/** The account a project would best run on now, for the thread header. */
export function bestAccount(
  accounts: AccountUsage[],
  preferredModel: string,
  now: number,
  reserveModel?: string,
): string | null {
  return (
    chooseAccount(
      accounts.map((a) => settle(a, now)),
      { preferredModel, reserveModel },
    )?.account ?? null
  );
}

/**
 * Where a project should run before a turn. A new project goes to the best
 * account (the same choice a switch makes); a known one is moved only when
 * its account is MEASURED unable to run, so a project the user pinned by
 * hand stays put while it works. An unmeasured account (or one whose answer
 * lacked a window), or no other account able to run, keeps the project: the
 * failure path then decides, exactly as before this check existed.
 *
 * With a reserved model (2026-10-13), "able to run" a turn in another model
 * includes not spending the reserve: a known project on a Max account that
 * keeps Fable moves off it for an Opus turn (current-reserved), and stays,
 * saying so, when no account spares Fable. A turn in the reserved model
 * goes back to the account the project left for that (back-from-excursion)
 * as soon as it can run it.
 */
export function decidePlacement(input: PlacementInput): PlacementDecision {
  const accounts = input.accounts.map((a) => settle(a, input.now));
  const options = {
    preferredModel: input.preferredModel,
    reserveModel: input.reserveModel,
  };
  if (input.isNew) {
    const choice = chooseAccount(accounts, options);
    return choice === null || choice.account === input.currentAccount
      ? { kind: "keep" }
      : { kind: "move", account: choice.account, why: "new-project" };
  }
  // The way home first: it depends on home's measurement, not on the
  // current account's, which may be missing or incomplete (Codex
  // BM-INSPECT-006).
  if (
    !reserving(options) &&
    typeof input.excursionFrom === "string" &&
    input.excursionFrom !== input.currentAccount
  ) {
    const home = accounts.find((a) => a.name === input.excursionFrom);
    if (
      home !== undefined &&
      home.unknown !== true &&
      isUsable(home) &&
      canRunModel(home, input.preferredModel)
    )
      return { kind: "move", account: home.name, why: "back-from-excursion" };
  }
  const current = accounts.find((a) => a.name === input.currentAccount);
  if (current === undefined || current.unknown === true)
    return { kind: "keep" };
  const runs = isUsable(current) && canRunModel(current, input.preferredModel);
  if (runs && !spendsReservedWeekly(current, options)) return { kind: "keep" };
  const choice = chooseAccount(
    accounts.filter((a) => a.name !== input.currentAccount),
    options,
  );
  if (choice === null)
    return runs ? { kind: "keep", why: "current-reserved" } : { kind: "keep" };
  return {
    kind: "move",
    account: choice.account,
    why: runs ? "current-reserved" : "current-blocked",
  };
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
  /** The model kept for its own threads; see ChoiceOptions.reserveModel. */
  reserveModel?: string;
  /** Share of a window (session, weekly or the preferred model's) at which the project moves ahead of the limit. */
  threshold: number;
  now: number;
}

/** The fullest of the windows a turn counts against, by name. */
export function fullestWindow(
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
  for (const w of windows)
    if (w[1].usedPercent > fullest[1].usedPercent) fullest = w;
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
  if (current === undefined || current.unknown === true)
    return { kind: "keep" };
  const { window, used } = fullestWindow(current, input.preferredModel);
  if (used < input.threshold) return { kind: "keep" };
  const roomy = accounts.filter(
    (a) =>
      a.name !== input.currentAccount &&
      a.unknown !== true &&
      fullestWindow(a, input.preferredModel).used < input.threshold,
  );
  const choice = chooseAccount(roomy, {
    preferredModel: input.preferredModel,
    reserveModel: input.reserveModel,
  });
  return choice === null
    ? { kind: "keep" }
    : { kind: "move", account: choice.account, used, window };
}
