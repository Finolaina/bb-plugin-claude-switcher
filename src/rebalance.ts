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
 * `spread` above the one with fewest, and never fewer than the projects
 * `fixed` there (Codex PLAZAS-003). Counted one project at a time, from
 * the fixed ones up: the account with the fewest projects for its room
 * takes it, unless that would leave it more than `spread` above the one
 * with fewest, or one sits more than `spread` below the one with most:
 * then the one with fewest takes it (the fixed projects raise the others'
 * floor: Codex PLAZAS-R2-002). Over `spread` only when the fixed projects
 * alone are (and by one at most with a `spread` of 0).
 */
export function rebalanceTargets(
  accounts: readonly RebalanceAccount[],
  total: number,
  spread: number,
  fixed: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const count = accounts.map((a) => fixed.get(a.name) ?? 0);
  const rooms = accounts.map(room);
  const tie = (i: number, j: number) =>
    accounts[i]!.load - accounts[j]!.load ||
    (accounts[i]!.name < accounts[j]!.name ? -1 : 1);
  const all = accounts.map((_, i) => i);
  for (let left = total - count.reduce((a, b) => a + b, 0); left > 0; left -= 1) {
    const most = Math.max(...count);
    const fewest = Math.min(...count);
    const lowest = [...all].sort((i, j) => count[i]! - count[j]! || tie(i, j));
    const best = [...all].sort(
      (i, j) =>
        (count[i]! + 1) / rooms[i]! - (count[j]! + 1) / rooms[j]! || tie(i, j),
    )[0]!;
    // The lowest takes it while one is too far below the most, or while
    // the best for its room would end too far above the fewest.
    const pick =
      count[lowest[0]!]! < most - spread || count[best]! + 1 > fewest + spread
        ? lowest[0]!
        : best;
    count[pick]! += 1;
  }
  return new Map(accounts.map((a, i) => [a.name, count[i]!]));
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
  const fixed = new Map<string, number>();
  for (const p of mine)
    if (!p.movable) fixed.set(p.account, (fixed.get(p.account) ?? 0) + 1);
  const target = rebalanceTargets(accounts, mine.length, spread, fixed);
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
