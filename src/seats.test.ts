import { describe, expect, it } from "vitest";
import { Seats, capacityFor } from "./seats.js";

const T0 = 1_000_000;

/** Two seats on `a`, one on `b`, none on `free` (no limit). */
function seats() {
  const caps: Record<string, number> = { a: 2, b: 1, free: 0 };
  return new Seats((account) => caps[account] ?? 0);
}

describe("capacityFor", () => {
  it("gives a Max account the Max seats and a Team seat the Team seats", () => {
    const settings = { seatsMax: 4, seatsTeam: 2 };
    expect(capacityFor("max", false, settings)).toBe(4);
    expect(capacityFor("team", false, settings)).toBe(2);
  });

  it("takes an unknown kind as Team when the provider reports no weekly window, Max otherwise", () => {
    const settings = { seatsMax: 4, seatsTeam: 2 };
    expect(capacityFor("unknown", true, settings)).toBe(2);
    expect(capacityFor("unknown", false, settings)).toBe(4);
    expect(capacityFor(undefined, true, settings)).toBe(2);
  });

  it("never gives an account without a session (Ultra freed of the 5-hour window) the Team seats", () => {
    const settings = { seatsMax: 4, seatsTeam: 2 };
    expect(capacityFor("team", false, settings, true)).toBe(4);
    expect(capacityFor("unknown", true, settings, true)).toBe(4);
    expect(capacityFor("max", false, settings, true)).toBe(4);
  });

  it("reads 0, a negative or a fraction as no limit or whole seats", () => {
    expect(capacityFor("max", false, { seatsMax: 0, seatsTeam: 2 })).toBe(0);
    expect(capacityFor("max", false, { seatsMax: -3, seatsTeam: 2 })).toBe(0);
    expect(capacityFor("team", false, { seatsMax: 4, seatsTeam: 2.7 })).toBe(2);
  });
});

