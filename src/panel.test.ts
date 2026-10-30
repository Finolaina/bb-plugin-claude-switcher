import { describe, expect, it } from "vitest";
import {
  accountRow,
  menuLine,
  panelList,
  threadLine,
  uiLang,
  whenLong,
  whenShort,
} from "./panel.js";

const MADRID = "Europe/Madrid";
// Friday 30 Oct 2026, 21:55 in Madrid (CET, +01:00): the hour of the real
// reading behind the design (Optimizador informes/2026-10-30/ultra).
const NOW = Date.parse("2026-10-30T21:55:00+01:00");
const at = (iso: string) => Date.parse(iso);

describe("uiLang", () => {
  it("speaks Spanish to a browser set to any Spanish, English to the rest", () => {
    expect(uiLang("es-ES")).toBe("es");
    expect(uiLang("es")).toBe("es");
    expect(uiLang("ES-mx")).toBe("es");
    expect(uiLang("en-GB")).toBe("en");
    expect(uiLang("eu")).toBe("en");
    expect(uiLang(undefined)).toBe("en");
  });
});

describe("whenShort / whenLong", () => {
  it("says today, tomorrow, the weekday up to six days ahead, the date beyond", () => {
    expect(whenShort(at("2026-10-30T22:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "hoy 22:00",
    );
    expect(whenShort(at("2026-10-31T11:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "mañana 11:00",
    );
    // Past midnight in Madrid is tomorrow, even within the hour.
    expect(whenShort(at("2026-10-31T00:30:00+01:00"), NOW, "es", MADRID)).toBe(
      "mañana 00:30",
    );
    expect(whenShort(at("2026-11-02T09:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "lun 09:00",
    );
    expect(whenShort(at("2026-11-04T01:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "mié 01:00",
    );
    expect(whenShort(at("2026-11-05T12:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "jue 12:00",
    );
    expect(whenShort(at("2026-11-06T12:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "6 nov 12:00",
    );
    expect(whenShort(at("2026-11-02T09:00:00+01:00"), NOW, "en", MADRID)).toBe(
      "Mon 09:00",
    );
    expect(whenShort(at("2026-10-30T22:00:00+01:00"), NOW, "en", MADRID)).toBe(
      "today 22:00",
    );
    expect(whenShort(at("2026-10-31T11:00:00+01:00"), NOW, "en", MADRID)).toBe(
      "tomorrow 11:00",
    );
    expect(whenShort(at("2026-11-06T12:00:00+01:00"), NOW, "en", MADRID)).toBe(
      "6 Nov 12:00",
    );
  });

  it("counts the days in the zone it is given", () => {
    // 23:30 UTC on the 30th is already the 31st in Madrid.
    expect(whenShort(at("2026-10-30T23:30:00Z"), NOW, "es", MADRID)).toBe(
      "mañana 00:30",
    );
    expect(whenShort(at("2026-10-30T23:30:00Z"), NOW, "es", "UTC")).toBe(
      "hoy 23:30",
    );
  });

  it("writes the weekday out in the long form, and keeps today and tomorrow", () => {
    expect(whenLong(at("2026-11-02T09:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "el lunes 2, 09:00",
    );
    expect(whenLong(at("2026-11-02T09:00:00+01:00"), NOW, "en", MADRID)).toBe(
      "on Monday 2, 09:00",
    );
    expect(whenLong(at("2026-10-30T22:00:00+01:00"), NOW, "es", MADRID)).toBe(
      "hoy 22:00",
    );
    expect(whenLong(at("2026-10-31T11:00:00+01:00"), NOW, "en", MADRID)).toBe(
      "tomorrow 11:00",
    );
  });
});

// The accounts of the design's real reading (2026-10-30 21:55, DISENO.md and
// propuestas/index.html), as the plugin's state carries them.
const H = 3_600_000;
const win = (usedPercent: number, resetsAt: number | null) => ({
  usedPercent,
  resetsAt,
});
const NO_SESSION = { usedPercent: 0, resetsAt: null, absent: true as const };
const NO_WEEKLY = { usedPercent: 0, resetsAt: null, absent: true as const };
function ultra(
  name: string,
  weekly: number,
  reset: string,
  pace: { budget: number; spent: number } | null,
  fiveHour = true,
) {
  const dayPercent =
    pace === null ? 0 : pace.budget > 0 ? (pace.spent / pace.budget) * 100 : 100;
  return {
    name,
    problem: null,
    plan: "ultra" as const,
    fiveHour,
    usage: {
      blocked: false,
      session: fiveHour ? win(10, NOW + 2 * H) : NO_SESSION,
      weekly: win(weekly, at(reset)),
      models: { Fable: win(weekly, at(reset)) },
    },
    pace:
      pace === null
        ? null
        : { ...pace, dayPercent, background: dayPercent < 90 },
  };
}
function team(name: string, session: number, reset: string | null, fable: number) {
  return {
    name,
    problem: null,
    plan: "team" as const,
    fiveHour: true,
    usage: {
      blocked: false,
      session: win(session, reset === null ? null : at(reset)),
      weekly: NO_WEEKLY,
      models: { Fable: win(fable, NOW + 72 * H) },
    },
    pace: null,
  };
}
const seats = (running: number, capacity: number, queued = 0) => ({
  capacity,
  running,
  reserved: 0,
  queued: Array.from({ length: queued }, (_, i) => ({
    threadId: `thr_${i}`,
    title: null,
  })),
});
const ES = { now: NOW, lang: "es" as const, timeZone: MADRID, preferredModel: "Fable" };
const EN = { ...ES, lang: "en" as const };

describe("accountRow", () => {
  it("draws an Ultra account by what is left of its week, today's share striped at its end", () => {
    const row = accountRow(
      ultra("joytorm", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 }),
      seats(1, 4),
      ES,
    );
    expect(row).toMatchObject({
      state: "working",
      word: "Trabajando",
      planShort: "Ultra · con 5 h",
      planLong: "Ultra · 5 h hasta que Anthropic la verifique",
      figure: "90 %",
      figureOf: "de la semana",
      when: "vuelve lun 09:00",
      line: "Hoy ha gastado el 30 % de su parte",
      bar: { left: 90, tone: "green", label: "Le queda el 90 % de la semana" },
    });
    expect(row.bar?.today).toBeCloseTo(23.3);
    expect(row.help).toContain("Le queda el 90 % de la semana · se recupera el lunes 2, 09:00");
  });

  it("keeps for the user an account that spent today's share, and stripes nothing", () => {
    const row = accountRow(
      ultra("viaulab", 68, "2026-11-04T01:00:00+01:00", { budget: 11.1, spent: 20 }),
      seats(0, 4),
      ES,
    );
    expect(row).toMatchObject({
      state: "kept",
      word: "Guardada para ti",
      line: "Ya ha gastado lo de hoy",
      when: "vuelve mié 01:00",
      bar: { left: 32, today: 0, tone: "green" },
    });
  });

  it("says the today line at 90 % of the share exactly, not at 89", () => {
    const at90 = accountRow(
      ultra("a", 50, "2026-11-02T09:00:00+01:00", { budget: 10, spent: 9 }),
      undefined,
      ES,
    );
    expect(at90.line).toBe("Ya ha gastado lo de hoy");
    expect(at90.state).toBe("kept");
    const at89 = accountRow(
      ultra("a", 50, "2026-11-02T09:00:00+01:00", { budget: 10, spent: 8.9 }),
      undefined,
      ES,
    );
    expect(at89.line).toBe("Hoy ha gastado el 89 % de su parte");
    expect(at89.state).toBe("free");
  });

  it("shows aitor, an Ultra freed of the 5-hour window, amber with 2 % left", () => {
    const row = accountRow(
      ultra("aitor", 98, "2026-11-01T18:00:00+01:00", { budget: 5.5, spent: 11 }, false),
      seats(0, 4),
      ES,
    );
    expect(row).toMatchObject({
      state: "kept",
      planShort: "Ultra · sin tope de 5 h",
      planLong: "Ultra · sin tope de 5 h",
      figure: "2 %",
      when: "vuelve dom 18:00",
      bar: { left: 2, tone: "amber" },
    });
    expect(accountRow(ultra("aitor", 98, "2026-11-01T18:00:00+01:00", null, false), undefined, EN)).toMatchObject({
      planShort: "Ultra · no 5-hour cap",
      word: "Kept for you",
      figure: "2 %",
      figureOf: "of the week",
      when: "back Sun 18:00",
      bar: { label: "2 % of the week left" },
    });
  });

  it("puts out before kept, kept before working, working before free", () => {
    const full = ultra("m", 100, "2026-10-31T11:00:00+01:00", { budget: 0, spent: 0 });
    expect(accountRow(full, seats(1, 4), ES)).toMatchObject({
      state: "out",
      word: "Agotada",
      when: "vuelve mañana 11:00",
      bar: { left: 0, today: 0, tone: "empty" },
      line: "",
    });
    const kept = ultra("k", 50, "2026-11-02T09:00:00+01:00", { budget: 10, spent: 9.5 });
    expect(accountRow(kept, seats(2, 4), ES).state).toBe("kept");
    const free = ultra("f", 50, "2026-11-02T09:00:00+01:00", { budget: 10, spent: 1 });
    expect(accountRow(free, seats(1, 4), ES).state).toBe("working");
    expect(accountRow(free, seats(0, 4), ES).state).toBe("free");
    // A seat held from outside bb (`reserve`) is work too.
    expect(
      accountRow(free, { ...seats(0, 4), external: [{ id: "x", until: NOW + H }] }, ES).state,
    ).toBe("working");
  });

  it("calls an account without a login out, and a failed or incomplete read «Sin datos»", () => {
    expect(
      accountRow(
        { name: "mariscal", problem: { kind: "unauthenticated" }, usage: null, plan: "ultra", fiveHour: null, pace: null },
        undefined,
        ES,
      ),
    ).toMatchObject({ state: "out", word: "Agotada", line: "sin sesión iniciada", bar: null, figure: null });
    expect(
      accountRow({ name: "x", problem: { kind: "error", message: "429" }, usage: null }, undefined, ES),
    ).toMatchObject({ state: "nodata", word: "Sin datos", line: "la lectura falló: 429", bar: null });
    const incomplete = ultra("y", 40, "2026-11-02T09:00:00+01:00", null);
    expect(
      accountRow({ ...incomplete, usage: { ...incomplete.usage, blocked: true, unknown: true } }, undefined, EN),
    ).toMatchObject({ state: "nodata", word: "No data", line: "incomplete answer from the usage API" });
    const locked = ultra("z", 40, "2026-11-02T09:00:00+01:00", null);
    expect(
      accountRow({ ...locked, usage: { ...locked.usage, blocked: true } }, undefined, ES),
    ).toMatchObject({ state: "out", line: "bloqueada por el proveedor" });
  });

  it("draws a Team seat by what is left of its 5 hours, with its threads", () => {
    expect(accountRow(team("team2", 51, "2026-10-31T00:00:00+01:00", 89), seats(2, 2, 1), ES)).toMatchObject({
      state: "working",
      planShort: "Team",
      figure: "49 %",
      figureOf: "de las 5 h",
      when: "vuelve mañana 00:00",
      line: "Fable al 89 % · 2 de 2 hilos · 1 esperando",
      bar: { left: 49, today: 0, tone: "blue", label: "Le queda el 49 % de las 5 h" },
    });
    expect(accountRow(team("team1", 0, null, 76), seats(0, 2), EN)).toMatchObject({
      state: "free",
      word: "Free",
      when: "not started",
      line: "Fable at 76 % · 0 of 2 threads",
    });
  });
});

/** The eleven accounts of the design's real reading. */
function realState() {
  return {
    accounts: [
      ultra("mariscal", 100, "2026-10-31T11:00:00+01:00", null),
      ultra("aitor", 98, "2026-11-01T18:00:00+01:00", { budget: 5.5, spent: 11 }, false),
      ultra("ganaresenas", 90, "2026-11-01T22:00:00+01:00", { budget: 3.9, spent: 0 }),
      ultra("joytorm", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 }),
      ultra("siloeads", 0, "2026-11-06T12:00:00+01:00", { budget: 14.3, spent: 0 }),
      ultra("viaulab", 68, "2026-11-04T01:00:00+01:00", { budget: 11.1, spent: 20 }),
      team("team5", 60, "2026-10-31T00:00:00+01:00", 60),
      team("team1", 0, null, 76),
      team("team2", 51, "2026-10-31T00:00:00+01:00", 89),
      team("team3", 47, "2026-10-30T22:00:00+01:00", 99),
      team("team4", 8, "2026-10-31T02:00:00+01:00", 82),
    ].map((a) =>
      a.name === "mariscal"
        ? { ...a, problem: { kind: "unauthenticated" as const }, usage: null }
        : a,
    ),
    seats: {
      joytorm: seats(1, 4),
      ganaresenas: seats(1, 4),
      team1: seats(0, 2),
      team2: seats(2, 2, 1),
      team3: seats(1, 2),
      team4: seats(0, 2),
      team5: seats(0, 2),
    },
  };
}
const said = (pieces: { text: string; bold: boolean }[]) =>
  pieces.map((p) => (p.bold ? `**${p.text}**` : p.text)).join("");

describe("panelList", () => {
  it("says who works, who is kept and which has most week, then the two groups in order", () => {
    const list = panelList(realState(), ES);
    expect(said(list.sentence)).toBe(
      "Trabajan **joytorm, ganaresenas, team2, team3**. Guardadas para ti: **viaulab y aitor**. La que más semana tiene es **siloeads** (100 %).",
    );
    expect(list.groups.map((g) => g.title)).toEqual([
      "Ultra · lo que queda de la semana",
      "Team · lo que queda de sus 5 h",
    ]);
    expect(list.groups[0].rows.map((r) => r.name)).toEqual([
      "siloeads",
      "joytorm",
      "viaulab",
      "ganaresenas",
      "aitor",
      "mariscal",
    ]);
    expect(list.groups[1].rows.map((r) => r.name)).toEqual([
      "team1",
      "team2",
      "team3",
      "team4",
      "team5",
    ]);
    expect(said(panelList(realState(), EN).sentence)).toBe(
      "Working: **joytorm, ganaresenas, team2, team3**. Kept for you: **viaulab and aitor**. Most of the week left: **siloeads** (100 %).",
    );
  });

  it("says one in the singular, none at all, and leaves out what is not there", () => {
    const one = {
      accounts: [ultra("joytorm", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 })],
      seats: { joytorm: seats(1, 4) },
    };
    expect(said(panelList(one, ES).sentence)).toBe("Trabaja **joytorm**.");
    const kept = {
      accounts: [ultra("aitor", 98, "2026-11-01T18:00:00+01:00", { budget: 5.5, spent: 11 }, false)],
      seats: {},
    };
    expect(said(panelList(kept, ES).sentence)).toBe(
      "Ahora no trabaja ninguna. Guardada para ti: **aitor**.",
    );
    expect(said(panelList(kept, EN).sentence)).toBe(
      "No account is working now. Kept for you: **aitor**.",
    );
  });

  it("names the group «Ultra y Max» when a Max is in it", () => {
    const mixed = {
      accounts: [
        ultra("a", 10, "2026-11-02T09:00:00+01:00", null),
        { ...ultra("b", 10, "2026-11-02T09:00:00+01:00", null), plan: "max" as const },
      ],
      seats: {},
    };
    expect(panelList(mixed, ES).groups[0].title).toBe("Ultra y Max · lo que queda de la semana");
    expect(panelList(mixed, EN).groups[0].title).toBe("Ultra and Max · what is left of the week");
  });
});

describe("threadLine / menuLine", () => {
  it("says the thread's account in one short line, and each account of the menu", () => {
    const aitor = accountRow(
      ultra("aitor", 60, "2026-11-02T09:00:00+01:00", { budget: 10, spent: 1 }, false),
      undefined,
      ES,
    );
    expect(threadLine(aitor)).toBe(
      "Ultra · sin tope de 5 h · le queda el 40 % de la semana · vuelve lun 09:00",
    );
    expect(menuLine(aitor)).toBe("40 % de la semana · vuelve lun 09:00");
    const team2 = accountRow(team("team2", 51, "2026-10-31T00:00:00+01:00", 89), seats(2, 2, 1), EN);
    expect(threadLine(team2)).toBe("Team · 49 % of the 5 hours left · back tomorrow 00:00");
    const mariscal = accountRow(
      { name: "mariscal", problem: { kind: "unauthenticated" }, usage: null, plan: "ultra", fiveHour: null },
      undefined,
      ES,
    );
    expect(threadLine(mariscal)).toBe("Ultra · sin sesión iniciada");
    expect(menuLine(mariscal)).toBe("sin sesión iniciada");
  });
});
