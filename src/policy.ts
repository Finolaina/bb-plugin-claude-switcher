// Account choice policy. A pure port of the rules the author's shell account
// switcher applies, so both tools pick the same account.
//
// The three Claude Code limits are NOT interchangeable: the 5-hour session,
// the 7-day weekly and the 7-day per-model windows reset on their own clocks.
// An account is usable only while session and weekly are both under 100 %;
// with a preferred model, only accounts that can still run it are chosen.

export interface UsageWindow {
  usedPercent: number;
  /** Epoch milliseconds, or null when the provider gave no reset. */
  resetsAt: number | null;
  /**
   * The provider reported no such window at all: a Team seat's general
   * weekly (measured 2026-10-11: session and per-model windows only), or
   * the session of an Ultra account without the 5-hour window (measured
   * 2026-10-30: five_hour null, weekly_all only). Set
   * only by the usage parser; a window whose reset merely passed is not
   * absent, it is empty until the next measurement.
   */
  absent?: true;
}

export interface AccountUsage {
  name: string;
  /** The provider reported a lock (locked_reason) or the data is unusable. */
  blocked: boolean;
  /** Set when a session or weekly window was missing from the answer: `blocked` then means "unknown", not "out". */
  unknown?: true;
  session: UsageWindow;
  weekly: UsageWindow;
  /** Per-model weekly windows keyed by display name ("Fable", "Opus"...). */
  models: Record<string, UsageWindow>;
}

export interface ChoiceOptions {
  /** Model display name as the usage API reports it; "" = any model. Case-insensitive. */
  preferredModel: string;
  /**
   * The model kept for its own threads (the configured preferred model).
   * When choosing for another named model, accounts that can no longer run
   * it come first, so a turn sent with Opus does not spend the Fable of an
   * account that still has it. "", unset, or the same model = no effect.
   */
  reserveModel?: string;
  /**
   * Seats free on an account (see src/seats.ts); set, an account with none
   * is left out, and the rest keep their order. Unset = seats do not count.
   */
  freeSeats?: (account: string) => number;
  /**
   * Set for background work in the reserved model only (a thread another
   * thread, an automation or a plugin opened): the accounts saved for the
   * user (see src/pace.ts, fableRoom) are left out. No other account: the
   * work goes down to Opus or waits, it never runs there (Aitor, 2026-10-31:
   * "nunca sigue en Fable en otra Ultra porque hay"). Unset = the user's own
   * threads, which may spend all of it.
   */
  savedForUser?: (account: string) => boolean;
}

export interface Choice {
  account: string;
  model: string;
}

const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

export function isUsable(account: AccountUsage): boolean {
  return (
    !account.blocked &&
    account.session.usedPercent < 100 &&
    account.weekly.usedPercent < 100
  );
}

/** The account's window for `model`, matched case-insensitively; undefined when it has none or no model is given. */
export function modelWindow(
  account: AccountUsage,
  model: string,
): UsageWindow | undefined {
  if (model === "") return undefined;
  const wanted = model.toLowerCase();
  for (const [name, window] of Object.entries(account.models)) {
    if (name.toLowerCase() === wanted) return window;
  }
  return undefined;
}

/** No row for the model means it counts against the general weekly window. */
export function canRunModel(account: AccountUsage, model: string): boolean {
  const window = modelWindow(account, model);
  return window === undefined || window.usedPercent < 100;
}

/**
 * When the account's room for `model` runs out: the earliest reset among the
 * windows a turn with that model counts against (the general weekly one and
 * the model's own). A Team seat (measured 2026-10-11) has no general weekly
 * reset, only its model window's; a window with no reset binds nothing.
 */
function deadline(account: AccountUsage, model: string): number {
  const resets = [
    account.weekly.resetsAt,
    modelWindow(account, model)?.resetsAt ?? null,
  ].filter((at): at is number => at !== null);
  return resets.length > 0 ? Math.min(...resets) : FAR_FUTURE;
}

/**
 * Whether a turn with `model` on this account counts against no weekly
 * window: the account has no general weekly at all (a Team seat) and no
 * window of the model's own. Only its 5-hour session is spent. A window of
 * the model that exists, settled or not, counts as spent.
 */
export function spendsNoWeekly(account: AccountUsage, model: string): boolean {
  return (
    account.weekly.absent === true && modelWindow(account, model) === undefined
  );
}

/** Whether `options` choose for a model other than the reserved one. */
export function reserving(options: ChoiceOptions): boolean {
  const reserve = options.reserveModel ?? "";
  return (
    reserve !== "" &&
    options.preferredModel !== "" &&
    reserve.toLowerCase() !== options.preferredModel.toLowerCase()
  );
}

