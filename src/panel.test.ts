import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountRow,
  cardLine,
  forecastText,
  formatNumber,
  menuLine,
  moveTime,
  panelList,
  panelWords,
  threadLine,
  toneOf,
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
  it("draws an Ultra account as a bar of what is spent per window: 5 h, week with today's share after it, Fable", () => {
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
      when: "vuelve lun 09:00",
      line: "Hoy ha gastado el 30 % de su parte",
      bar: { kind: "week", used: 10, figure: "10 %", tone: "green", label: "Ha gastado el 10 % de la semana" },
    });
    expect(row.bars.map((b) => [b.name, b.figure, b.tone, b.label])).toEqual([
      ["5 h", "10 %", "green", "Ha gastado el 10 % de las 5 h"],
      ["Semana", "10 %", "green", "Ha gastado el 10 % de la semana"],
      ["Fable", "10 %", "green", "Ha gastado el 10 % de Fable"],
    ]);
    // Today's share still to spend sits right after what is spent, on the week only.
    expect(row.bar?.today).toBeCloseTo(23.3);
    expect(row.bars.filter((b) => b.today > 0).map((b) => b.kind)).toEqual(["week"]);
    expect(row.help).toContain("Ha gastado el 10 % de la semana · se reinicia el lunes 2, 09:00");
    expect(row.help).toContain("Ha gastado el 10 % de las 5 h · se reinicia hoy 23:55");
  });

  it("keeps for the user an account that spent today's share, and adds no share after the week", () => {
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
      bar: { used: 68, today: 0, tone: "green" },
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

  it("shows aitor, an Ultra freed of the 5-hour window, with no 5 h bar and its week red at 98 %", () => {
    const row = accountRow(
      ultra("aitor", 98, "2026-11-01T18:00:00+01:00", { budget: 5.5, spent: 11 }, false),
      seats(0, 4),
      ES,
    );
    expect(row).toMatchObject({
      state: "kept",
      planShort: "Ultra · sin tope de 5 h",
      planLong: "Ultra · sin tope de 5 h",
      when: "vuelve dom 18:00",
      bar: { used: 98, figure: "98 %", tone: "red" },
    });
    expect(row.bars.map((b) => b.kind)).toEqual(["week", "model"]);
    expect(accountRow(ultra("aitor", 98, "2026-11-01T18:00:00+01:00", null, false), undefined, EN)).toMatchObject({
      planShort: "Ultra · no 5-hour cap",
      word: "Kept for you",
      when: "back Sun 18:00",
      bar: { name: "Week", figure: "98 %", label: "Used 98 % of the week" },
    });
  });

  it("colours every bar by what is spent: green to 69 %, amber from 70 %, red from 90 % (Aitor, 2026-10-31)", () => {
    expect([0, 69, 70, 89, 90, 99, 100].map(toneOf)).toEqual([
      "green",
      "green",
      "amber",
      "amber",
      "red",
      "red",
      "red",
    ]);
    // The same rule on each window of a row, whichever it is.
    const tones = (session: number, weekly: number, fable: number) => {
      const a = ultra("a", weekly, "2026-11-02T09:00:00+01:00", null);
      return accountRow(
        {
          ...a,
          usage: {
            ...a.usage,
            session: win(session, NOW + 2 * H),
            models: { Fable: win(fable, NOW + 72 * H) },
          },
        },
        undefined,
        EN,
      ).bars.map((b) => b.tone);
    };
    expect(tones(69, 70, 89)).toEqual(["green", "amber", "amber"]);
    expect(tones(90, 69.4, 100)).toEqual(["red", "green", "red"]);
    // 89.6 % rounds to 90: what the figure says, the colour says.
    expect(tones(89.6, 0, 0)).toEqual(["red", "green", "green"]);
  });

  it("shows a window whose reset has passed at 0 %, an empty bar, and says when it reset", () => {
    const a = ultra("a", 40, "2026-11-02T09:00:00+01:00", null);
    const row = accountRow(
      { ...a, usage: { ...a.usage, session: win(95, NOW - 10 * 60_000) } },
      undefined,
      ES,
    );
    expect(row.bars[0]).toMatchObject({ kind: "five", used: 0, figure: "0 %", tone: "green" });
    expect(row.bars[0].resets).toBe("se reinició hoy 21:45");
  });

  it("puts out before kept, kept before working, working before free", () => {
    const full = ultra("m", 100, "2026-10-31T11:00:00+01:00", { budget: 0, spent: 0 });
    expect(accountRow(full, seats(1, 4), ES)).toMatchObject({
      state: "out",
      word: "Agotada",
      when: "vuelve mañana 11:00",
      bar: { used: 100, figure: "100 %", today: 0, tone: "red" },
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

  it("calls an account without a login out, and a failed or incomplete read «Sin datos», with no bars", () => {
    expect(
      accountRow(
        { name: "mariscal", problem: { kind: "unauthenticated" }, usage: null, plan: "ultra", fiveHour: null, pace: null },
        undefined,
        ES,
      ),
    ).toMatchObject({ state: "out", word: "Agotada", line: "sin sesión iniciada", bar: null, bars: [] });
    expect(
      accountRow({ name: "x", problem: { kind: "error", message: "429" }, usage: null }, undefined, ES),
    ).toMatchObject({ state: "nodata", word: "Sin datos", line: "la lectura falló: 429", bar: null, bars: [] });
    const incomplete = ultra("y", 40, "2026-11-02T09:00:00+01:00", null);
    expect(
      accountRow({ ...incomplete, usage: { ...incomplete.usage, blocked: true, unknown: true } }, undefined, EN),
    ).toMatchObject({ state: "nodata", word: "No data", line: "incomplete answer from the usage API", bars: [] });
    const locked = ultra("z", 40, "2026-11-02T09:00:00+01:00", null);
    expect(
      accountRow({ ...locked, usage: { ...locked.usage, blocked: true } }, undefined, ES),
    ).toMatchObject({ state: "out", line: "bloqueada por el proveedor" });
  });

  it("draws a Team seat with no weekly in its reading with its 5 hours and its Fable, no week, with its threads", () => {
    const row = accountRow(team("team2", 51, "2026-10-31T00:00:00+01:00", 89), seats(2, 2, 1), ES);
    expect(row).toMatchObject({
      state: "working",
      planShort: "Team",
      when: "vuelve mañana 00:00",
      line: "2 de 2 hilos · 1 esperando",
      bar: { kind: "five", used: 51, today: 0, tone: "green", label: "Ha gastado el 51 % de las 5 h" },
    });
    expect(row.bars.map((b) => [b.name, b.figure, b.tone])).toEqual([
      ["5 h", "51 %", "green"],
      ["Fable", "89 %", "amber"],
    ]);
    expect(row.help).not.toContain("semana");
    expect(accountRow(team("team1", 0, null, 76), seats(0, 2), EN)).toMatchObject({
      state: "free",
      word: "Free",
      when: "not started",
      line: "0 of 2 threads",
    });
  });

  it("draws no week on a Team seat whose reading has no general weekly, named Team or not", () => {
    const seat = team("t", 20, "2026-10-31T00:00:00+01:00", 30);
    for (const account of [seat, { ...seat, plan: undefined }]) {
      const row = accountRow(account, undefined, ES);
      expect(row.team).toBe(true);
      expect(row.bars.map((b) => b.kind)).toEqual(["five", "model"]);
      expect(row.bars.map((b) => b.label).join(" ")).not.toMatch(/semana/);
    }
  });

  // Aitor, 2026-11-07: «no entiendo por qué pone agotada si tiene fable».
  // team4 read 5 h 0 % (not started), its general weekly 100 % till Monday
  // 17:00 and Fable 85 %; a Fable turn there answered «You've hit your weekly
  // limit». A Team seat reports a general weekly since 0.2.39: the week is
  // drawn when the reading has it, and says why the seat is out.
  it("draws a Team seat's week when its reading has one, and says it when the week is what runs it out (team4, 2026-11-07)", () => {
    const seat = team("team4", 0, null, 85);
    const team4 = { ...seat, usage: { ...seat.usage, weekly: win(100, at("2026-11-02T17:00:00+01:00")) } };
    const row = accountRow(team4, seats(0, 5), ES);
    expect(row).toMatchObject({ state: "out", word: "Agotada", team: true, planShort: "Team", when: "vuelve lun 17:00" });
    expect(row.bars.map((b) => [b.kind, b.figure, b.today, b.resets])).toEqual([
      ["five", "0 %", 0, ""],
      ["week", "100 %", 0, "se reinicia el lunes 2, 17:00"],
      ["model", "85 %", 0, "se reinicia el lunes 2, 21:55"],
    ]);
    expect(row.bar).toMatchObject({ kind: "week", label: "Ha gastado el 100 % de la semana" });
    expect(menuLine(row)).toBe("Semana 100 % · vuelve lun 17:00");
    expect(threadLine(row)).toBe("Team · ha gastado el 100 % de la semana · vuelve lun 17:00");
    expect(cardLine(row)).toBe("Team · vuelve lun 17:00");
    expect(row.help).toContain("Ha gastado el 100 % de la semana · se reinicia el lunes 2, 17:00");
    // Measured without a reset (the reset is optional in the answer): still
    // its week, out, with no «vuelve» to give (Codex Sol r1 medium, its sibling).
    const noReset = accountRow({ ...team4, usage: { ...team4.usage, weekly: win(100, null) } }, seats(0, 5), ES);
    expect(noReset).toMatchObject({ state: "out", when: "", bar: { kind: "week", figure: "100 %" } });
    expect(menuLine(noReset)).toBe("Semana 100 %");
    // The cut: at 99 % its week does not run it out; its 5 hours and threads speak.
    const edge = accountRow({ ...team4, usage: { ...team4.usage, weekly: win(99, at("2026-11-02T17:00:00+01:00")) } }, seats(0, 5), ES);
    expect(edge).toMatchObject({ state: "free", when: "sin empezar", line: "0 de 5 hilos", bar: { kind: "five" } });
    expect(menuLine(edge)).toBe("5 h 0 % · sin empezar");
    // A week with room: drawn, but the 5 hours still say when it is back.
    const roomy = { ...seat, usage: { ...seat.usage, session: win(20, at("2026-10-31T00:00:00+01:00")), weekly: win(55, NOW + 72 * H) } };
    const free = accountRow(roomy, seats(0, 5), ES);
    expect(free).toMatchObject({ state: "free", when: "vuelve mañana 00:00", bar: { kind: "five" } });
    expect(free.bars.map((b) => [b.kind, b.figure, b.today])).toEqual([
      ["five", "20 %", 0],
      ["week", "55 %", 0],
      ["model", "85 %", 0],
    ]);
    expect(menuLine(free)).toBe("5 h 20 % · vuelve mañana 00:00");
    // A pace sent for it does not shade a day's budget on its week.
    const paced = accountRow({ ...roomy, pace: { budget: 10, spent: 2, dayPercent: 20, background: true } }, seats(0, 5), ES);
    expect(paced.bars.find((b) => b.kind === "week")?.today).toBe(0);
    expect(paced.state).toBe("free");
  });

  it("draws an Ultra out of its week as before", () => {
    const row = accountRow(ultra("u", 100, "2026-11-02T09:00:00+01:00", { budget: 10, spent: 1 }), undefined, ES);
    expect(row).toMatchObject({ state: "out", team: false, when: "vuelve lun 09:00", bar: { kind: "week", figure: "100 %" } });
    expect(row.bars.map((b) => b.kind)).toEqual(["five", "week", "model"]);
    expect(menuLine(row)).toBe("Semana 100 % · vuelve lun 09:00");
  });

  it("draws the preferred model's bar only when the account's usage has that window", () => {
    const a = ultra("a", 40, "2026-11-02T09:00:00+01:00", null);
    const kinds = (models: Record<string, ReturnType<typeof win>>, preferredModel = "Fable") =>
      accountRow({ ...a, usage: { ...a.usage, models } }, undefined, { ...ES, preferredModel }).bars.map(
        (b) => b.name,
      );
    expect(kinds({ Fable: win(20, NOW + H) })).toEqual(["5 h", "Semana", "Fable"]);
    expect(kinds({})).toEqual(["5 h", "Semana"]);
    expect(kinds({ Opus: win(20, NOW + H) })).toEqual(["5 h", "Semana"]);
    // No preferred model: no model bar at all.
    expect(kinds({ Fable: win(20, NOW + H) }, "")).toEqual(["5 h", "Semana"]);
    // The name as the usage writes it, matched without case.
    expect(kinds({ fable: win(20, NOW + H) })).toEqual(["5 h", "Semana", "fable"]);
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
    expect(es).toBe("Trabajan **studio, ganaresenas, team2, team3**. La que menos semana ha gastado es **agency** (0 %).");
    expect(said(panelList(realState(), OFF_EN).sentence)).not.toContain("Kept");
    expect(
      panelList(realState(), OFF_ES).groups.flatMap((g) => g.rows).filter((r) => r.state === "kept"),
    ).toEqual([]);
  });
});

describe("panelList", () => {
  it("says who works, who is kept and which has spent least of its week, then the two groups in order", () => {
    const list = panelList(realState(), ES);
    expect(said(list.sentence)).toBe(
      "Trabajan **studio, ganaresenas, team2, team3**. Guardadas para ti: **viaulab y aitor**. La que menos semana ha gastado es **agency** (0 %).",
    );
    expect(list.groups.map((g) => g.title)).toEqual([
      "Ultra · lo gastado",
      "Team · lo gastado",
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
      "Working: **studio, ganaresenas, team2, team3**. Kept for you: **viaulab and aitor**. Least of the week spent: **agency** (0 %).",
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
    expect(panelList(mixed, ES).groups[0].title).toBe("Ultra y Max · lo gastado");
    expect(panelList(mixed, EN).groups[0].title).toBe("Ultra and Max · what is spent");
    expect(panelList(realState(), EN).groups.map((g) => g.title)).toEqual(["Ultra · what is spent", "Team · what is spent"]);
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
      "Ultra · sin tope de 5 h · ha gastado el 60 % de la semana · vuelve lun 09:00",
    );
    expect(menuLine(aitor)).toBe("Semana 60 % · vuelve lun 09:00");
    // The card's bars say what is spent: its line only the plan and when.
    expect(cardLine(aitor)).toBe("Ultra · sin tope de 5 h · vuelve lun 09:00");
    const team2 = accountRow(team("team2", 51, "2026-10-31T00:00:00+01:00", 89), seats(2, 2, 1), EN);
    expect(threadLine(team2)).toBe("Team · used 51 % of the 5 hours · back tomorrow 00:00");
    // A Team seat's menu line is its 5 hours (no weekly in its reading).
    expect(menuLine(team2)).toBe("5 h 51 % · back tomorrow 00:00");
    const mariscal = accountRow(
      { name: "mariscal", problem: { kind: "unauthenticated" }, usage: null, plan: "ultra", fiveHour: null },
      undefined,
      ES,
    );
    expect(threadLine(mariscal)).toBe("Ultra · sin sesión iniciada");
    expect(cardLine(mariscal)).toBe("Ultra · sin sesión iniciada");
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
