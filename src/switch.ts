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
  choosingReserve,
  opusRoom,
  afterTeams,
  holdsForReserve,
  isUsable,
  modelWindow,
  reserving,
  spendsReservedWeekly,
  type AccountUsage,
  type Choice,
  type ChoiceOptions,
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
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  /** The model kept for its own threads; see ChoiceOptions.reserveModel. */
  reserveModel?: string;
  /** See ChoiceOptions.reserveSpareUpTo. */
  reserveSpareUpTo?: number;
  /** See ChoiceOptions.reserveShare. */
  reserveShare?: number;
  /** See ChoiceOptions.opusOverflowRoom. */
  opusOverflowRoom?: number;
  /**
   * See ChoiceOptions.noTeamTakes. `ruledOut`: the account the turn just
   * failed on, never a Team that takes it (Codex r1 medium 5); null for a
   * thread left in error or a failure on an account unknown.
   */
  noTeamTakes?: (model: string, ruledOut: string | null) => boolean;
  /**
   * Until when `name` is out, from an earlier failure whose mark stands
   * (server's limitedAt); null when unmarked. A marked account is no
   * destination of this switch, and it is waited for no sooner than then
   * (Astra r3 high 1). Unused for a thread left in error: the measurements
   * judge.
   */
  limitedUntil?: (name: string) => number | null;
  /**
   * The project was put on the current account by hand: a thread left in
   * error is retried there whenever the account runs the model, whatever it
   * spends of the reserve (Aitor 2026-11-05; code-reviewer r1 M1).
   */
  pinned?: boolean;
  /**
   * Seats free on an account (see src/seats.ts). The switch goes to an
   * account with one, and only with none anywhere by quota alone (Astra
   * SEATS-R05); seats never move a project by themselves.
   */
  freeSeats?: (account: string) => number;
  /**
   * The thread is background work (see ChoiceOptions.savedForUser): the
   * switch goes behind the accounts saved for the user (Codex ULTRA-R01).
   */
  savedForUser?: (account: string) => boolean;
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

/** The mark of Calor's tick (bb-plugin-calor, `src/textos.ts`); its closing message is real work, and is not one. */
const CALOR_TICK =
  /^\s*calor: tic de caché #[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./;

/**
 * A message that only keeps a prompt cache alive. Moving its project to run it
 * would rewrite the whole context on the new account for nothing: the cache it
 * is there to keep stays behind (docs/plan-cambio-en-pausas.md).
 */
export function isCalorTick(text: string): boolean {
  return CALOR_TICK.test(text);
}

/**
 * The usage API's name for the model a bb model id runs
 * ("claude-opus-5-5" → "Opus"), or null when the id is not a Claude model id
 * (none resolved yet): the preferred model decides then. An alias is that
 * model: `bb thread tell --model opus` keeps `opus` on its row, and read as
 * no model it ran past the reserve on the project's account (2026-11-03,
 * `bb thread queue list --json`).
 */
export function modelFamily(modelId: string | null): string | null {
  const id = modelId ?? "";
  const family =
    /^claude-([a-z]+)-/.exec(id)?.[1] ??
    /^(fable|opus|sonnet|haiku)(?:\[[^\]]*\])?$/i.exec(id)?.[1]?.toLowerCase();
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

/**
 * An incomplete answer that still measured a window full, with nothing to free
 * it yet: what it is missing does not change that the account cannot run
 * `model` now (Astra FINAL-R9-001). Any other incomplete answer says nothing.
 */
