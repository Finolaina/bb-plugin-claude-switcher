// Seats per account: how many threads may run turns on one account at once.
//
// The plugin places a whole project on an account, and every thread of the
// project runs there. Opened by the dozen, threads all land on the account
// with the most room and empty its 5-hour window in minutes (Optimizador,
// 2026-10-29: 7 of 8 accounts at 100% at once). A seat is a thread's right
// to start a turn on an account; with none free the thread's message waits
// in the account's queue, first come first served, and enters as seats
// free.
//
// Everything here is synchronous, on purpose: no method awaits, so two
// dispatches can never interleave between the check of a free seat and its
// reservation. That is the lock; keep it that way (no promise in here).
import type { AccountKind } from "./accounts.js";

export type SeatState = "running" | "reserved";

export interface SeatSettings {
  /** Threads at once on a Max account; 0 = no limit. */
  seatsMax: number;
  /** Threads at once on a Team seat; 0 = no limit. */
  seatsTeam: number;
}

/**
 * An account's seats: by its kind, and when the kind is unknown by its
 * windows (the provider reports no general weekly window for a Team seat).
 * An account without a session (`sessionAbsent`: an Ultra account freed of
 * the 5-hour window, 2026-10-30) is never a Team seat: Ultra has the Max
 * seats (SPEC 2026-10-30 §3).
 * 0 = no limit; a setting below 1 is no limit, a fraction is cut down.
 */
