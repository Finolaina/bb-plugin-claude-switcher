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

function rank(account: AccountUsage): [number, number] {
  return [account.weekly.resetsAt ?? FAR_FUTURE, account.session.usedPercent];
}

/** Closest weekly reset, then lowest session use, then name: never the order measured. */
function sortedByRank(accounts: AccountUsage[]): AccountUsage[] {
  return [...accounts].sort((a, b) => {
    const [ra, sa] = rank(a);
    const [rb, sb] = rank(b);
    if (ra !== rb) return ra - rb;
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
  );
  return usable.length > 0
    ? { account: usable[0]!.name, model: options.preferredModel }
    : null;
}
