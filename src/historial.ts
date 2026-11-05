// Seat history of the last week, in the plugin's own SQLite database (Aitor
// 2026-11-05: «sobre lo del switcher que guarde los últimos días de
// historial, pues vale»). The samples used to go to one kv row, and from the
// third day on it passed bb's 256 KB limit: every store failed (662 failures
// in the log from 2026-11-03 to 2026-11-05) and a reload kept the last good
// one. One row per account and measurement here, pruned at 7 days.

/** A week, both ends kept. */
export const HISTORIAL_DIAS = 7;
export const HISTORIAL_MS = HISTORIAL_DIAS * 24 * 60 * 60_000;

/** Append-only: bb's migrate records each statement by its index. */
export const HISTORIAL_MIGRATIONS = [
  `CREATE TABLE seat_samples (
    at INTEGER NOT NULL,
    account TEXT NOT NULL,
    running INTEGER NOT NULL,
    reserved INTEGER NOT NULL,
    external INTEGER,
    waiting INTEGER,
    capacity INTEGER,
    session REAL NOT NULL,
    weekly REAL,
    session_resets INTEGER,
    weekly_resets INTEGER,
    PRIMARY KEY (account, at)
  )`,
  `CREATE TABLE stuck (
    at INTEGER NOT NULL,
    thread TEXT NOT NULL,
    account TEXT NOT NULL,
    model TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    free TEXT NOT NULL,
    project_busy INTEGER NOT NULL,
    line TEXT NOT NULL
  )`,
  `CREATE INDEX stuck_at ON stuck (at)`,
];

/** What this module needs of a better-sqlite3 handle. */
export interface HistorialDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface SampleRow {
  at: number;
  account: string;
  running: number;
  /** Seats reserved for bb threads about to start. */
  reserved: number;
  /** Seats held from outside bb (reserve); null in samples kept before 0.2.43. */
  external: number | null;
  /** Threads waiting for a seat on it then; null in samples kept before 0.2.43. */
  waiting: number | null;
  /** Its seats then (0 = no limit); null in samples kept before 0.2.43. */
  capacity: number | null;
  session: number;
  /** Null: no general weekly window (a Team seat before November 2026). */
  weekly: number | null;
  sessionResets: number | null;
  weeklyResets: number | null;
}

export interface StuckRow {
  at: number;
  thread: string;
  account: string;
  model: string;
  minutes: number;
  /** The accounts with a free seat that could run it then. */
  free: string[];
  /** Another thread of its project was at work. */
  projectBusy: boolean;
  /** The STUCK line of the log, with its why. */
  line: string;
}

/** One row per account and measurement: the same one again changes nothing. */
export function addSample(db: HistorialDb, r: SampleRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO seat_samples
      (at, account, running, reserved, external, waiting, capacity, session, weekly, session_resets, weekly_resets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.at,
    r.account,
    r.running,
    r.reserved,
    r.external,
    r.waiting,
    r.capacity,
    r.session,
    r.weekly,
    r.sessionResets,
    r.weeklyResets,
  );
}

export function addStuck(db: HistorialDb, r: StuckRow): void {
  db.prepare(
    `INSERT INTO stuck (at, thread, account, model, minutes, free, project_busy, line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.at,
    r.thread,
    r.account,
    r.model,
    r.minutes,
    JSON.stringify(r.free),
    r.projectBusy ? 1 : 0,
    r.line,
  );
}

/** Rows older than HISTORIAL_MS before `now` go (exactly 7 days old stays). */
export function prune(db: HistorialDb, now: number): void {
  const cut = now - HISTORIAL_MS;
  db.prepare(`DELETE FROM seat_samples WHERE at < ?`).run(cut);
  db.prepare(`DELETE FROM stuck WHERE at < ?`).run(cut);
}

interface SampleDbRow {
  at: number;
  account: string;
  running: number;
  reserved: number;
  external: number | null;
  waiting: number | null;
  capacity: number | null;
  session: number;
  weekly: number | null;
  session_resets: number | null;
  weekly_resets: number | null;
}

/** Samples from `since` on, oldest first, by account. */
export function readSamples(db: HistorialDb, since: number): SampleRow[] {
  return (
    db
      .prepare(`SELECT * FROM seat_samples WHERE at >= ? ORDER BY at, account`)
      .all(since) as SampleDbRow[]
  ).map((r) => ({
    at: r.at,
    account: r.account,
    running: r.running,
    reserved: r.reserved,
    external: r.external,
    waiting: r.waiting,
    capacity: r.capacity,
    session: r.session,
    weekly: r.weekly,
    sessionResets: r.session_resets,
    weeklyResets: r.weekly_resets,
  }));
}

interface StuckDbRow {
  at: number;
  thread: string;
  account: string;
  model: string;
  minutes: number;
  free: string;
  project_busy: number;
  line: string;
}

export function readStuck(db: HistorialDb, since: number): StuckRow[] {
  return (
    db
      .prepare(`SELECT * FROM stuck WHERE at >= ? ORDER BY at`)
      .all(since) as StuckDbRow[]
  ).map((r) => ({
    at: r.at,
    thread: r.thread,
    account: r.account,
    model: r.model,
    minutes: r.minutes,
    free: JSON.parse(r.free) as string[],
    projectBusy: r.project_busy === 1,
    line: r.line,
  }));
}

const MADRID = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** «2026-11-05 12:10», Madrid's clock. */
function madrid(at: number): string {
  return MADRID.format(at);
}

/**
 * `history --dias N`: the STUCK rows, then one row per Madrid hour and
 * account: seats taken at most of its seats, threads waiting at most, and
 * the last session and weekly % measured in it.
 */
export function historyText(o: {
  samples: readonly SampleRow[];
  stuck: readonly StuckRow[];
  dias: number;
  now: number;
}): string {
  const since = o.now - o.dias * 24 * 60 * 60_000;
  const lines = [
    `Seats and stuck threads, last ${o.dias} day${o.dias === 1 ? "" : "s"} (Europe/Madrid)`,
  ];
  const stuck = o.stuck.filter((r) => r.at >= since);
  lines.push("", `Stuck threads: ${stuck.length}`);
  for (const r of stuck) lines.push(`${madrid(r.at)}\t${r.line}`);
  const samples = o.samples.filter((r) => r.at >= since);
  if (samples.length === 0) {
    lines.push("", `no samples in the last ${o.dias} days`);
    return `${lines.join("\n")}\n`;
  }
  const hours = new Map<
    string,
    {
      taken: number;
      capacity: number | null;
      waiting: number | null;
      session: number;
      weekly: number | null;
    }
  >();
  for (const r of samples) {
    const key = `${madrid(r.at).slice(0, 13)}:00\t${r.account}`;
    const was = hours.get(key);
    const taken = r.running + r.reserved + (r.external ?? 0);
    hours.set(key, {
      taken: Math.max(was?.taken ?? 0, taken),
      capacity: r.capacity ?? was?.capacity ?? null,
      waiting:
        r.waiting === null
          ? (was?.waiting ?? null)
          : Math.max(was?.waiting ?? 0, r.waiting),
      session: r.session,
      weekly: r.weekly,
    });
  }
  lines.push(
    "",
    "hour\taccount\tseats taken at most\twaiting at most\tsession %\tweekly %",
  );
  for (const [key, h] of hours)
    lines.push(
      `${key}\t${h.taken}/${h.capacity === null ? "?" : h.capacity === 0 ? "no limit" : h.capacity}\t${h.waiting ?? "?"}\t${Math.round(h.session)}\t${h.weekly === null ? "" : Math.round(h.weekly)}`,
    );
  return `${lines.join("\n")}\n`;
}
