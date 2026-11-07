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
  /** The answer left this window out: its 100 % is what is not known, not a measure. */
  missing?: true;
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
  /**
   * The login is a Team seat, whatever windows it reports: since November
   * 2026 a Team seat reports a general weekly too (`list --json`, 2026-11-03),
   * so `weekly.absent` no longer tells one. Set where the login is known
   * (measuredAccounts).
   */
  team?: true;
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
   * Set for background work only (a thread another thread, an automation or
   * a plugin opened): the accounts saved for the user, their day's pace at
   * 90 % (see src/pace.ts), go behind every other usable one. Never left
   * out: with no other account, background work still runs there. Unset =
   * the pace does not count (the user's own threads).
   */
  savedForUser?: (account: string) => boolean;
  /**
   * An account that keeps the reserved model still takes a turn in another
   * model while its general weekly and the reserved model's window are both
   * at or under this share (Aitor 2026-11-05, «hay cuota de claude … Tenemos
   * opus!»): it then ranks after every Team seat, so it is used only when
   * none has a free seat. Unset or 0 = never (Aitor 2026-11-03, «Esperar
   * siempre»).
   */
  reserveSpareUpTo?: number;
  /**
   * The general weekly the reserved model spends per point of its own window
   * (see opusRoom). Set, the reserved model ranks by opusRoom in tiers of 10
   * points, a Team seat last, and a model held off the reserve ranks the
   * accounts it may use behind the Team seats by it too (Aitor 2026-11-07,
   * «fable se queda sin gastar»). Unset = the order before 0.2.48.
   */
  reserveShare?: number;
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
 * Whether a turn with `model` on this account spends no weekly the reserved
 * model needs: a Team seat, or an account with no general weekly at all, and
 * no window of the model's own. A window of the model that exists, settled
 * or not, counts as spent.
 */
export function spendsNoWeekly(account: AccountUsage, model: string): boolean {
  return (
    (account.team === true || account.weekly.absent === true) &&
    modelWindow(account, model) === undefined
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
 * the general weekly) and is a Max account: a Team seat spends nothing the
 * reserved model needs, whether it reports a weekly or not (it reports one
 * since November 2026). On a Max account the
 * general weekly and Fable's window reset together (measured 2026-10-13),
 * so what another model spends there is Fable's. Such an account is never
 * chosen for another model, not even as the last resort: the turn waits or
 * stays where it is ("the Max accounts are Fable's", 2026-10-13). A Team seat
 * never keeps it, also once it reports a weekly: it is where those turns go
 * (Aitor 2026-11-03, «Esperar siempre»: the first free Team seat).
 */
export function spendsReservedWeekly(
  account: AccountUsage,
  options: ChoiceOptions,
): boolean {
  if (!reserving(options) || account.team === true) return false;
  // Aitor 2026-11-06 («los Opus tienen que salir por Team sí o sí»): a model
  // held off the reserve runs on a Team seat only, known as one by its login
  // (`team`). A Max or Ultra account is the reserved model's whatever it has
  // left of it and whatever its margin, also when it reports no weekly
  // (Codex r1 high 3): with no Team seat the turn waits.
  if (reserveSpentTillWeekly(account, options.reserveModel!)) return false;
  if (holdsForReserve(options)) return true;
  if (account.weekly.absent === true) return false;
  return (
    canRunModel(account, options.reserveModel!) &&
    !reserveToSpare(account, options)
  );
}

/**
 * How much later than the reserved model's own window the general weekly may
 * reset and still count as resetting with it (measured 2026-11-06: one Ultra
 * reports Fable at 21:59:59 and its weekly at 22:00:00).
 */
export const RESET_TOGETHER_MS = 10 * 60 * 1_000;

/**
 * Whether the reserved model's own window is spent (100 %) until the general
 * weekly resets with it: what is left of the weekly is lost at that reset,
 * so a turn in another model spends nothing the reserved model needs (Aitor
 * 2026-11-06, «si fable llega al 100 se abre opus en esa cuenta»). Not with
 * either reset unknown or no weekly reported.
 */
export function reserveSpentTillWeekly(
  account: AccountUsage,
  reserve: string,
): boolean {
  const own = modelWindow(account, reserve);
  return (
    own !== undefined &&
    own.usedPercent >= 100 &&
    own.resetsAt !== null &&
    account.weekly.absent !== true &&
    account.weekly.resetsAt !== null &&
    account.weekly.resetsAt <= own.resetsAt + RESET_TOGETHER_MS
  );
}

/**
 * A Max or Ultra account that takes a model held off the reserve only because
 * the reserved model is spent there until its weekly resets: it comes after
 * every Team seat, whatever their session or windows (Codex R047-002), for a
 * Team seat runs both models and a project with threads in each stays put.
 */
export function afterTeams(
  account: AccountUsage,
  options: ChoiceOptions,
): boolean {
  return (
    holdsForReserve(options) &&
    account.team !== true &&
    reserveSpentTillWeekly(account, options.reserveModel!)
  );
}

/**
 * The general weekly a Max or Ultra account has left beyond what its own
 * window of the reserved model still needs: `(100 − weekly) − share ·
 * (100 − reserved)`, in points of the weekly (Aitor 2026-11-07, «se sigue
 * disparando el tema la cuenta semanal y fable se queda sin gastar»).
 * Positive: weekly another model may spend without taking any from the
 * reserved model. Negative: the account reaches 100 % of its weekly with
 * that much left to spend of the reserved model times `share`, lost at the
 * reset. `share` is the weekly the reserved model spends per point of its
 * own window (measured 0.45-0.6 per account, ±40 %, reparto-fable PLAN §0).
 * Null for a Team seat, an incomplete read, no weekly reported, or no window
 * of the reserved model: nothing to weigh.
 */
export function opusRoom(
  account: AccountUsage,
  reserve: string,
  share: number,
): number | null {
  if (
    account.team === true ||
    account.unknown === true ||
    account.weekly.absent === true
  )
    return null;
  const own = modelWindow(account, reserve);
  if (own === undefined) return null;
  return 100 - account.weekly.usedPercent - share * (100 - own.usedPercent);
}

/**
 * The account keeps enough of the reserved model's weekly for a turn in
 * another model to run there (see ChoiceOptions.reserveSpareUpTo).
 */
export function reserveToSpare(
  account: AccountUsage,
  options: ChoiceOptions,
): boolean {
  const upTo = options.reserveSpareUpTo ?? 0;
  return (
    upTo > 0 &&
    account.weekly.usedPercent <= upTo &&
    (modelWindow(account, options.reserveModel ?? "")?.usedPercent ?? 0) <= upTo
  );
}

/**
 * Whether a turn with `preferredModel` is held off every account where it
 * would spend the reserved model's weekly, rather than run there as the
 * last resort (Aitor 2026-11-03, «Esperar siempre»): any model other than
 * the reserved one but Haiku, which spends little and runs the small
 * threads (titles, the cache's ticks) that would stop for hours.
 */
export function holdsForReserve(options: ChoiceOptions): boolean {
  return reserving(options) && !/^haiku$/i.test(options.preferredModel);
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

/** Whether `options` choose for the reserved model itself. */
export function choosingReserve(options: ChoiceOptions): boolean {
  const reserve = options.reserveModel ?? "";
  return (
    reserve !== "" &&
    reserve.toLowerCase() === options.preferredModel.toLowerCase()
  );
}

/** Width of an opusRoom tier, in points of the weekly (reparto-fable PLAN §B2). */
export const ROOM_TIER = 10;

/**
 * The account's opusRoom tier, lowest first: −floor(room / ROOM_TIER), so a
 * room of 46 comes before one of 9.9 and a negative one after both; within
 * a tier the quarter and the deadline decide. 0 (as a room of 0-9.9) when
 * nothing ranks by room: no share, a model it does not apply to, or no room
 * known for the account.
 */
function roomTier(account: AccountUsage, options: ChoiceOptions): number {
  const share = options.reserveShare;
  if (share === undefined) return 0;
  if (!choosingReserve(options) && !holdsForReserve(options)) return 0;
  const room = opusRoom(account, options.reserveModel!, share);
  return room === null ? 0 : -Math.floor(room / ROOM_TIER);
}

function rank(
  account: AccountUsage,
  options: ChoiceOptions,
): [number, number, number, number, number, number, number, number, number] {
  const saved = options.savedForUser?.(account.name) === true ? 1 : 0;
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
  // After every Team seat comes first, also before the day's pace (Codex
  // R047-R2-001): it only ever sets a held model apart.
  // The reserved model on a Team seat spends the weekly Opus runs on: last
  // (reparto-fable PLAN §A row 2), and only with a share set.
  const reserveOnTeam =
    options.reserveShare !== undefined &&
    choosingReserve(options) &&
    account.team === true
      ? 1
      : 0;
  return [
    afterTeams(account, options) ? 1 : 0,
    saved,
    keepsReserve,
    spendsWeekly,
    reserveOnTeam,
    roomTier(account, options),
    sessionQuarter(account),
    deadline(account, options.preferredModel),
    account.session.usedPercent,
  ];
}

/**
 * For background work, the accounts saved for the user last (see
 * savedForUser). Then accounts out of the reserved model first (when reserving), then those
 * that spend no weekly window for the model (Team seats), then (with a
 * share set, see ChoiceOptions.reserveShare) a Team seat last for the
 * reserved model and the opusRoom tier, then the lowest
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
    const [xa, va, ka, wa, ea, ra, ta, da, sa] = rank(a, options);
    const [xb, vb, kb, wb, eb, rb, tb, db, sb] = rank(b, options);
    if (xa !== xb) return xa - xb;
    if (va !== vb) return va - vb;
    if (ka !== kb) return ka - kb;
    if (wa !== wb) return wa - wb;
    if (ea !== eb) return ea - eb;
    if (ra !== rb) return ra - rb;
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
      .filter(
        (a) => options.freeSeats === undefined || options.freeSeats(a.name) > 0,
      ),
    options,
  );
  return usable.length > 0
    ? { account: usable[0]!.name, model: options.preferredModel }
    : null;
}