export function measuredOut(account: AccountUsage, model: string, now: number): boolean {
  if (account.unknown !== true) return false;
  const settled = settle(account, now);
  return [
    settled.session,
    settled.weekly,
    model === "" ? undefined : modelWindow(settled, model),
  ].some((w) => w !== undefined && w.missing !== true && w.usedPercent >= 100);
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
 * The choice among the accounts with a free seat: an account with none is
 * no target (Astra SEATS-R05), and with none free anywhere the project
 * stays, its threads waiting for a seat where it is. Unset `freeSeats`:
 * seats do not count.
 */
function chooseSeated(
  accounts: AccountUsage[],
  options: ChoiceOptions,
  freeSeats: ((account: string) => number) | undefined,
): Choice | null {
  return chooseAccount(accounts, { ...options, freeSeats });
}

/**
 * When the provider says the account a turn failed on is free again: the
 * latest reset of the windows it flagged. A refusal reports no reset: the
 * account that refused is never waited for. Under a warning report no window
 * is blocked: the one that warned is the one the provider enforced, not the
 * one that resets last. Null: no reset reported.
 */
export function reportedFreeAt(failure: PluginTurnFailedEvent): number | null {
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
  // The Team that just refused the turn takes no part in «no Team takes
  // it», as it is no destination below (Codex r1 medium 5).
  const ruledOut = stuck ? null : failedOn;
  const teamTakes = input.noTeamTakes;
  const options = {
    preferredModel: input.preferredModel,
    reserveModel: input.reserveModel,
    reserveSpareUpTo: input.reserveSpareUpTo,
    reserveShare: input.reserveShare,
    opusOverflowRoom: input.opusOverflowRoom,
    noTeamTakes:
      teamTakes === undefined
        ? undefined
        : (model: string) => teamTakes(model, ruledOut),
    savedForUser: input.savedForUser,
  };
  // A failure just reported rules its account out. Left in error, the thread
  // is judged on the measurements: the project may have moved since, and its
  // log reports the account it failed on, not the one it sits on now. The
  // same when the account it ran on is unknown: the current account first,
  // on its measurements (code-reviewer r15).
  if (stuck || failedOn === null) {
    const own = accounts.filter((a) => a.name === input.currentAccount);
    // A pick by hand holds for the reserved model and Haiku, never for a
    // model held off the reserve (Aitor 2026-11-06, «sí o sí»).
    const here = chooseAccount(
      own,
      input.pinned === true && !holdsForReserve(options)
        ? { ...options, reserveModel: undefined }
        : options,
    );
    if (here !== null) {
      return {
        kind: "retry",
        account: here.account,
        model: here.model === "" ? null : here.model,
      };
    }
  }
  const marked = (name: string): number | null =>
    stuck ? null : (input.limitedUntil?.(name) ?? null);
  const others = accounts.filter(
    (a) =>
      a.name !== input.currentAccount &&
      a.name !== failedOn &&
      marked(a.name) === null,
  );
  // The only move that may land on an account without a seat: this one
  // cannot work, so the thread waits for a seat elsewhere.
  // ponytail: the alternative is waiting for a seat on the spent account,
  // which does not come back until its reset; a full target means a wait
  // of a turn or two, and a quota choice may still pick the busiest one.
  // Kept on purpose (Astra SEATS-R3-006, Fable 2026-10-30).
  const choice =
    chooseSeated(others, options, input.freeSeats) ??
    chooseAccount(others, options);
  if (choice !== null) {
    return {
      kind: "switch",
      account: choice.account,
      model: choice.model === "" ? null : choice.model,
    };
  }

  // The provider's own report wins over our (possibly stale) measurement of
  // the account that just failed: it is blocked at least until its reset.
  const failedFreeAt = reportedFreeAt(input.failure);

  // Ties: the current account (no move needed), then the name. Never the
  // order the accounts were measured in.
  const before = (a: string, b: string) =>
    a === input.currentAccount || (b !== input.currentAccount && a < b);
  // At the same time, a Team seat before a Max out of the reserved model
  // (Codex R047-R2-004).
  let earliest: { account: string; at: number; late: boolean } | null = null;
  let reserved = false;
  for (const account of accounts) {
    let at = freeAt(account, input.preferredModel);
    if (account.name === failedOn && !stuck) {
      at =
        at === null || failedFreeAt === null
          ? null
          : Math.max(at, failedFreeAt);
    } else {
      const until = marked(account.name);
      if (until !== null) at = at === null ? null : Math.max(at, until);
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
    const late = afterTeams(account, options);
    if (
      earliest === null ||
      at < earliest.at ||
      (at === earliest.at &&
        (late !== earliest.late
          ? !late
          : before(account.name, earliest.account)))
    )
      earliest = { account: account.name, at, late };
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

/** The declines whose thread can be told to switch to Opus (see opusInstead): no account will free, or not soon enough. */
export const ADVISED_DECLINES = [
  "no-account-usable",
  "beyond-maximum-wait",
] as const satisfies readonly DeclineReason[];

/**
 * Whether a judgment of a turn in `model` can tell its thread to switch to
 * Opus (see opusInstead), before any account is looked at: the turn is in
 * the preferred model (`reserveModel`), that model is not Opus itself, and
 * the decision is a wait or one of ADVISED_DECLINES.
 */
export function mayAdviseOpus(
  decision: SwitchDecision,
  model: string,
  reserveModel: string | undefined,
): boolean {
  const m = model.toLowerCase();
  if (
    m === "" ||
    m !== (reserveModel ?? "").toLowerCase() ||
    m === FALLBACK_MODEL.toLowerCase()
  )
    return false;
  return (
    decision.kind === "wait" ||
    (decision.kind === "decline" &&
      (ADVISED_DECLINES as readonly DeclineReason[]).includes(decision.reason))
  );
}

/**
 * Whether the thread is to be told to switch to Opus, wherever an Opus turn
 * of it would then go (see opusInstead): with no account able to run the
 * model, on reads that all count. Judged apart from the decision's reason:
 * a wait, a wait beyond the maximum and no usable account all say it. Only
 * when
 *  - the turn is in the preferred model (the reserved one), and that model
 *    is not Opus itself: Opus is no way out of Opus (Sol B2-005);
 *  - every account's latest read counts: `unread` names those whose read
 *    failed (a 429), is missing or is old, and an answer that lacked a
 *    window is unknown. A failed read is no proof that the model is gone;
 *  - no account can run the model: none unlocked with its session, its
 *    weekly and the model's window all under 100 %.
 * `ruledOut`, the account the turn just failed on, never counts as running
 * the model: the provider refused it the turn, as decideSwitch has it.
 * Null for a thread left in error: every account is judged on its numbers.
 * Where the project sits plays no part: the banners' pass asks it before
 * reading that (Sol B2-R6-003).
 */
export function adviseOpus(
  decision: SwitchDecision,
  input: Pick<SwitchInput, "accounts" | "preferredModel" | "reserveModel" | "now">,
  unread: readonly string[],
  ruledOut: string | null,
): boolean {
  if (
    !mayAdviseOpus(decision, input.preferredModel, input.reserveModel) ||
    unread.length > 0
  )
    return false;
  const accounts = input.accounts.map((a) => settle(a, input.now));
  if (accounts.some((a) => a.unknown === true)) return false;
  const runs = (a: AccountUsage) =>
    !a.blocked &&
    a.session.usedPercent < 100 &&
    a.weekly.usedPercent < 100 &&
    canRunModel(a, input.preferredModel);
  return !accounts.some((a) => a.name !== ruledOut && runs(a));
}

/**
 * Where an Opus turn of the failed thread would go, when the thread is told
 * to switch to Opus (see adviseOpus); null when there is nothing to tell (D3,
 * 2026-10-17: with every account out of Fable "nothing works", while Team
 * seats still have Opus). Told only when an account can also run Opus
 * without spending the reserve (chooseAccount: a Max account that keeps the
 * preferred model is never named). The account the turn just failed on is
 * ruled out of running the model, as decideSwitch has it; left in error, it
 * is judged on its numbers like the rest.
 * The account named is the one the dispatch would run an Opus turn of the
 * thread on (placedOn, given `placement`: the dispatch's own inputs for an
 * Opus turn of the project), from where the decision leaves the project (a
 * wait moves it to the account waited for): one function and the same
 * numbers, so the thread is told what the dispatch then does (Sol B2-002;
 * fix-B2-r3). Kept where it cannot run Opus: nothing said. Every account is
 * judged there on its numbers alone, the one the turn just failed on
 * included: when the provider's report is ahead of them, the advice and the
 * dispatch both name that account, and the Opus turn may fail there once,
 * then takes the failure path like any Opus turn.
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
  /** What it reads of a judgment's input: the failure itself says nothing here. */
  input: Omit<SwitchInput, "failure" | "maximumWaitMs" | "random">,
  unread: readonly string[],
  /** The placement before an Opus turn of the project, but where it sits. */
  placement: Omit<PlacementInput, "currentAccount">,
): string | null {
  const failedOn =
    input.failedAccount === undefined
      ? input.currentAccount
      : input.failedAccount;
  if (!adviseOpus(decision, input, unread, input.stuck === true ? null : failedOn))
    return null;
  return placedOn({
    ...placement,
    currentAccount:
      decision.kind === "wait" ? decision.account : input.currentAccount,
  });
}

/** What the thread and the history say when opusInstead names an account. */
export function opusInsteadText(model: string, account: string): string {
  return `Sin ${model} en ninguna cuenta: pasa este hilo a ${FALLBACK_MODEL} con el selector de modelo; irá a ${account}`;
}

export type PlacementDecision =
  /**
   * `why`: kept although its account spends the reserve, because no account
   * spares it (`current-reserved`), or although it is measured unable to run
   * the turn, because no other with a free seat can (`current-blocked`).
   */
  | { kind: "keep"; why?: "current-reserved" | "current-blocked" }
  | {
      kind: "move";
      account: string;
      why:
        | "new-project"
        | "current-blocked"
        /** A turn in another model: its account spends the reserved model's weekly. */
        | "current-reserved"
        /** A turn in the reserved model: back to the account the project left for another model. */
        | "back-from-excursion"
        /** The turn would wait for a seat where the project is: another account has one free. */
        | "current-full"
        /**
         * A turn in the reserved model on an account whose general weekly
         * runs out before the reserved model does: another has more room
         * (see roomMove).
         */
        | "fable-room";
    };

export interface PlacementInput {
  currentAccount: string;
  /**
   * With nothing measured of an account, whether its login says it keeps the
   * reserved model's weekly (a Max or an Ultra): a turn held off the reserve
   * goes elsewhere, or waits at the checkpoint. Unset: nothing is known.
   */
  unreadKeepsReserve?: (account: string) => boolean;
  /** Team seats by login with nothing measured: where such a turn may go when no measured account can take it. */
  unreadTeams?: string[];
  /** The project has never been seen by this plugin (created after it was installed). */
  isNew: boolean;
  /** Every account with measured usage, the current one included. */
  accounts: AccountUsage[];
  /** "" = any model. */
  preferredModel: string;
  /** The model kept for its own threads; see ChoiceOptions.reserveModel. */
  reserveModel?: string;
  /** See ChoiceOptions.reserveSpareUpTo. */
  reserveSpareUpTo?: number;
  /** See ChoiceOptions.reserveShare. */
  reserveShare?: number;
  /** See ChoiceOptions.opusOverflowRoom. */
  opusOverflowRoom?: number;
  /** See ChoiceOptions.noTeamTakes. */
  noTeamTakes?: (model: string) => boolean;
  /**
   * As SwitchInput.limitedUntil: a marked account other than the current
   * one is no destination, and is waited for no sooner than its mark ends
   * (reserveWait). The retry a switch sent away is placed again before it
   * starts, and went back to the Team seat that had just failed (Astra r5
   * medium 1).
   */
  limitedUntil?: (name: string) => number | null;
  /**
   * The account the project left for a turn in another model (its excursion),
   * for a turn in the reserved model to go back to; null when the caller
   * rules it out (left ahead of the limit and still above the share).
   * Nothing to a turn in another model.
   */
  excursionFrom?: string | null;
  /**
   * Seats free on an account (see src/seats.ts). A move goes only to an
   * account with one (Astra SEATS-R05); seats move a project by
   * themselves only with `seatsFull`.
   */
  freeSeats?: (account: string) => number;
  /**
   * The turn would wait for a seat on the current account, and no other
   * thread of the project holds one: the project moves to the best other
   * account with a free seat, and waits where it is only when none has one
   * (Aitor 2026-11-03, «necesitaría abrir más hilos»).
   */
  seatsFull?: boolean;
  /**
   * The switch-ahead share for the turn's model (see decideAhead), 0 = off:
   * a move for a seat goes only to an account below it in every window.
   */
  aheadThreshold?: number;
  /**
   * The thread is background work (see ChoiceOptions.savedForUser): every
   * choice of another account (a new project, a move off an account that
   * cannot run, the way home) goes behind the accounts saved for the user
   * (Codex ULTRA-R01). A project whose account can run is never moved for
   * the pace.
   */
  savedForUser?: (account: string) => boolean;
  now: number;
  /**
   * The current account has no login (its usage answered unauthenticated),
   * or it is the default and its login could not be checked (Astra
   * E44-R3-01): a turn there fails with «Not logged in», measured or not
   * (E44: the default `~/.claude` of a machine nobody logged in on).
   */
  currentLoggedOut?: boolean;
  /**
   * With `seatsFull`: the seats the project asks for at once (its threads at
   * work or waiting on its account, and this one). An account with that many
   * free goes first; with `seatsWantedOnly`, only such an account is a
   * target (Aitor 2026-11-05: a project with more threads than its account
   * has seats goes to one with seats for all).
   */
  seatsWanted?: number;
  seatsWantedOnly?: boolean;
  /**
   * The seats the project holds or waits for on the current account, this
   * turn's included (1 when unset). A turn in another model on an account
   * that keeps the reserved model only by its margin (reserveSpareUpTo)
   * goes to a Team seat first, but only to one with seats for all of them:
   * else the project would bounce between the two (Aitor 2026-11-05, «Team
   * primero»; code-reviewer r1 H1).
   */
  projectSeats?: number;
  /**
   * The project moved to the current account for seats within
   * stuckMoveMinutes: «Team primero» does not take it back yet, or it
   * would bounce between the Team and the Ultra (code-reviewer r2 medium).
   */
  justMovedHere?: boolean;
  /**
   * The project was put on the current account by hand: a turn that can run
   * there stays, whatever it spends of the reserve (Aitor 2026-11-05: a pick
   * holds until the account is out for real). Seats still move it.
   */
  pinned?: boolean;
  /**
   * Points of opusRoom another account must have over the current one for a
   * turn in the reserved model to move there (see roomMove). Unset = never
   * moved for room.
   */
  roomMoveGap?: number;
  /** Another thread of the project has a turn under way or holds a seat. */
  projectSeated?: boolean;
  /** The project moved for a seat or for room within stuckMoveMinutes. */
  movedRecently?: boolean;
}

/**
 * With a sibling at work, a move for room only below this room: the move
 * takes its next turns along (our own count, reparto-fable PLAN §B3).
 */
export const ROOM_MOVE_WITH_SIBLINGS = -10;

/**
 * Where a turn in the reserved model goes for room (Aitor 2026-11-07, «fable
 * se queda sin gastar»): its account is a Max or Ultra with opusRoom below
 * 0, so its general weekly will reach 100 % with the reserved model unspent,
 * and another Max or Ultra, read whole, able to run it and with a free seat,
 * has at least `roomMoveGap` points more; the best of those by rank. With a
 * sibling at work only below ROOM_MOVE_WITH_SIBLINGS and not within
 * stuckMoveMinutes of the project's last move. Never to a Team seat: the
 * weekly the reserved model spends there is Opus's. Null: stay.
 */
function roomMove(
  current: AccountUsage,
  accounts: AccountUsage[],
  input: PlacementInput,
  options: ChoiceOptions,
): string | null {
  const gap = input.roomMoveGap;
  const share = options.reserveShare;
  if (gap === undefined || share === undefined || !choosingReserve(options))
    return null;
  const reserve = options.reserveModel!;
  const here = opusRoom(current, reserve, share);
  if (here === null || here >= 0) return null;
  if (
    input.projectSeated === true &&
    (here >= ROOM_MOVE_WITH_SIBLINGS || input.movedRecently === true)
  )
    return null;
  const ahead = accounts.filter((a) => {
    if (a.name === input.currentAccount) return false;
    const room = opusRoom(a, reserve, share);
    return room !== null && room >= here + gap;
  });
  return chooseSeated(ahead, options, input.freeSeats)?.account ?? null;
}

/** The account a project would best run on now, for the thread header. */
export function bestAccount(
  accounts: AccountUsage[],
  preferredModel: string,
  now: number,
  reserveModel?: string,
  /** Set: only an account with a free seat (see chooseSeated). */
  freeSeats?: (account: string) => number,
  /** Set for background work (see ChoiceOptions.savedForUser). */
  savedForUser?: (account: string) => boolean,
  /** See ChoiceOptions.reserveSpareUpTo. */
  reserveSpareUpTo?: number,
  /** See ChoiceOptions.reserveShare. */
  reserveShare?: number,
): string | null {
  return (
    chooseSeated(
      accounts.map((a) => settle(a, now)),
      { preferredModel, reserveModel, savedForUser, reserveSpareUpTo, reserveShare },
      freeSeats,
    )?.account ?? null
  );
}

/**
 * Where a project should run before a turn. A new project goes to the best
 * account (the same choice a switch makes); a known one is moved only when
 * its account is MEASURED unable to run, so a project the user pinned by
 * hand stays put while it works. An unmeasured account (or one whose answer
 * lacked a window and measured none full), or no other account able to run, keeps the project: the
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
  const accounts = input.accounts
    .filter((a) => !markedOut(input, a.name))
    .map((a) => settle(a, input.now));
  const options = {
    preferredModel: input.preferredModel,
    reserveModel: input.reserveModel,
    reserveSpareUpTo: input.reserveSpareUpTo,
    reserveShare: input.reserveShare,
    opusOverflowRoom: input.opusOverflowRoom,
    noTeamTakes: input.noTeamTakes,
    savedForUser: input.savedForUser,
  };
  if (input.isNew) {
    const choice = chooseSeated(accounts, options, input.freeSeats);
    return choice === null || choice.account === input.currentAccount
      ? { kind: "keep" }
      : { kind: "move", account: choice.account, why: "new-project" };
  }
  // The way home first: it depends on home's measurement, not on the
  // current account's, which may be missing or incomplete (Codex
  // BM-INSPECT-006). Home with no free seat is no way back yet (Astra
  // SEATS-R2-004): what follows decides, as with no excursion. So does
  // home saved for the user, for background work (Codex ULTRA-R01): it is
  // then a last resort, as in any other choice.
  if (
    !reserving(options) &&
    typeof input.excursionFrom === "string" &&
    input.excursionFrom !== input.currentAccount &&
    input.savedForUser?.(input.excursionFrom) !== true
  ) {
    const home = accounts.find((a) => a.name === input.excursionFrom);
    if (
      home !== undefined &&
      home.unknown !== true &&
      isUsable(home) &&
      canRunModel(home, input.preferredModel) &&
      (input.freeSeats === undefined || input.freeSeats(home.name) > 0)
    )
      return { kind: "move", account: home.name, why: "back-from-excursion" };
  }
  const loggedOut = input.currentLoggedOut === true;
  const current = accounts.find((a) => a.name === input.currentAccount);
  // A pick by hand holds for the reserved model and Haiku only: a turn in a
  // model held off the reserve goes to a Team seat or waits, pick or not
  // (Aitor 2026-11-06: «los Opus tienen que salir por Team sí o sí»).
  const pinHolds = input.pinned === true && !holdsForReserve(options);
  if (!loggedOut && (current === undefined || current.unknown === true)) {
    if (
      pinHolds ||
      input.unreadKeepsReserve?.(input.currentAccount) !== true ||
      !holdsForReserve(options)
    )
      return { kind: "keep" };
    // A Team seat spends nothing the reserved model needs, read or not: all
    // the reads down is no reason to wait with one free (code-reviewer r4).
    const elsewhere = chooseTeamsFirst(
      accounts.filter((a) => a.name !== input.currentAccount),
      input,
      options,
    );
    // Kept as one that would spend the reserve: it takes its place in a
    // queue, and what comes later does not overtake it.
    return elsewhere === null
      ? { kind: "keep", why: "current-reserved" }
      : { kind: "move", account: elsewhere.account, why: "current-reserved" };
  }
  // A current account marked by a 429 does not run the turn whatever its
  // read says: the read lags the 429 (Astra r6).
  const runs =
    !loggedOut &&
    current !== undefined &&
    (input.limitedUntil?.(input.currentAccount) ?? null) === null &&
    isUsable(current) &&
    canRunModel(current, input.preferredModel);
  if (runs && (pinHolds || !spendsReservedWeekly(current, options))) {
    // A pick by hand holds the reserved model where it is.
    const forRoom =
      input.pinned === true ? null : roomMove(current, accounts, input, options);
    if (forRoom !== null)
      return { kind: "move", account: forRoom, why: "fable-room" };
    if (
      !pinHolds &&
      input.justMovedHere !== true &&
      spendsReservedWeekly(current, { ...options, reserveSpareUpTo: 0 })
    ) {
      const wanted = input.projectSeats ?? 1;
      const free = input.freeSeats;
      const team = chooseSeated(
        accounts.filter(
          (a) => a.name !== input.currentAccount && a.unknown !== true,
        ),
        { ...options, reserveSpareUpTo: 0 },
        free === undefined
          ? undefined
          : (name) => (free(name) >= wanted ? free(name) : 0),
      );
      if (team !== null)
        return { kind: "move", account: team.account, why: "current-reserved" };
    }
    if (input.seatsFull !== true) return { kind: "keep" };
    const threshold = input.aheadThreshold ?? 0;
    const roomy = accounts.filter(
      (a) =>
        a.name !== input.currentAccount &&
        a.unknown !== true &&
        (threshold <= 0 ||
          fullestWindow(a, input.preferredModel).used < threshold),
    );
    const wanted = input.seatsWanted ?? 1;
    const free = input.freeSeats;
    const pick = (pool: AccountUsage[]) =>
      (wanted > 1 && free !== undefined
        ? chooseSeated(pool, options, (name) => (free(name) >= wanted ? free(name) : 0))
        : null) ??
      (input.seatsWantedOnly === true && wanted > 1
        ? null
        : chooseSeated(pool, options, input.freeSeats));
    // A held model: the Team seats first, measured or not, seats for all or
    // one; a Max out of the reserved model only after (Codex R047-R2-002 and
    // R047-R2-003), and not for seats for all only: the server then asks
    // for one seat, which a Team seat may have.
    // The reserved model with a share set (0.2.48): a Max or Ultra seat
    // first, a Team seat only with none, and not for seats for all: the
    // server then asks for one seat, which a Max or Ultra may have (B4).
    const choice = holdsForReserve(options)
      ? (pick(roomy.filter((a) => !afterTeams(a, options))) ??
        pick(destinationTeamSeats(input)) ??
        (input.seatsWantedOnly === true && wanted > 1 ? null : pick(roomy)))
      : choosingReserve(options) && options.reserveShare !== undefined
        ? (pick(roomy.filter((a) => a.team !== true)) ??
          (input.seatsWantedOnly === true && wanted > 1 ? null : pick(roomy)))
        : pick(roomy);
    return choice === null
      ? { kind: "keep" }
      : { kind: "move", account: choice.account, why: "current-full" };
  }
  const others = accounts.filter((a) => a.name !== input.currentAccount);
  const choice =
    // The reads of a Team seat down are no reason to wait with one free,
    // whatever is known of this account (code-reviewer r5).
    (holdsForReserve(options)
      ? chooseTeamsFirst(others, input, options)
      : chooseSeated(others, options, input.freeSeats)) ??
    // Without a login a turn kept here fails for sure: the reserve gives
    // way, but not for a model held off it (Codex OPUS-001): that turn
    // waits at the checkpoint, and the rescue leaves the project.
    (loggedOut && !holdsForReserve(options)
      ? chooseSeated(
          others,
          {
            preferredModel: input.preferredModel,
            savedForUser: input.savedForUser,
          },
          input.freeSeats,
        )
      : null);
  if (choice === null)
    return runs
      ? { kind: "keep", why: "current-reserved" }
      : loggedOut
        ? { kind: "keep" }
        : { kind: "keep", why: "current-blocked" };
  return {
    kind: "move",
    account: choice.account,
    why: runs ? "current-reserved" : "current-blocked",
  };
}

/**
 * When a turn in `input.preferredModel` that decidePlacement keeps where
 * it spends the reserved model's weekly (`current-reserved`) can run
 * somewhere that spares it: the earliest other account that runs the
 * model then and does not keep the reserve as the turn would be sent (a
 * Team seat; a Max account out of the reserved model), with when; `at` is
 * 0 when one can now (it lacks a free seat). Null when none will: every
 * other account keeps the reserve, is locked, or has no known reset.
 * Aitor 2026-11-03 («Esperar siempre»): such a turn waits for it, rather
 * than spend a Max account's weekly the reserved model and the Opus work
 * inside its threads need.
 */
/**
 * For a model held off the reserve: a measured account that is no Max out of
 * the reserved model (see afterTeams), then a Team seat not fully measured,
 * then a Max out of the reserved model until its weekly resets (Codex
 * R047-003: the unread Team seats came after any measured choice).
 */
function chooseTeamsFirst(
  measured: AccountUsage[],
  input: PlacementInput,
  options: ChoiceOptions,
): Choice | null {
  return (
    chooseSeated(
      measured.filter((a) => !afterTeams(a, options)),
      options,
      input.freeSeats,
    ) ??
    chooseSeated(destinationTeamSeats(input), options, input.freeSeats) ??
    chooseSeated(measured, options, input.freeSeats)
  );
}

/**
 * The Team seats not fully measured, as accounts: nothing they spend is what
 * the reserve needs. What an incomplete answer did say still counts (Astra
 * FINAL-002, FINAL-R8-002); only a window it left out reads as free.
 */
/** The unread Team seats a placement may move to: none marked (see PlacementInput.limitedUntil). */
function destinationTeamSeats(input: PlacementInput): AccountUsage[] {
  return unreadTeamSeats(input).filter((a) => !markedOut(input, a.name));
}

/** `name` is not the current account and a mark keeps it out (see PlacementInput.limitedUntil). */
function markedOut(
  input: Pick<PlacementInput, "currentAccount" | "limitedUntil">,
  name: string,
): boolean {
  return name !== input.currentAccount && (input.limitedUntil?.(name) ?? null) !== null;
}

export function unreadTeamSeats(
  input: Pick<PlacementInput, "accounts" | "unreadTeams" | "currentAccount" | "now">,
): AccountUsage[] {
  const known = (window: UsageWindow | undefined): UsageWindow =>
    window === undefined || window.missing === true
      ? { usedPercent: 0, resetsAt: null }
      : window;
  return (input.unreadTeams ?? [])
    .filter((name) => name !== input.currentAccount)
    .map((name) => {
      const found = input.accounts.find((a) => a.name === name);
      const read = found === undefined ? undefined : settle(found, input.now);
      return {
        name,
        blocked: false,
        session: known(read?.session),
        weekly: known(read?.weekly),
        models: read?.models ?? {},
        team: true as const,
      };
    });
}

export function reserveWait(
  input: PlacementInput,
): { account: string; at: number } | null {
  const known = new Set(
    input.accounts.filter((a) => a.unknown !== true).map((a) => a.name),
  );
  const options = {
    preferredModel: input.preferredModel,
    reserveModel: input.reserveModel,
    reserveSpareUpTo: input.reserveSpareUpTo,
    reserveShare: input.reserveShare,
    opusOverflowRoom: input.opusOverflowRoom,
    noTeamTakes: input.noTeamTakes,
  };
  // At the same time, a Team seat before a Max out of the reserved model
  // (Codex R047-R2-004).
  let earliest: { account: string; at: number; late: boolean } | null = null;
  // A Team seat known by its login only is one to wait for too: in its queue,
  // what comes later does not overtake the turn (Astra IR5-002).
  for (const raw of [
    ...input.accounts,
    ...unreadTeamSeats(input).filter((a) => !known.has(a.name)),
  ]) {
    if (raw.name === input.currentAccount) continue;
    const account = settle(raw, input.now);
    const free = freeAt(account, input.preferredModel);
    if (free === null) continue;
    // A marked account frees no sooner than its mark ends.
    const at = Math.max(free, input.limitedUntil?.(raw.name) ?? free);
    // As in decideSwitch: judged as the account will be when the turn is
    // sent, a Max account whose reserved window resets keeps it again.
    const sendBy = Math.max(at, input.now) + RESET_BUFFER_MS + RESET_JITTER_MS;
    if (spendsReservedWeekly(settle(account, sendBy), options)) continue;
    const late = afterTeams(account, options);
    if (
      earliest === null ||
      at < earliest.at ||
      (at === earliest.at &&
        (late !== earliest.late ? !late : account.name < earliest.account))
    )
      earliest = { account: account.name, at, late };
  }
  return earliest === null ? null : { account: earliest.account, at: earliest.at };
}

/**
 * The account a turn placed as `input` runs on (see decidePlacement): the
 * one the placement moves the project to, or the one it keeps it on when
 * that account runs the turn's model without spending the reserve
 * (chooseAccount: the Max accounts are Fable's). Null when it keeps the
 * project where the turn cannot run so, or where nothing is known of it.
 */
export function placedOn(input: PlacementInput): string | null {
  const decision = decidePlacement(input);
  if (decision.kind === "move") return decision.account;
  return (
    chooseAccount(
      input.accounts
        .filter((a) => a.name === input.currentAccount)
        .map((a) => settle(a, input.now)),
      {
        preferredModel: input.preferredModel,
        reserveModel: input.reserveModel,
        reserveSpareUpTo: input.reserveSpareUpTo,
        reserveShare: input.reserveShare,
        opusOverflowRoom: input.opusOverflowRoom,
        noTeamTakes: input.noTeamTakes,
      },
    )?.account ?? null
  );
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
  /** See ChoiceOptions.reserveSpareUpTo. */
  reserveSpareUpTo?: number;
  /** See ChoiceOptions.reserveShare. */
  reserveShare?: number;
  /** See ChoiceOptions.opusOverflowRoom. */
  opusOverflowRoom?: number;
  /** See ChoiceOptions.noTeamTakes. */
  noTeamTakes?: (model: string) => boolean;
  /** Share of a window (session, weekly or the preferred model's) at which the project moves ahead of the limit. */
  threshold: number;
  /** Seats free on an account: ahead of the limit, only an account with one is a target. */
  freeSeats?: (account: string) => number;
  /** Set for background work: the target goes behind the accounts saved for the user (see ChoiceOptions.savedForUser). */
  savedForUser?: (account: string) => boolean;
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
    reserveSpareUpTo: input.reserveSpareUpTo,
    reserveShare: input.reserveShare,
    opusOverflowRoom: input.opusOverflowRoom,
    noTeamTakes: input.noTeamTakes,
    freeSeats: input.freeSeats,
    savedForUser: input.savedForUser,
  });
  return choice === null
    ? { kind: "keep" }
    : { kind: "move", account: choice.account, used, window };
}