describe("Seats", () => {
  it("reserves while there is a free seat and queues the thread after that", () => {
    const s = seats();
    expect(s.reserve("t1", "a", T0)).toBe(true);
    expect(s.reserve("t2", "a", T0)).toBe(true);
    expect(s.reserve("t3", "a", T0)).toBe(false);
    expect(s.snapshot().a).toEqual({
      capacity: 2,
      running: 0,
      reserved: 2,
      queued: ["t3"],
    });
    expect(s.position("t3")).toEqual({ account: "a", position: 1 });
  });

  it("gives the last seat to only one of two reservations in a row", () => {
    const s = seats();
    const first = s.reserve("t1", "b", T0);
    const second = s.reserve("t2", "b", T0);
    expect([first, second]).toEqual([true, false]);
    expect(s.snapshot().b!.reserved).toBe(1);
  });

  it("never limits an account whose capacity is 0, but still counts its threads", () => {
    const s = seats();
    for (let i = 0; i < 10; i += 1)
      expect(s.reserve(`t${i}`, "free", T0)).toBe(true);
    expect(s.snapshot().free).toMatchObject({ capacity: 0, reserved: 10 });
  });

  it("lets a thread that already has a seat on the account through again", () => {
    const s = seats();
    s.reserve("t1", "b", T0);
    expect(s.reserve("t1", "b", T0 + 1)).toBe(true);
    s.confirm("t1", "b", T0 + 2);
    expect(s.reserve("t1", "b", T0 + 3)).toBe(true);
    expect(s.snapshot().b).toMatchObject({ running: 1, reserved: 0 });
  });

  it("keeps the queue in order of arrival, whoever asks again first", () => {
    const s = seats();
    s.reserve("t1", "b", T0);
    s.reserve("q1", "b", T0 + 1);
    s.reserve("q2", "b", T0 + 2);
    s.reserve("q3", "b", T0 + 3);
    // Asked again in another order: the queue does not change.
    s.reserve("q3", "b", T0 + 4);
    s.reserve("q1", "b", T0 + 5);
    expect(s.queue("b")).toEqual([
      { threadId: "q1", position: 1 },
      { threadId: "q2", position: 2 },
      { threadId: "q3", position: 3 },
    ]);
  });

  it("does not let a newcomer take a freed seat from the threads already waiting", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    s.reserve("q1", "b", T0 + 1);
    s.release("t1");
    // The seat is free, but q1 waited for it.
    expect(s.reserve("late", "b", T0 + 2)).toBe(false);
    expect(s.reserve("q1", "b", T0 + 3)).toBe(true);
  });

  it("admits the first of the queue when a seat frees", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    s.reserve("q1", "b", T0 + 1);
    s.reserve("q2", "b", T0 + 2);
    expect(s.release("t1")).toBe("b");
    expect(s.admitNext("b", T0 + 3)).toBe("q1");
    expect(s.admitNext("b", T0 + 3)).toBeNull();
    expect(s.snapshot().b).toEqual({
      capacity: 1,
      running: 0,
      reserved: 1,
      queued: ["q2"],
    });
    // The admitted thread's dispatch, asked again, finds its seat.
    expect(s.reserve("q1", "b", T0 + 4)).toBe(true);
  });

  it("takes a waiting thread out of the queue when it is released (archived)", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    s.reserve("q1", "b", T0 + 1);
    s.reserve("q2", "b", T0 + 2);
    expect(s.release("q1")).toBe("b");
    expect(s.queue("b")).toEqual([{ threadId: "q2", position: 1 }]);
    expect(s.position("q1")).toBeNull();
    expect(s.release("nobody")).toBeNull();
  });

  it("frees a reservation whose turn never started and admits the next", () => {
    const s = seats();
    s.reserve("t1", "b", T0);
    s.reserve("q1", "b", T0 + 10);
    expect(s.expire(T0 + 89_999, 90_000)).toEqual([]);
    expect(s.expire(T0 + 90_000, 90_000)).toEqual(["b"]);
    expect(s.snapshot().b!.reserved).toBe(0);
    expect(s.admitNext("b", T0 + 90_000)).toBe("q1");
  });

  it("drops from the queue a thread that stopped asking (its message went)", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    s.reserve("q1", "b", T0);
    s.reserve("q2", "b", T0 + 60_000);
    s.expire(T0 + 90_000, 90_000);
    expect(s.queue("b").map((q) => q.threadId)).toEqual(["q2"]);
  });

  it("never expires a running seat", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    expect(s.expire(T0 + 10 * 90_000, 90_000)).toEqual([]);
    expect(s.snapshot().b!.running).toBe(1);
  });

  it("counts a turn that started without a reservation, even over capacity", () => {
    const s = seats();
    s.reserve("t1", "b", T0);
    expect(s.confirm("t1", "b", T0 + 1)).toEqual({ over: false });
    expect(s.confirm("sneaky", "b", T0 + 2)).toEqual({ over: true });
    expect(s.snapshot().b).toMatchObject({ running: 2, reserved: 0 });
    expect(s.reserve("t2", "b", T0 + 3)).toBe(false);
  });

  it("moves a thread's seat when its project went to another account", () => {
    const s = seats();
    s.reserve("t1", "b", T0);
    expect(s.reserve("t1", "a", T0 + 1)).toBe(true);
    expect(s.snapshot().b).toBeUndefined();
    expect(s.snapshot().a!.reserved).toBe(1);
    s.reserve("w", "b", T0 + 2);
    s.reserve("q", "b", T0 + 3);
    // Queued on b, its project moves to a: it waits there, not on both.
    expect(s.reserve("q", "a", T0 + 4)).toBe(true);
    expect(s.queue("b")).toEqual([]);
  });

  it("starts a running seat on the account its turn runs on, out of any queue", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    s.reserve("q1", "b", T0 + 1);
    s.confirm("q1", "a", T0 + 2);
    expect(s.queue("b")).toEqual([]);
    expect(s.snapshot().a!.running).toBe(1);
  });

  it("lists in the snapshot the accounts asked for, even when nothing is on them", () => {
    const s = seats();
    expect(s.snapshot(["a"])).toEqual({
      a: { capacity: 2, running: 0, reserved: 0, queued: [] },
    });
  });

  it("admits on every account at once (admitAll)", () => {
    const s = seats();
    s.confirm("t1", "b", T0);
    s.confirm("t2", "a", T0);
    s.confirm("t3", "a", T0);
    s.reserve("qa", "a", T0);
    s.reserve("qb", "b", T0);
    s.release("t1");
    s.release("t2");
    expect(s.admitAll(T0 + 1).sort()).toEqual(["qa", "qb"]);
  });
});
