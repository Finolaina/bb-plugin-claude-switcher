import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  HISTORIAL_MIGRATIONS,
  addSample,
  addStuck,
  historyText,
  prune,
  readSamples,
  readStuck,
  type SampleRow,
} from "./historial.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-05 12:00 Europe/Madrid (11:00 UTC).
const NOW = Date.UTC(2026, 10, 5, 11, 0, 0);

function db() {
  const d = new Database(":memory:");
  for (const sql of HISTORIAL_MIGRATIONS) d.exec(sql);
  return d;
}
const sample = (at: number, o: Partial<SampleRow> = {}): SampleRow => ({
  at,
  account: "team1",
  running: 1,
  reserved: 0,
  external: 0,
  waiting: 0,
  capacity: 2,
  session: 10,
  weekly: 20,
  sessionResets: null,
  weeklyResets: null,
  preferredWeekly: null,
  ...o,
});

describe("historial de asientos (Aitor 2026-11-05: «que guarde los últimos días de historial»)", () => {
  it("un registro de 8 días, un punto cada 5 min, se queda en los 7 últimos", () => {
    const d = db();
    for (let at = NOW - 8 * DAY; at <= NOW; at += 5 * 60_000)
      addSample(d, sample(at));
    addStuck(d, {
      at: NOW - 8 * DAY,
      thread: "thr_viejo",
      account: "team1",
      model: "Opus",
      minutes: 12,
      free: ["team3"],
      projectBusy: true,
      line: "STUCK: viejo",
    });
    addStuck(d, {
      at: NOW - 1 * DAY,
      thread: "thr_nuevo",
      account: "team1",
      model: "Opus",
      minutes: 12,
      free: ["team3"],
      projectBusy: true,
      line: "STUCK: nuevo",
    });
    prune(d, NOW);
    const kept = readSamples(d, 0);
    // 7 días justos, extremos incluidos: 7 × 288 + 1 puntos.
    expect(kept).toHaveLength(7 * 288 + 1);
    expect(kept[0]!.at).toBe(NOW - 7 * DAY);
    expect(kept.at(-1)!.at).toBe(NOW);
    expect(readStuck(d, 0).map((r) => r.thread)).toEqual(["thr_nuevo"]);
  });

  it("guarda el % de la semanal del modelo preferido (Fable) de cada muestra; sin ventana propia, null (Aitor 2026-11-07: «fable se queda sin gastar»)", () => {
    const d = db();
    addSample(d, sample(NOW, { account: "viaulab", weekly: 85, preferredWeekly: 52 }));
    addSample(d, sample(NOW, { account: "team1", weekly: 38, preferredWeekly: null }));
    expect(readSamples(d, 0).map((r) => [r.account, r.weekly, r.preferredWeekly])).toEqual([
      ["team1", 38, null],
      ["viaulab", 85, 52],
    ]);
  });

  it("las muestras guardadas antes de la columna del modelo preferido se leen con null", () => {
    const d = new Database(":memory:");
    for (const sql of HISTORIAL_MIGRATIONS.slice(0, 3)) d.exec(sql);
    d.prepare(
      `INSERT INTO seat_samples (at, account, running, reserved, session, weekly) VALUES (?, ?, 1, 0, 10, 85)`,
    ).run(NOW, "viaulab");
    for (const sql of HISTORIAL_MIGRATIONS.slice(3)) d.exec(sql);
    expect(readSamples(d, 0).map((r) => [r.weekly, r.preferredWeekly])).toEqual([[85, null]]);
  });

  it("el corte: lo de 7 días justos se queda, 1 ms más viejo se va", () => {
    const d = db();
    addSample(d, sample(NOW - 7 * DAY - 1));
    addSample(d, sample(NOW - 7 * DAY));
    prune(d, NOW);
    expect(readSamples(d, 0).map((r) => r.at)).toEqual([NOW - 7 * DAY]);
  });

  it("la misma medición dos veces es un solo punto", () => {
    const d = db();
    addSample(d, sample(NOW));
    addSample(d, sample(NOW, { running: 2 }));
    expect(readSamples(d, 0)).toEqual([sample(NOW)]);
  });

  it("history --dias: una fila por hora y cuenta con lo máximo ocupado y en espera, y las filas STUCK con su motivo", () => {
    const d = db();
    addSample(
      d,
      sample(NOW - 3 * DAY, {
        running: 2,
        waiting: 1,
        session: 30,
        weekly: 40,
      }),
    );
    // 12:00 y 12:35 de Madrid: la misma hora; el máximo y la última cuota.
    addSample(
      d,
      sample(NOW, { running: 1, waiting: 3, session: 50, weekly: 60 }),
    );
    addSample(
      d,
      sample(NOW + 35 * 60_000, {
        running: 2,
        waiting: 0,
        session: 55,
        weekly: 61,
      }),
    );
    addStuck(d, {
      at: NOW + 10 * 60_000,
      thread: "thr_x",
      account: "team1",
      model: "Opus",
      minutes: 11,
      free: ["team3", "viaulab"],
      projectBusy: true,
      line: "STUCK: team1 holds thread thr_x (Opus) 11 min, team3, viaulab are free; another thread of its project is at work",
    });
    const text = historyText({
      samples: readSamples(d, NOW - DAY),
      stuck: readStuck(d, NOW - DAY),
      dias: 1,
      now: NOW + HOUR,
    });
    expect(text).toContain(
      "2026-11-05 12:10\tSTUCK: team1 holds thread thr_x (Opus) 11 min, team3, viaulab are free; another thread of its project is at work",
    );
    expect(text).toContain("2026-11-05 12:00\tteam1\t2/2\t3\t55\t61");
    // Lo de hace 3 días no entra en --dias 1.
    expect(text).not.toContain("2026-11-02");
    expect(text.split("\n")[0]).toBe(
      "Seats and stuck threads, last 1 day (Europe/Madrid)",
    );
  });

  it("sin nada guardado lo dice", () => {
    expect(
      historyText({ samples: [], stuck: [], dias: 7, now: NOW }),
    ).toContain("no samples in the last 7 days");
  });
});
