import { describe, expect, it } from "vitest";
import {
  STUCK_WAIT_MS,
  atascoLine,
  heldBy,
  heldLong,
  type HeldRow,
} from "./atascos.js";

const NOW = 1_000_000_000;
const row = (over: Partial<HeldRow> = {}): HeldRow => ({
  threadId: "t1",
  model: "opus",
  failureReason: null,
  waitingOn: { kind: "plugin", pluginId: "claude-switcher" },
  ...over,
});

describe("heldBy", () => {
  it("is a live row this plugin holds, and nothing else", () => {
    expect(heldBy(row(), "claude-switcher")).toBe(true);
    expect(
      heldBy(row({ waitingOn: { kind: "plugin", pluginId: "limiter" } }), "claude-switcher"),
    ).toBe(false);
    expect(heldBy(row({ waitingOn: { kind: "time" } }), "claude-switcher")).toBe(false);
    expect(heldBy(row({ waitingOn: { kind: "thread-busy" } }), "claude-switcher")).toBe(false);
    expect(heldBy(row({ waitingOn: null }), "claude-switcher")).toBe(false);
    // Measured in bb's queue, 2026-11-03: an archived thread's row.
    expect(heldBy(row({ failureReason: "Thread is archived" }), "claude-switcher")).toBe(false);
  });
});

describe("heldLong", () => {
  const judged = (rows: HeldRow[], since: Map<string, number>, now = NOW) =>
    heldLong(rows, "claude-switcher", since, now).map((h) => h.threadId);

  it("cuts exactly at 10 minutes", () => {
    expect(STUCK_WAIT_MS).toBe(600_000);
    expect(judged([row()], new Map([["t1", NOW - 599_999]]))).toEqual([]);
    expect(judged([row()], new Map([["t1", NOW - 600_000]]))).toEqual(["t1"]);
  });

  it("does not count a row whose hold it has not seen begin: after a reload, from the next ask", () => {
    expect(judged([row()], new Map())).toEqual([]);
  });

  it("counts a thread once, whatever messages it has queued", () => {
    const since = new Map([["t1", NOW - STUCK_WAIT_MS]]);
    expect(judged([row(), row({ model: "claude-opus-5-5" })], since)).toEqual(["t1"]);
  });
});

describe("atascoLine", () => {
  const base = {
    hilo: "t1",
    cuenta: "team5",
    modelo: "Opus",
    minutos: 12,
    libres: ["team2"],
    proyectoOcupado: false,
  };
  it("says who holds whom, for how long, and who is free", () => {
    expect(atascoLine(base)).toBe("STUCK: team5 holds thread t1 (Opus) 12 min, team2 is free");
    expect(atascoLine({ ...base, libres: ["team2", "team3"], proyectoOcupado: true })).toBe(
      "STUCK: team5 holds thread t1 (Opus) 12 min, team2, team3 are free; another thread of its project is at work",
    );
  });
});