export function capacityFor(
  kind: AccountKind | undefined,
  weeklyAbsent: boolean,
  settings: SeatSettings,
  sessionAbsent = false,
): number {
  const team =
    !sessionAbsent && (kind === "team" || (kind !== "max" && weeklyAbsent));
  const n = team ? settings.seatsTeam : settings.seatsMax;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

export interface AccountSeats {
  /** 0 = no limit. */
  capacity: number;
  running: number;
  reserved: number;
  /** Waiting threads, first in line first. */
  queued: string[];
  /** Seats held from outside bb (see holdExternal), by id; only when there is one. */
  external?: { id: string; until: number }[];
}

/** Longest an external hold lasts from its request, whatever its `until` says. */
export const EXTERNAL_MAX_MS = 12 * 60 * 60_000;

/** A seat held from outside bb: a `claude -p` run with the account's CLAUDE_CONFIG_DIR, which bb does not see. */
export interface ExternalHold {
  id: string;
  account: string;
  /** It counts while the clock is before this. */
  until: number;
  /** When it was asked for (or last renewed). */
  at: number;
}

export type HoldResult =
  | { ok: true; until: number; renewed: boolean }
  /** full: no free seat (or one owed to a thread already waiting); past: `until` is not ahead. */
  | { ok: false; reason: "full" | "past" };

interface Seat {
  account: string;
  state: SeatState;
  /** When it was reserved or started. */
  at: number;
}

interface Waiting {
  account: string;
  /** Arrival: the order of the queue, kept when the project moves. */
  since: number;
  seq: number;
  /** The latest time its message asked: one that stops asking is gone. */
  asked: number;
}

export class Seats {
  private readonly seats = new Map<string, Seat>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly external = new Map<string, ExternalHold>();
  private arrivals = 0;

  /**
   * `account` is the seat budget's identity (the login's accountUuid, else
   * the name: Astra SEATS-R08); `changed` hears every change of the seats
   * or the queues (Astra SEATS-R09); `clock` tells when an external hold
   * has ended (read, never awaited).
   */
  constructor(
    private readonly capacity: (account: string) => number,
    private readonly changed: () => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {}

  private taken(account: string): number {
    let n = 0;
    for (const seat of this.seats.values())
      if (seat.account === account) n += 1;
    const now = this.clock();
    for (const hold of this.external.values())
      if (hold.account === account && hold.until > now) n += 1;
    return n;
  }

  /**
   * A seat of `account` held from outside bb until `until` (at most
   * EXTERNAL_MAX_MS from `now`), under `id`. Checked and taken in this one
   * call: nothing can take the seat in between. Taken only with a seat
   * free beyond those owed to the threads already waiting. The same id
   * again renews it: on the same account it keeps its seat, on another it
   * moves there only if one is free there (else it stays as it was).
   */
  holdExternal(
    id: string,
    account: string,
    until: number,
    now: number,
  ): HoldResult {
    if (until <= now) return { ok: false, reason: "past" };
    const end = Math.min(until, now + EXTERNAL_MAX_MS);
    const held = this.external.get(id);
    if (held !== undefined && held.until > now && held.account === account) {
      this.external.set(id, { id, account, until: end, at: now });
      this.changed();
      return { ok: true, until: end, renewed: true };
    }
    if (held !== undefined) this.external.delete(id);
    if (this.free(account) <= this.queue(account).length) {
      if (held !== undefined) this.external.set(id, held);
      return { ok: false, reason: "full" };
    }
    this.external.set(id, { id, account, until: end, at: now });
    this.changed();
    return { ok: true, until: end, renewed: held !== undefined };
  }

  /** The external hold `id` ends now: its account, or null when there was none (or it had ended). */
  releaseExternal(id: string): string | null {
    const held = this.external.get(id);
    if (held === undefined) return null;
    this.external.delete(id);
    this.changed();
    // One already ended was not there any more.
    return held.until > this.clock() ? held.account : null;
  }

  /** The external holds still counting, by id. */
  holds(): ExternalHold[] {
    const now = this.clock();
    return [...this.external.values()]
      .filter((h) => h.until > now)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((h) => ({ ...h }));
  }

  /**
   * The holds kept in storage, back after a reload: granted then, so not
   * checked against the seats again; the ended ones are left out and none
   * lasts beyond EXTERNAL_MAX_MS from its request.
   */
  restoreHolds(stored: readonly ExternalHold[], now: number): void {
    for (const h of stored) {
      const until = Math.min(h.until, h.at + EXTERNAL_MAX_MS);
      if (until > now) this.external.set(h.id, { ...h, until });
    }
    this.changed();
  }

  /** Seats free on the account; Infinity when it has no limit. */
  free(account: string): number {
    const capacity = this.capacity(account);
    return capacity > 0 ? capacity - this.taken(account) : Infinity;
  }

  /**
   * A seat for the thread's turn on `account`: true when it has one (free,
   * or already its own there); false when it must wait, and then it is in
   * the account's queue, in its order of arrival. A thread waiting on
   * another account (its project moved) waits here instead, keeping its
   * place in time; a seat it held elsewhere is given up.
   */
  reserve(threadId: string, account: string, now: number): boolean {
    const seat = this.seats.get(threadId);
    if (seat?.account === account) return true;
    if (seat !== undefined) this.seats.delete(threadId);
    const waiting = this.waiting.get(threadId) ?? {
      account,
      since: now,
      seq: this.arrivals++,
      asked: now,
    };
    waiting.account = account;
    waiting.asked = now;
    this.waiting.set(threadId, waiting);
    const ahead = this.queue(account).findIndex((q) => q.threadId === threadId);
    this.changed();
    if (this.free(account) <= ahead) return false;
    this.waiting.delete(threadId);
    this.seats.set(threadId, { account, state: "reserved", at: now });
    return true;
  }

  /**
   * The thread's turn started on `account`: its seat runs. Counted also
   * without a reservation (a turn sent past the checkpoint spends the
   * account all the same); `over` says it took more than the capacity.
   */
  confirm(threadId: string, account: string, now: number): { over: boolean } {
    this.seats.delete(threadId);
    this.waiting.delete(threadId);
    const capacity = this.capacity(account);
    const over = capacity > 0 && this.taken(account) >= capacity;
    this.seats.set(threadId, { account, state: "running", at: now });
    this.changed();
    return { over };
  }

  /** The thread's turn ended, or the thread went: its seat or its place in line goes. The account it was on, or null. */
  release(threadId: string): string | null {
    const account =
      this.seats.get(threadId)?.account ??
      this.waiting.get(threadId)?.account ??
      null;
    this.seats.delete(threadId);
    this.waiting.delete(threadId);
    if (account !== null) this.changed();
    return account;
  }

  /**
   * Reservations older than `ttl` are freed (their turn never started), and
   * threads that have not asked for `ttl` leave the queue (their message is
   * gone). The accounts whose reservations were freed, by name.
   */
  expire(now: number, ttl: number): string[] {
    const freed = new Set<string>();
    for (const [threadId, seat] of this.seats)
      if (seat.state === "reserved" && now - seat.at >= ttl) {
        this.seats.delete(threadId);
        freed.add(seat.account);
      }
    for (const [id, hold] of this.external)
      if (hold.until <= now) {
        this.external.delete(id);
        freed.add(hold.account);
      }
    let left = false;
    for (const [threadId, waiting] of this.waiting)
      if (now - waiting.asked >= ttl) {
        this.waiting.delete(threadId);
        left = true;
      }
    if (left || freed.size > 0) this.changed();
    return [...freed].sort();
  }

  /** With a seat free on `account`, reserves it for the first in its queue and names that thread; else null. */
  admitNext(account: string, now: number): string | null {
    if (this.free(account) <= 0) return null;
    const first = this.queue(account)[0];
    if (first === undefined) return null;
    this.waiting.delete(first.threadId);
    this.seats.set(first.threadId, { account, state: "reserved", at: now });
    this.changed();
    return first.threadId;
  }

  /**
   * The budget known as `from` is `to` from now on (a login's accountUuid
   * found for an account counted by name): its seats and queue go along.
   */
  rekey(from: string, to: string): void {
    let moved = false;
    for (const entry of [
      ...this.seats.values(),
      ...this.waiting.values(),
      ...this.external.values(),
    ])
      if (entry.account === from) {
        entry.account = to;
        moved = true;
      }
    if (moved) this.changed();
  }

  /** admitNext on every account until no seat or no one is left; the threads admitted. */
  admitAll(now: number): string[] {
    const admitted: string[] = [];
    const accounts = new Set([...this.waiting.values()].map((w) => w.account));
    for (const account of accounts)
      for (
        let next = this.admitNext(account, now);
        next !== null;
        next = this.admitNext(account, now)
      )
        admitted.push(next);
    return admitted;
  }

  /** The account's queue, first in line first, positions from 1. */
  queue(account: string): { threadId: string; position: number }[] {
    return [...this.waiting]
      .filter(([, w]) => w.account === account)
      .sort(([, a], [, b]) => a.since - b.since || a.seq - b.seq)
      .map(([threadId], i) => ({ threadId, position: i + 1 }));
  }

  /** Where the thread waits, or null when it is in no queue. */
  position(threadId: string): { account: string; position: number } | null {
    const waiting = this.waiting.get(threadId);
    if (waiting === undefined) return null;
    const position =
      this.queue(waiting.account).find((q) => q.threadId === threadId)
        ?.position ?? 0;
    return { account: waiting.account, position };
  }

  /** The thread's seat, or null. */
  seatOf(threadId: string): { account: string; state: SeatState } | null {
    const seat = this.seats.get(threadId);
    return seat === undefined
      ? null
      : { account: seat.account, state: seat.state };
  }

  /** Per account: capacity, seats taken and queue; `accounts` are listed even when nothing is on them. */
  snapshot(accounts: readonly string[] = []): Record<string, AccountSeats> {
    const names = new Set(accounts);
    for (const seat of this.seats.values()) names.add(seat.account);
    for (const waiting of this.waiting.values()) names.add(waiting.account);
    const holds = this.holds();
    for (const hold of holds) names.add(hold.account);
    const out: Record<string, AccountSeats> = {};
    for (const name of [...names].sort()) {
      let running = 0;
      let reserved = 0;
      for (const seat of this.seats.values())
        if (seat.account === name) {
          if (seat.state === "running") running += 1;
          else reserved += 1;
        }
      out[name] = {
        capacity: this.capacity(name),
        running,
        reserved,
        queued: this.queue(name).map((q) => q.threadId),
      };
      const external = holds
        .filter((h) => h.account === name)
        .map((h) => ({ id: h.id, until: h.until }));
      if (external.length > 0) out[name]!.external = external;
    }
    return out;
  }
}
