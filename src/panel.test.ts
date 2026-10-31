import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PanelAccount,
  accountRow,
  forecastText,
  formatNumber,
  menuLine,
  moveTime,
  panelList,
  panelWords,
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
// The brake on background work on, as 0.2.32 shipped it (paceHoldsBackground).
const ES = {
  now: NOW,
  lang: "es" as const,
  timeZone: MADRID,
  preferredModel: "Fable",
  paceHoldsBackground: true,
};
const EN = { ...ES, lang: "en" as const };

describe("the panel's dates are Madrid's, whatever the browser's zone (Codex ULTRA-R2-005)", () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const monday = at("2026-11-02T09:00:00+01:00");

  it("writes a reset at Madrid's 09:00 as 09:00, with no zone given", () => {
    // In New York that is Monday 03:00.
    expect(new Date(monday).getHours()).toBe(3);
    expect(whenShort(monday, NOW, "es")).toBe("lun 09:00");
    expect(whenLong(monday, NOW, "es")).toBe("el lunes 2, 09:00");
    const row = accountRow(
      ultra("studio", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 }),
      seats(1, 4),
      { now: NOW, lang: "es", preferredModel: "Fable" },
    );
    expect(row.when).toBe("vuelve lun 09:00");
    expect(menuLine(row)).toContain("lun 09:00");
  });

  it("counts today and tomorrow by Madrid's calendar", () => {
    // 00:30 on Saturday in Madrid is 19:30 on Friday in New York: today
    // there, tomorrow in Madrid.
    const late = at("2026-10-31T00:30:00+01:00");
    expect(whenShort(late, NOW, "es")).toBe("mañana 00:30");
  });

  it("writes a move's time in Madrid", () => {
    expect(moveTime(at("2026-10-30T21:55:00+01:00"), "en-GB")).toBe("30/10/2026, 21:55:00");
  });
});

