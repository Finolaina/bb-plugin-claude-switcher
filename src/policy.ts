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

function reserving(options: ChoiceOptions): boolean {
  const reserve = options.reserveModel ?? "";
  return (
    reserve !== "" &&
    options.preferredModel !== "" &&
    reserve.toLowerCase() !== options.preferredModel.toLowerCase()
  );
}

function rank(
  account: AccountUsage,
  options: ChoiceOptions,
): [number, number, number] {
  const keepsReserve =
    reserving(options) && canRunModel(account, options.reserveModel!) ? 1 : 0;
  return [
    keepsReserve,
    deadline(account, options.preferredModel),
    account.session.usedPercent,
  ];
}

/**
 * Accounts out of the reserved model first (when reserving), then the closest
 * deadline for the model, then lowest session use, then name: never the
 * order measured. What runs out first is spent first.
 */
function sortedByRank(
  accounts: AccountUsage[],
  options: ChoiceOptions,
): AccountUsage[] {
  return [...accounts].sort((a, b) => {
    const [ka, da, sa] = rank(a, options);
    const [kb, db, sb] = rank(b, options);
    if (ka !== kb) return ka - kb;
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
      .filter((a) => canRunModel(a, options.preferredModel)),
    options,
  );
  return usable.length > 0
    ? { account: usable[0]!.name, model: options.preferredModel }
    : null;
}
