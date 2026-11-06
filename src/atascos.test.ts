import { describe, expect, it } from "vitest";
import {
  STUCK_WAIT_MS,
  atascoLine,
  heldBy,
  heldLong,
  waitingForTeam,
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
    expect(heldBy(row({ failureReason: "hook timed out" }), "claude-switcher")).toBe(true);
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

// Aitor 2026-11-06 («los Opus tienen que salir por Team sí o sí»): an Opus
// turn with no Team seat waits; Flota shows it as «esperando Team» with the
// minutes, from the first of them (not only past STUCK_WAIT_MS).
describe("waitingForTeam", () => {
  const since = new Map([["t1", NOW - 31 * 60_000], ["t2", NOW - 60_000], ["t3", NOW - 5 * 60_000]]);
  /** The family of a model held off the reserve, as the server names it; null for any other. */
  const held = (model: string | null) => /opus|sonnet/.exec(model ?? "")?.[0] ?? null;

  it("lists each held thread of a model held off the reserve with its minutes, longest first, once", () => {
    const rows = [
      row({ threadId: "t2", model: "claude-sonnet-5-5" }),
      row({ threadId: "t1", model: "claude-opus-5-5" }),
      row({ threadId: "t1", model: "claude-opus-5-5" }),
      row({ threadId: "t3", model: "claude-fable-5-1" }),
    ];
    expect(waitingForTeam(rows, "claude-switcher", since, NOW, held)).toEqual([
      { hilo: "t1", modelo: "opus", minutos: 31 },
      { hilo: "t2", modelo: "sonnet", minutos: 1 },
    ]);
  });

  it("leaves out rows held by another plugin, archived, or never held by this one", () => {
    const rows = [
      row({ threadId: "t1", model: "claude-opus-5-5", waitingOn: { kind: "plugin", pluginId: "limiter" } }),
      row({ threadId: "t2", model: "claude-opus-5-5", failureReason: "Thread is archived" }),
      row({ threadId: "t9", model: "claude-opus-5-5" }),
    ];
    expect(waitingForTeam(rows, "claude-switcher", since, NOW, held)).toEqual([]);
  });
});