/**
 * Whether a turn with `preferredModel` on this account would spend a weekly
 * window the reserved model still needs: the account keeps the reserved
 * model (its window under 100 %, or no window of it: then it counts against
 * the general weekly) and has a general weekly window at all (a Max
 * account; a Team seat has none, measured 2026-10-11). On a Max account the
 * general weekly and Fable's window reset together (measured 2026-10-13),
 * so what another model spends there is Fable's. Such an account is never
 * chosen for another model, not even as the last resort: the turn waits or
 * stays where it is ("the Max accounts are Fable's", 2026-10-13).
 */
export function spendsReservedWeekly(
  account: AccountUsage,
  options: ChoiceOptions,
): boolean {
  return (
    reserving(options) &&
    canRunModel(account, options.reserveModel!) &&
    account.weekly.absent !== true
  );
}

/**
 * The session's quarter: 0 for 0-24 %, 1 for 25-49 %, 2 for 50-74 %, 3 for
 * 75-99 % (100 % is not usable). Measured 9-16 Oct 2026: ordering by the
 * deadline alone sent every new session to the same account until its
 * 5-hour window burned, while accounts with the same model sat idle.
 */
function sessionQuarter(account: AccountUsage): number {
  return Math.floor(account.session.usedPercent / 25);
}

/**
 * Least spent first (Aitor, 2026-10-31): for a turn in the reserved model,
 * how much of the week is gone: the fuller of the model's window and the
 * general weekly, as either stops it. 0 for any other turn, which keeps the
 * session quarter and deadline order. Measured that day: the deadline order
 * kept Fable going on an account at 99 % with another at 0 %, and changing
 * only the resets reversed the choice. Past every percentage on a Team seat.
 */
function weekSpent(account: AccountUsage, options: ChoiceOptions): number {
  if (options.preferredModel === "" || reserving(options)) return 0;
  // A Team seat is for Opus: after every account with a week of its own,
  // and among seats the order of before.
  if (account.weekly.absent === true) return 101;
  return Math.max(
    account.weekly.usedPercent,
    modelWindow(account, options.preferredModel)?.usedPercent ?? 0,
  );
}

function rank(
  account: AccountUsage,
  options: ChoiceOptions,
): [number, number, number, number, number, number] {
  const keepsReserve =
    reserving(options) && canRunModel(account, options.reserveModel!) ? 1 : 0;
  // Among the accounts that keep the reserved model, a turn with another
  // model goes first where it spends no weekly window (a Team seat: only
  // its session), last where it spends the weekly the reserved model needs
  // (a Max account). The accounts already out of the reserve keep their
  // quarter and deadline order: nothing of theirs is spared by choosing
  // a seat.
  const spendsWeekly =
    keepsReserve === 1 && !spendsNoWeekly(account, options.preferredModel)
      ? 1
      : 0;
  return [
    keepsReserve,
    spendsWeekly,
    weekSpent(account, options),
    sessionQuarter(account),
    deadline(account, options.preferredModel),
    account.session.usedPercent,
  ];
}

/**
 * Accounts out of the reserved model first (when reserving), then those
 * that spend no weekly window for the model (Team seats), then, for a turn
 * in the reserved model, the least spent of the week, then the lowest
 * session quarter, then the closest deadline for the model, then lowest
 * session use, then name: never the order measured. Within a quarter what
 * runs out first is spent first; the quarter keeps new sessions from piling
 * on one account until its 5-hour window burns. (The accounts that keep the
 * reserved model AND have a weekly window never get here: see
 * spendsReservedWeekly.)
 */
function sortedByRank(
  accounts: AccountUsage[],
  options: ChoiceOptions,
): AccountUsage[] {
  return [...accounts].sort((a, b) => {
    const [ka, wa, xa, ta, da, sa] = rank(a, options);
    const [kb, wb, xb, tb, db, sb] = rank(b, options);
    if (ka !== kb) return ka - kb;
    if (wa !== wb) return wa - wb;
    if (xa !== xb) return xa - xb;
    if (ta !== tb) return ta - tb;
    if (da !== db) return da - db;
    if (sa !== sb) return sa - sb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function chooseAccount(
  accounts: AccountUsage[],
  options: ChoiceOptions,
): Choice | null {
  const usable = sortedByRank(
    accounts
      .filter(isUsable)
      .filter((a) => canRunModel(a, options.preferredModel))
      .filter((a) => !spendsReservedWeekly(a, options))
      .filter((a) => options.savedForUser?.(a.name) !== true)
      .filter(
        (a) => options.freeSeats === undefined || options.freeSeats(a.name) > 0,
      ),
    options,
  );
  return usable.length > 0
    ? { account: usable[0]!.name, model: options.preferredModel }
    : null;
}
