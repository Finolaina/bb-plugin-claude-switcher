// One pass that spreads the projects over the accounts (`bb claude-switcher
// rebalance`). Aitor 2026-11-03: siloeads held 25 projects for its 4 seats
// and the most Fable spent, while joytorm held 9. Each account gets a share
// of the projects by the room left in its weekly, and no account ends more
// than `spread` projects above the one with fewest. A project that is not
// movable (a thread of it at work) stays where it is, and counts there.
// Pure: the plugin reads the accounts and the threads and applies the moves.

export interface RebalanceAccount {
  name: string;
  /** The fuller of the weekly and the preferred model's window, 0-100. */
  load: number;
}

export interface RebalanceProject {
  id: string;
  account: string;
  movable: boolean;
  /** Its latest thread activity (epoch ms): the least recent move first, their prompt cache long gone. */
  lastActive: number;
}

export interface RebalanceMove {
  projectId: string;
  from: string;
  to: string;
}

/** Room left in an account's weekly, never 0: an account at 100 % is not usable, and so not here. */
function room(account: RebalanceAccount): number {
  return Math.max(1, 100 - account.load);
}

/**
 * Projects per account: by the room in its weekly, no account more than
 * `spread` above the one with fewest. Solved in real numbers with a band
 * two narrower, then rounded (each by less than one), so the integers stay
 * within `spread`.
 */
export function rebalanceTargets(
  accounts: readonly RebalanceAccount[],
  total: number,
  spread: number,
): Map<string, number> {
  const width = Math.max(0, spread - 2);
  const rooms = accounts.map(room);
  const sum = rooms.reduce((a, b) => a + b, 0);
  const ideal = rooms.map((r) => (total * r) / sum);
  const banded = (low: number) =>
    ideal.map((x) => Math.min(Math.max(x, low), low + width));
  // The band's floor such that the shares add up to the projects.
  let lo = 0;
  let hi = total;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (banded(mid).reduce((a, b) => a + b, 0) < total) lo = mid;
    else hi = mid;
  }
  const real = banded(hi);
  const whole = real.map(Math.floor);
  let left = total - whole.reduce((a, b) => a + b, 0);
  const order = accounts
    .map((a, i) => ({
      i,
      frac: real[i]! - whole[i]!,
      load: a.load,
      name: a.name,
    }))
    .sort(
      (a, b) =>
        b.frac - a.frac ||
        a.load - b.load ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  for (const o of order) {
    if (left <= 0) break;
    whole[o.i]! += 1;
    left -= 1;
  }
  return new Map(accounts.map((a, i) => [a.name, whole[i]!]));
}

/**
 * The moves that bring each account to its share (see rebalanceTargets):
 * from an account above it, its movable projects least recently active
 * first, to the account furthest below it (the least loaded on a tie).
 * Projects on an account not listed are left out.
 */
export function planRebalance(
  accounts: readonly RebalanceAccount[],
  projects: readonly RebalanceProject[],
  spread: number,
): RebalanceMove[] {
  const names = new Set(accounts.map((a) => a.name));
  const mine = projects.filter((p) => names.has(p.account));
  const target = rebalanceTargets(accounts, mine.length, spread);
  const count = new Map(accounts.map((a) => [a.name, 0]));
  for (const p of mine) count.set(p.account, count.get(p.account)! + 1);
  const load = new Map(accounts.map((a) => [a.name, a.load]));
  const deficit = (name: string) => target.get(name)! - count.get(name)!;
  const moves: RebalanceMove[] = [];
  const movable = mine
    .filter((p) => p.movable)
    .sort((a, b) => a.lastActive - b.lastActive || (a.id < b.id ? -1 : 1));
  for (const p of movable) {
    if (deficit(p.account) >= 0) continue;
    const to = [...names]
      .filter((n) => n !== p.account && deficit(n) > 0)
      .sort(
        (a, b) =>
          deficit(b) - deficit(a) ||
          load.get(a)! - load.get(b)! ||
          (a < b ? -1 : 1),
      )[0];
    if (to === undefined) break;
    moves.push({ projectId: p.id, from: p.account, to });
    count.set(p.account, count.get(p.account)! - 1);
    count.set(to, count.get(to)! + 1);
  }
  return moves;
}