describe("accountRow", () => {
  it("draws an Ultra account by what is left of its week, today's share striped at its end", () => {
    const row = accountRow(
      ultra("studio", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 }),
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
      line: "ha gastado el 89 % de Fable · 2 de 2 hilos · 1 esperando",
      bar: { left: 49, today: 0, tone: "blue", label: "Le queda el 49 % de las 5 h" },
    });
    expect(accountRow(team("team1", 0, null, 76), seats(0, 2), EN)).toMatchObject({
      state: "free",
      word: "Free",
      when: "not started",
      line: "spent 76 % of Fable · 0 of 2 threads",
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
      ultra("studio", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 }),
      ultra("agency", 0, "2026-11-06T12:00:00+01:00", { budget: 14.3, spent: 0 }),
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
      studio: seats(1, 4),
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

describe("with the brake on background work off (paceHoldsBackground, the default; Aitor 2026-10-31)", () => {
  const OFF_ES = { ...ES, paceHoldsBackground: false };
  const OFF_EN = { ...EN, paceHoldsBackground: false };

  it("never calls an account «Guardada para ti»: it is Trabajando, Libre or Agotada, and still says today's share", () => {
    const spent = ultra("viaulab", 68, "2026-11-04T01:00:00+01:00", { budget: 11.1, spent: 20 });
    expect(accountRow(spent, seats(0, 4), OFF_ES)).toMatchObject({
      state: "free",
      word: "Libre",
      line: "Ya ha gastado lo de hoy",
    });
    expect(accountRow(spent, seats(1, 4), OFF_ES)).toMatchObject({ state: "working", word: "Trabajando" });
    // No pace known (it would be saved with the brake on): free too.
    expect(accountRow(ultra("aitor", 98, "2026-11-01T18:00:00+01:00", null, false), undefined, OFF_EN)).toMatchObject({
      state: "free",
      word: "Free",
    });
    const full = ultra("m", 100, "2026-10-31T11:00:00+01:00", { budget: 0, spent: 0 });
    expect(accountRow(full, seats(0, 4), OFF_ES).state).toBe("out");
    // A context that does not say: off, never a claim the plugin cannot keep.
    const { paceHoldsBackground: _, ...unsaid } = ES;
    expect(accountRow(spent, seats(0, 4), unsaid).state).toBe("free");
  });

  it("says nobody is kept for the user", () => {
    const es = said(panelList(realState(), OFF_ES).sentence);
    expect(es).not.toContain("Guardada");
    expect(es).toBe("Trabajan **studio, ganaresenas, team2, team3**. La que más semana tiene es **agency** (100 %).");
    expect(said(panelList(realState(), OFF_EN).sentence)).not.toContain("Kept");
    expect(
      panelList(realState(), OFF_ES).groups.flatMap((g) => g.rows).filter((r) => r.state === "kept"),
    ).toEqual([]);
  });
});

describe("panelList", () => {
  it("says who works, who is kept and which has most week, then the two groups in order", () => {
    const list = panelList(realState(), ES);
    expect(said(list.sentence)).toBe(
      "Trabajan **studio, ganaresenas, team2, team3**. Guardadas para ti: **viaulab y aitor**. La que más semana tiene es **agency** (100 %).",
    );
    expect(list.groups.map((g) => g.title)).toEqual([
      "Ultra · lo que queda de la semana",
      "Team · lo que queda de sus 5 h",
    ]);
    expect(list.groups[0].rows.map((r) => r.name)).toEqual([
      "agency",
      "studio",
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
      "Working: **studio, ganaresenas, team2, team3**. Kept for you: **viaulab and aitor**. Most of the week left: **agency** (100 %).",
    );
  });

  it("says one in the singular, none at all, and leaves out what is not there", () => {
    const one = {
      accounts: [ultra("studio", 10, "2026-11-02T09:00:00+01:00", { budget: 33.3, spent: 10 })],
      seats: { studio: seats(1, 4) },
    };
    expect(said(panelList(one, ES).sentence)).toBe("Trabaja **studio**.");
    const kept = {
      accounts: [ultra("aitor", 98, "2026-11-01T18:00:00+01:00", { budget: 5.5, spent: 11 }, false)],
      seats: {},
    };
    expect(said(panelList(kept, ES).sentence)).toBe(
      "En este ordenador no trabaja ninguna. Guardada para ti: **aitor**.",
    );
    expect(said(panelList(kept, EN).sentence)).toBe(
      "No account is working on this computer now. Kept for you: **aitor**.",
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

describe("panelWords", () => {
  it("has every word of the view in both languages", () => {
    expect(panelWords("es").logIn).toBe("Iniciar sesión");
    expect(panelWords("en").logIn).toBe("Log in");
    expect(panelWords("es").sameAs("ganaresenas")).toBe(
      "Misma cuenta de Claude que ganaresenas: comparten el uso",
    );
    expect(Object.keys(panelWords("es")).sort()).toEqual(
      Object.keys(panelWords("en")).sort(),
    );
  });
});

describe("forecastText", () => {
  it("says when the window that matters runs out at this pace, in the user's language", () => {
    const forecasts = {
      studio: {
        weekly: { kind: "lasts" as const, until: NOW + 76 * H, percentPerDay: 5 },
        Fable: { kind: "runs-out" as const, at: NOW + 20 * H, percentPerDay: 30 },
      },
      agency: { weekly: { kind: "runs-out" as const, at: NOW + 53 * H, percentPerDay: 12 } },
      team1: { Fable: { kind: "steady" as const } },
    };
    expect(forecastText(forecasts, "studio", "Fable", NOW, "es")).toBe(
      "Fable: se acaba en 20 h a este ritmo (30 %/día)",
    );
    expect(forecastText(forecasts, "studio", "Fable", NOW, "en")).toBe(
      "Fable: runs out in 20 h at this pace (30 %/day)",
    );
    expect(forecastText(forecasts, "studio", "", NOW, "es")).toBe(
      "Semana: llega al reinicio a este ritmo (5 %/día)",
    );
    expect(forecastText(forecasts, "agency", "Fable", NOW, "es")).toBe(
      "Semana: se acaba en 2 d 5 h a este ritmo (12 %/día)",
    );
    expect(forecastText(forecasts, "team1", "Fable", NOW, "es")).toBeNull();
    expect(forecastText(undefined, "x", "Fable", NOW, "en")).toBeNull();
  });

  it("rounds to the minute: under half a minute is now, not «in 0 min»", () => {
    const f = (at: number) => ({ a: { weekly: { kind: "runs-out" as const, at, percentPerDay: 12.5 } } });
    expect(forecastText(f(NOW - 1), "a", "", NOW, "en")).toBe("Week: runs out now at this pace (12.5 %/day)");
    expect(forecastText(f(NOW + 29_000), "a", "", NOW, "es")).toBe("Semana: se acaba ya a este ritmo (12,5 %/día)");
    expect(forecastText(f(NOW + 31_000), "a", "", NOW, "en")).toBe("Week: runs out in 1 min at this pace (12.5 %/day)");
    expect(forecastText(f(NOW + 3 * H), "a", "", NOW, "en")).toBe("Week: runs out in 3 h at this pace (12.5 %/day)");
  });
});

describe("formatNumber", () => {
  it("writes a decimal with a comma in Spanish and a point in English, whole numbers as they are", () => {
    expect(formatNumber(24.3, "es")).toBe("24,3");
    expect(formatNumber(24.3, "en")).toBe("24.3");
    expect(formatNumber(88, "es")).toBe("88");
    expect(formatNumber(1234.5, "es")).toBe("1234,5");
    const f = { a: { weekly: { kind: "lasts" as const, until: NOW + 76 * H, percentPerDay: 24.3 } } };
    expect(forecastText(f, "a", "", NOW, "es")).toBe("Semana: llega al reinicio a este ritmo (24,3 %/día)");
    expect(forecastText(f, "a", "", NOW, "en")).toBe("Week: lasts until the reset at this pace (24.3 %/day)");
  });
});

describe("Fable's week in the panel (Aitor, 2026-10-31)", () => {
  const NOW = Date.parse("2026-10-31T13:00:00+01:00");
  const RESET = Date.parse("2026-11-02T10:00:00+01:00");
  const week = (used: number) => ({ usedPercent: used, resetsAt: RESET });
  const ultra = (name: string, spent: number, room: Partial<NonNullable<PanelAccount["fable"]>> = {}): PanelAccount => ({
    name,
    plan: "ultra",
    fiveHour: false,
    problem: null,
    usage: {
      blocked: false,
      session: { usedPercent: 0, resetsAt: null, absent: true },
      weekly: week(spent),
      models: { Fable: week(spent) },
    },
    pace: { budget: 10, spent: 2, dayPercent: 20, background: true },
    fable: {
      left: 100 - spent,
      reserve: 20,
      open: true,
      why: null,
      pace: { budget: 10, spent: 2, dayPercent: 20, background: true },
      nextAt: RESET,
      resetsAt: RESET,
      ...room,
    },
  });
  const ctx = { now: NOW, lang: "es" as const, preferredModel: "Fable", paceHoldsBackground: true };

  it.each([
    [0, 100, "100 %"],
    [35, 65, "65 %"],
    [100, 0, "0 %"],
  ])("gastado %i: bar, figure and words all say what is LEFT", (spent, left, figure) => {
    const row = accountRow(ultra("a", spent), undefined, ctx);
    expect(row.bar?.left).toBe(left);
    expect(row.figure).toBe(figure);
    expect(row.figureOf).toBe("de Fable");
    expect(row.bar?.label).toBe(`Te queda el ${left} % de la semana de Fable`);
  });

  it("says it as Aitor asked, whatever the general week", () => {
    const row = accountRow(ultra("a", 65, { open: false, why: "pace" }), undefined, ctx);
    expect(threadLine(row)).toContain("te queda el 35 % de la semana de Fable");
    expect(row.help).toContain("Fable: te queda el 35 % de la semana");
    expect(row.help).toMatch(/se reinicia .*lun.*10:00/);
    expect(row.help).toContain("el fondo ya no la usa");
    expect(row.line).toContain("el fondo ya no la usa");
  });

  it("marks in red the one past the brake, draws the reserve and today's share", () => {
    const passed = accountRow(ultra("a", 90, { open: false, why: "reserve" }), undefined, ctx);
    expect(passed.bar?.tone).toBe("red");
    expect(passed.bar?.reserve).toBe(20);
    expect(passed.line).toContain("solo queda tu reserva");
    const fine = accountRow(ultra("b", 40), undefined, ctx);
    expect(fine.bar?.tone).toBe("green");
    expect(fine.bar?.today).toBe(8);
    expect(fine.state).toBe("free");
  });

  it("with the brake off it says nothing of what the background may not do", () => {
    const row = accountRow(ultra("a", 90, { open: false, why: "reserve" }), undefined, { ...ctx, paceHoldsBackground: false });
    expect(row.state).toBe("free");
    expect(row.line).not.toContain("fondo");
  });

  it("an Ultra out of Fable reads as such, not as out of the week: Opus still runs", () => {
    const row = accountRow(
      { ...ultra("a", 100, { open: false, why: "reserve", left: 0 }), usage: { ...ultra("a", 100).usage!, weekly: week(68) } },
      undefined,
      ctx,
    );
    expect(row.state).toBe("free");
    expect(row.bar?.tone).toBe("red");
    expect(row.line).toContain("sin Fable hasta");
  });

  it("tells who spent it, from what the file measured, on this computer", () => {
    const row = accountRow({ ...ultra("a", 50), who: { interactivo: 70, fondo: 30, hilos: 0 } }, undefined, ctx);
    expect(row.who).toBe("La gastó en este ordenador: 70 % tú · 30 % fondo");
    expect(row.help).toContain(row.who!);
    expect(accountRow(ultra("b", 50), undefined, ctx).who).toBeNull();
  });

  it("orders by Fable left, with the general week fuller or not, and the sentence totals it", () => {
    const list = panelList(
      { accounts: [ultra("full", 80), ultra("empty", 10), { ...ultra("mid", 40), usage: { ...ultra("mid", 40).usage!, weekly: week(95) } }] },
      ctx,
    );
    expect(list.groups[0]!.rows.map((r) => r.name)).toEqual(["empty", "mid", "full"]);
    const text = list.sentence.map((p) => p.text).join("");
    expect(text).toContain("En este ordenador no trabaja ninguna.");
    expect(text).toContain("Entre todas queda el 57 % de Fable");
    expect(text).toContain("La que más Fable tiene es empty (90 %)");
  });
});
