// What the Settings section and the account menu say of each account
// (Optimizador informes/2026-10-30/ultra/propuestas/DISENO.md, design B):
// a sentence on top, then one row per account with a thin bar per window
// it has (5 h, week, the preferred model), each filled with what is SPENT
// (Aitor, 2026-11-02), today's share after the week's, its state as an
// icon and a word, and when it is back. Pure, so every text
// has a test; app.tsx only draws it. The words match the Mac menu-bar app
// (cuentas-claude, Sources/CuentasCore/Lista.swift) so both say the same.

import { DAY_ZONE } from "./pace.js";
import { windowForecast } from "./ui.js";

export type Lang = "es" | "en";

/** Spanish for a browser set to any Spanish, English otherwise (the plugin is public). */
export function uiLang(language: string | undefined): Lang {
  return language?.toLowerCase().startsWith("es") === true ? "es" : "en";
}

const NUMBERS: Record<Lang, Intl.NumberFormat> = {
  es: new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, useGrouping: false }),
  en: new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, useGrouping: false }),
};

/** «24,3» in Spanish, «24.3» in English; one decimal at most (the forecast's pace has one). */
export function formatNumber(n: number, lang: Lang): string {
  return NUMBERS[lang].format(n);
}

const DAY_MS = 86_400_000;
const DAYS: Record<Lang, string[]> = {
  es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const LONG_DAYS: Record<Lang, string[]> = {
  es: [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ],
  en: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
};
const MONTHS: Record<Lang, string[]> = {
  es: [
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "sept",
    "oct",
    "nov",
    "dic",
  ],
  en: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
};
const TODAY: Record<Lang, [string, string, string]> = {
  es: ["hoy", "mañana", "ayer"],
  en: ["today", "tomorrow", "yesterday"],
};

/**
 * The wall clock of `at` in `timeZone`; Madrid's when undefined, never the
 * browser's: the day and the resets are Madrid's (DISENO.md; Codex
 * ULTRA-R2-005).
 */
function clock(at: number, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? DAY_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  return {
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    /** Days since the epoch of the calendar day there. */
    dayNumber: Date.UTC(year, month - 1, day) / DAY_MS,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function whenParts(at: number, now: number, timeZone?: string) {
  const target = clock(at, timeZone);
  return { target, days: target.dayNumber - clock(now, timeZone).dayNumber };
}

/** «hoy 22:00», «mañana 11:00», «lun 09:00» within six days, «6 nov 12:00» beyond. */
export function whenShort(
  at: number,
  now: number,
  lang: Lang,
  timeZone?: string,
): string {
  const { target, days } = whenParts(at, now, timeZone);
  const day =
    days === 0
      ? TODAY[lang][0]
      : days === 1
        ? TODAY[lang][1]
        : days === -1
          ? TODAY[lang][2]
          : days >= 2 && days < 7
            ? DAYS[lang][target.weekday]
            : `${target.day} ${MONTHS[lang][target.month - 1]}`;
  return `${day} ${target.time}`;
}

/** A move's date and time in the history, in Madrid; in `locale` (the browser's when undefined). */
export function moveTime(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale, { timeZone: DAY_ZONE });
}

/** «el lunes 2, 09:00» / «on Monday 2, 09:00»; today and tomorrow as in the short form. */
export function whenLong(
  at: number,
  now: number,
  lang: Lang,
  timeZone?: string,
): string {
  const { target, days } = whenParts(at, now, timeZone);
  if (days === 0 || days === 1) return whenShort(at, now, lang, timeZone);
  const name = LONG_DAYS[lang][target.weekday];
  return `${lang === "es" ? "el" : "on"} ${name} ${target.day}, ${target.time}`;
}

type Window = { usedPercent: number; resetsAt: number | null; absent?: true; missing?: true };

/** An account as the plugin's state carries it (State["accounts"][number]). */
export interface PanelAccount {
  name: string;
  problem: { kind: "unauthenticated" } | { kind: "error"; message: string } | null;
  usage: {
    blocked: boolean;
    unknown?: boolean;
    session: Window;
    weekly: Window;
    models: Record<string, Window>;
  } | null;
  plan?: "ultra" | "max" | "team" | "unknown";
  /** The server's text for the plan (Spanish, as every other screen of the author's). */
  planLabel?: string;
  fiveHour?: boolean | null;
  pace?: { budget: number; spent: number; dayPercent: number; background: boolean } | null;
}

export interface PanelSeats {
  capacity: number;
  running: number;
  reserved: number;
  queued: ReadonlyArray<unknown>;
  external?: ReadonlyArray<unknown>;
}

export interface PanelContext {
  now: number;
  lang: Lang;
  /** The zone the days are counted in; Madrid's when undefined. */
  timeZone?: string;
  preferredModel: string;
  /**
   * The plugin's paceHoldsBackground: only then is an account past its
   * day's share kept for the user (state "kept"). Off or unsaid, no row is
   * kept: the panel never says it saves what nothing saves.
   */
  paceHoldsBackground?: boolean;
}

/** Agotada > Guardada > Trabajando > Libre; «Sin datos» when the read says nothing (DISENO.md §Estados). */
export type PanelState = "out" | "kept" | "working" | "free" | "nodata";

/**
 * One window as a bar of what is SPENT, 0 to 100, filling left to right
 * (Aitor, 2026-11-02: «que salieran hacia completar»; 2026-10-31: «lo que
 * llevo consumido... verde, ámbar, rojo»).
 */
export interface PanelBar {
  /** The 5 hours, the week, or the preferred model's own week. */
  kind: "five" | "week" | "model";
  /** The short name on its left: «5 h», «Semana», «Fable». */
  name: string;
  /** What is spent, 0-100; 0 once its reset has passed. */
  used: number;
  /** «64 %»: what is spent. */
  figure: string;
  /** Today's share not yet spent, right after what is spent (points of the week; only the week's bar). */
  today: number;
  /** By what is spent, the same on every bar: green, amber from 70 %, red from 90 %. */
  tone: "green" | "amber" | "red";
  /** Read out: «Ha gastado el 64 % de la semana». */
  label: string;
  /** «se reinicia lun 09:00», «se reinició hoy 10:00» or "": for the tooltip. */
  resets: string;
}

export interface PanelRow {
  name: string;
  state: PanelState;
  /** «Trabajando», «Libre», «Guardada para ti», «Agotada», «Sin datos». */
  word: string;
  team: boolean;
  /** The plan's chip: «Ultra · con 5 h»; its long form goes in the tooltip. */
  planShort: string;
  planLong: string;
  /** Every window it has, in order: 5 h (none without one), week (never on a Team seat), the preferred model. */
  bars: PanelBar[];
  /** The one that orders the list: the week, or the 5 hours on a Team seat; null without a reading. */
  bar: PanelBar | null;
  /** «vuelve lun 09:00», «sin empezar» or "". */
  when: string;
  /** After the state word under the bar: today's phrase, threads, why not. */
  line: string;
  /** The long form, one fact a line: the tooltip and the screen reader. */
  help: string;
}

const T = {
  es: {
    words: {
      working: "Trabajando",
      free: "Libre",
      kept: "Guardada para ti",
      out: "Agotada",
      nodata: "Sin datos",
    },
    nameFive: "5 h",
    nameWeek: "Semana",
    usedWeek: (n: number) => `Ha gastado el ${formatNumber(n, "es")} % de la semana`,
    usedFive: (n: number) => `Ha gastado el ${formatNumber(n, "es")} % de las 5 h`,
    usedModel: (model: string, n: number) => `Ha gastado el ${formatNumber(n, "es")} % de ${model}`,
    resets: (when: string) => `se reinicia ${when}`,
    didReset: (when: string) => `se reinició ${when}`,
    back: (when: string) => `vuelve ${when}`,
    backLong: (when: string) => `se recupera ${when}`,
    notStarted: "sin empezar",
    todaySpent: "Ya ha gastado lo de hoy",
    todayShare: (n: number) => `Hoy ha gastado el ${formatNumber(n, "es")} % de su parte`,
    modelOut: (model: string, when: string) =>
      when === "" ? `sin ${model}` : `sin ${model} hasta ${when}`,
    threads: (used: number, of: number) => `${used} de ${of} hilos`,
    outside: (n: number) => `${n} fuera de bb`,
    waiting: (n: number) => `${n} esperando`,
    noLogin: "sin sesión iniciada",
    locked: "bloqueada por el proveedor",
    lastFailed: "la última lectura falló",
    failed: (message: string) => `la lectura falló: ${message}`,
    notMeasured: "aún sin medir",
    incomplete: "respuesta incompleta de la API de uso",
    noFive: "Ultra · sin tope de 5 h",
    withFive: "Ultra · con 5 h",
    withFiveLong: "Ultra · 5 h hasta que Anthropic la verifique",
    unknownPlan: "sin datos de plan",
  },
  en: {
    words: {
      working: "Working",
      free: "Free",
      kept: "Kept for you",
      out: "Out",
      nodata: "No data",
    },
    nameFive: "5 h",
    nameWeek: "Week",
    usedWeek: (n: number) => `Used ${formatNumber(n, "en")} % of the week`,
    usedFive: (n: number) => `Used ${formatNumber(n, "en")} % of the 5 hours`,
    usedModel: (model: string, n: number) => `Used ${formatNumber(n, "en")} % of ${model}`,
    resets: (when: string) => `resets ${when}`,
    didReset: (when: string) => `reset ${when}`,
    back: (when: string) => `back ${when}`,
    backLong: (when: string) => `back ${when}`,
    notStarted: "not started",
    todaySpent: "Today's share is spent",
    todayShare: (n: number) => `Spent ${formatNumber(n, "en")} % of today's share`,
    modelOut: (model: string, when: string) =>
      when === "" ? `no ${model}` : `no ${model} until ${when}`,
    threads: (used: number, of: number) => `${used} of ${of} threads`,
    outside: (n: number) => `${n} outside bb`,
    waiting: (n: number) => `${n} waiting`,
    noLogin: "not logged in",
    locked: "locked by the provider",
    lastFailed: "the last read failed",
    failed: (message: string) => `the read failed: ${message}`,
    notMeasured: "not measured yet",
    incomplete: "incomplete answer from the usage API",
    noFive: "Ultra · no 5-hour cap",
    withFive: "Ultra · with 5 h",
    withFiveLong: "Ultra · 5-hour window until Anthropic verifies it",
    unknownPlan: "plan unknown",
  },
} as const;

/** Never «100 %» used for a window with a little room; 0 once its reset has passed. */
function usedOf(w: Window, now: number): number {
  const used = w.resetsAt !== null && w.resetsAt <= now ? 0 : w.usedPercent;
  return used < 100 ? Math.max(0, Math.min(99, Math.round(used))) : 100;
}

/** The colour of what is spent, the same on every bar: green, amber from 70 %, red from 90 % (Aitor, 2026-10-31). */
export function toneOf(used: number): PanelBar["tone"] {
  return used >= 90 ? "red" : used >= 70 ? "amber" : "green";
}

function isTeam(a: PanelAccount): boolean {
  return a.plan === "team" || (a.plan === undefined && a.usage?.weekly.absent === true);
}

function planTexts(a: PanelAccount, lang: Lang): { short: string; long: string } {
  const t = T[lang];
  if (isTeam(a)) return { short: "Team", long: "Team" };
  switch (a.plan) {
    case "ultra":
      return a.fiveHour === false
        ? { short: t.noFive, long: t.noFive }
        : a.fiveHour === true
          ? { short: t.withFive, long: t.withFiveLong }
          : { short: "Ultra", long: "Ultra" };
    case "max":
      return { short: "Max", long: "Max" };
    case "unknown": {
      // The server's own text says more («Max o Ultra»), in Spanish.
      const text = lang === "es" ? (a.planLabel ?? t.unknownPlan) : t.unknownPlan;
      return { short: text, long: text };
    }
    default:
      return { short: "", long: "" };
  }
}

function seatsUsed(seats: PanelSeats | undefined): number {
  if (seats === undefined) return 0;
  return seats.running + seats.reserved + (seats.external?.length ?? 0);
}

export function accountRow(
  account: PanelAccount,
  seats: PanelSeats | undefined,
  ctx: PanelContext,
): PanelRow {
  const { now, lang, timeZone } = ctx;
  const t = T[lang];
  const team = isTeam(account);
  const plan = planTexts(account, lang);
  const usage = account.usage;
  const whole = usage !== null && usage.unknown !== true;
  const noLogin = account.problem?.kind === "unauthenticated";
  const short = (at: number) => whenShort(at, now, lang, timeZone);
  const long = (at: number) => whenLong(at, now, lang, timeZone);
  const ahead = (at: number | null): at is number => at !== null && at > now;

  // The window that orders the list and says when it is back: the week,
  // or the 5 hours on a Team seat. A Team seat's general weekly, when its
  // reading has one, stops it too (Aitor, 2026-11-07, team4: see the bars);
  // one its reading lacks is absent, at 0 %, and stops nothing.
  const main = !whole ? null : team ? usage.session : usage.weekly;
  // Never by a week nobody measured: an answer with no weekly_all but a
  // lock is whole, its week `missing` at 100 % (Astra r2 low).
  const weekOut =
    whole && team && usage.weekly.missing !== true && usedOf(usage.weekly, now) >= 100;
  const limits = !whole
    ? []
    : [
        ...(usage.session.absent === true ? [] : [usage.session]),
        usage.weekly,
      ];
  const full = limits.filter((w) => usedOf(w, now) >= 100);
  const locked = whole && usage.blocked;
  const out = noLogin || locked || full.length > 0;
  const pace = account.pace;
  const state: PanelState = noLogin
    ? "out"
    : !whole
      ? "nodata"
      : out
        ? "out"
        : ctx.paceHoldsBackground === true &&
            !team &&
            (pace === null || pace?.background === false)
          ? "kept"
          : seatsUsed(seats) > 0
            ? "working"
            : "free";

  // When it is back: what stops an account that is out, else the bar's reset.
  let when = "";
  let whenAt: number | null = null;
  if (out) {
    const resets = full.map((w) => w.resetsAt);
    if (resets.length > 0 && resets.every(ahead)) whenAt = Math.max(...resets);
  } else if (main !== null) {
    if (team && usedOf(main, now) === 0) when = t.notStarted;
    else if (ahead(main.resetsAt)) whenAt = main.resetsAt;
  }
  if (whenAt !== null) when = t.back(short(whenAt));

  const model = !whole
    ? undefined
    : Object.entries(usage.models).find(
        ([name]) =>
          ctx.preferredModel !== "" &&
          name.toLowerCase() === ctx.preferredModel.toLowerCase(),
      );
  const queued = seats?.queued.length ?? 0;
  const external = seats?.external?.length ?? 0;
  const parts: string[] = [];
  if (noLogin) parts.push(t.noLogin);
  else if (!whole)
    parts.push(
      usage?.unknown === true
        ? t.incomplete
        : account.problem?.kind === "error"
          ? t.failed(account.problem.message)
          : t.notMeasured,
    );
  else if (locked) parts.push(t.locked);
  // Out of its week, a Team seat says the week as an Ultra does (its bar),
  // not its threads (2026-11-07).
  if (whole && team && !weekOut) {
    if (seats !== undefined && seats.capacity > 0)
      parts.push(t.threads(seatsUsed(seats), seats.capacity));
  }
  if (whole && !team && !out) {
    if (pace !== null && pace !== undefined)
      parts.push(
        pace.dayPercent >= 90
          ? t.todaySpent
          : t.todayShare(Math.floor(Math.max(0, pace.dayPercent))),
      );
    if (model !== undefined && usedOf(model[1], now) >= 100)
      parts.push(
        t.modelOut(model[0], ahead(model[1].resetsAt) ? short(model[1].resetsAt) : ""),
      );
  }
  if (external > 0 && (team || state === "working")) parts.push(t.outside(external));
  if (queued > 0) parts.push(t.waiting(queued));
  if (whole && account.problem?.kind === "error") parts.push(t.lastFailed);
  const line = parts.join(" · ");

  // One bar per window: a reset that has passed shows 0 %, never hidden.
  const barOf = (
    kind: PanelBar["kind"],
    name: string,
    w: Window,
    label: (n: number) => string,
    today = 0,
  ): PanelBar => {
    const used = usedOf(w, now);
    return {
      kind,
      name,
      used,
      figure: `${formatNumber(used, lang)} %`,
      today,
      tone: toneOf(used),
      label: label(used),
      resets:
        w.resetsAt === null
          ? ""
          : w.resetsAt > now
            ? t.resets(long(w.resetsAt))
            : t.didReset(long(w.resetsAt)),
    };
  };
  const weekUsed = whole && !team ? usedOf(usage.weekly, now) : 100;
  const bars: PanelBar[] = !whole
    ? []
    : [
        ...(usage.session.absent === true
          ? []
          : [barOf("five", t.nameFive, usage.session, t.usedFive)]),
        // On a Team seat too when its reading has a general weekly (Aitor,
        // 2026-11-07: «no entiendo por qué pone agotada si tiene fable»):
        // team4 read 5 h 0 %, Fable 85 % and its week 100 %, and a Fable turn
        // there answered «You've hit your weekly limit». The rule of
        // 2026-11-02 («never on a Team seat») held while Team seats reported
        // no week. No day's budget on it: the panel holds no Team seat back
        // by its pace (weekUsed is 100 there).
        // Nor a week nobody measured (`missing`, see weekOut), on any plan.
        ...(usage.weekly.absent === true || usage.weekly.missing === true
          ? []
          : [
              barOf(
                "week",
                t.nameWeek,
                usage.weekly,
                t.usedWeek,
                weekUsed >= 100 || pace === null || pace === undefined
                  ? 0
                  : Math.max(0, Math.min(100 - weekUsed, pace.budget - pace.spent)),
              ),
            ]),
        ...(model === undefined
          ? []
          : [barOf("model", model[0], model[1], (n) => t.usedModel(model[0], n))]),
      ];
  // A Team seat's 5 hours, unless its week is what runs it out.
  const bar = bars.find((b) => b.kind === (team && !weekOut ? "five" : "week")) ?? null;
  return {
    name: account.name,
    state,
    word: t.words[state],
    team,
    planShort: plan.short,
    planLong: plan.long,
    bars,
    bar,
    when,
    line,
    help: [
      plan.long,
      ...bars.map((b) => [b.label, b.resets].filter((s) => s !== "").join(" · ")),
      // When it is out, when it is back (each bar's own reset is above).
      out && whenAt !== null ? t.backLong(long(whenAt)) : "",
      line,
    ]
      .filter((s) => s !== "")
      .join("\n"),
  };
}

const LIST = {
  es: {
    weekly: (onlyUltra: boolean) =>
      `${onlyUltra ? "Ultra" : "Ultra y Max"} · lo gastado`,
    team: "Team · lo gastado",
    work: (n: number) => (n === 1 ? "Trabaja " : "Trabajan "),
    none: "Ahora no trabaja ninguna.",
    kept: (n: number) => (n === 1 ? " Guardada para ti: " : " Guardadas para ti: "),
    most: " La que menos semana ha gastado es ",
    and: " y ",
  },
  en: {
    weekly: (onlyUltra: boolean) =>
      `${onlyUltra ? "Ultra" : "Ultra and Max"} · what is spent`,
    team: "Team · what is spent",
    work: () => "Working: ",
    none: "No account is working now.",
    kept: () => " Kept for you: ",
    most: " Least of the week spent: ",
    and: " and ",
  },
} as const;

export interface Piece {
  text: string;
  bold: boolean;
}

export interface PanelList {
  /** The sentence on top; the names in bold. */
  sentence: Piece[];
  groups: { title: string; rows: PanelRow[] }[];
}

/** «aitor», «aitor y viaulab», «aitor, ganaresenas y viaulab». */
function enumerate(names: string[], and: string): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
}

/**
 * The accounts as design B draws them: the Ultra and Max ones by what they
 * have spent of their week, least first (no reading last), then the Team
 * seats by name; and the sentence that says who works, who is kept for the
 * user and which free one has spent least of its week.
 */
export function panelList(
  state: {
    accounts: ReadonlyArray<PanelAccount>;
    seats?: Readonly<Record<string, PanelSeats>>;
  },
  ctx: PanelContext,
): PanelList {
  const t = LIST[ctx.lang];
  const rows = state.accounts.map((a) => ({
    account: a,
    row: accountRow(a, state.seats?.[a.name], ctx),
  }));
  const weekly = rows
    .filter((r) => !r.row.team)
    .sort(
      (a, b) =>
        (a.row.bar?.used ?? 101) - (b.row.bar?.used ?? 101) ||
        a.row.name.localeCompare(b.row.name),
    );
  const teams = rows
    .filter((r) => r.row.team)
    .sort((a, b) => a.row.name.localeCompare(b.row.name));
  const groups: PanelList["groups"] = [];
  if (weekly.length > 0)
    groups.push({
      title: t.weekly(weekly.every((r) => r.account.plan === "ultra")),
      rows: weekly.map((r) => r.row),
    });
  if (teams.length > 0) groups.push({ title: t.team, rows: teams.map((r) => r.row) });

  const all = groups.flatMap((g) => g.rows);
  const working = all.filter((r) => r.state === "working").map((r) => r.name);
  const kept = all.filter((r) => r.state === "kept").map((r) => r.name);
  const sentence: Piece[] =
    working.length === 0
      ? [{ text: t.none, bold: false }]
      : [
          { text: t.work(working.length), bold: false },
          { text: working.join(", "), bold: true },
          { text: ".", bold: false },
        ];
  if (kept.length > 0)
    sentence.push(
      { text: t.kept(kept.length), bold: false },
      { text: enumerate(kept, t.and), bold: true },
      { text: ".", bold: false },
    );
  // The free Ultra or Max that has spent least of its week: the first free one of its group.
  const most = weekly.find((r) => r.row.state === "free")?.row;
  if (most?.bar)
    sentence.push(
      { text: t.most, bold: false },
      { text: most.name, bold: true },
      { text: ` (${most.bar.figure}).`, bold: false },
    );
  return { sentence, groups };
}

/** Why an account cannot be read or used, when that is what matters. */
function whyNot(row: PanelRow): string | null {
  return (row.state === "out" || row.state === "nodata") && row.line !== ""
    ? row.line
    : null;
}

/** The thread's account in one line: «Ultra · sin tope de 5 h · ha gastado el 40 % de la semana · vuelve lun 09:00». */
export function threadLine(row: PanelRow): string {
  const spent =
    row.bar === null
      ? null
      : row.bar.label.charAt(0).toLowerCase() + row.bar.label.slice(1);
  return [row.planShort, whyNot(row) ?? spent, row.when]
    .filter((s) => s !== null && s !== "")
    .join(" · ");
}

/** Under the bars of the thread's card: «Ultra · sin tope de 5 h · vuelve lun 09:00» (the bars say what is spent). */
export function cardLine(row: PanelRow): string {
  return [row.planShort, whyNot(row), row.when]
    .filter((s) => s !== null && s !== "")
    .join(" · ");
}

/** An account in the menu, after its state: «Semana 40 % · vuelve lun 09:00» (on a Team seat, «5 h 49 %»). */
export function menuLine(row: PanelRow): string {
  return [whyNot(row) ?? (row.bar === null ? null : `${row.bar.name} ${row.bar.figure}`), row.when]
    .filter((s) => s !== null && s !== "")
    .join(" · ");
}

const WORDS = {
  es: {
    refresh: "Actualizar",
    refreshing: "Actualizando…",
    logIn: "Iniciar sesión",
    logInAgain: "Iniciar sesión otra vez",
    sameAs: (name: string) =>
      `Misma cuenta de Claude que ${name}: comparten el uso`,
    noFigure: "sin dato",
  },
  en: {
    refresh: "Refresh",
    refreshing: "Refreshing…",
    logIn: "Log in",
    logInAgain: "Log in again",
    sameAs: (name: string) => `Same Claude account as ${name}: they share one usage`,
    noFigure: "no reading",
  },
} as const;

/** The view's other words: its buttons and notes. */
export function panelWords(lang: Lang) {
  return WORDS[lang];
}

type ForecastLike =
  | { kind: "runs-out"; at: number; percentPerDay: number }
  | { kind: "lasts"; until: number; percentPerDay: number }
  | { kind: "steady" }
  | { kind: "unknown" };

/** «en 2 d 5 h», «en 3 h», «en 40 min», «ya». */
function inTime(ms: number, lang: Lang): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return lang === "es" ? "ya" : "now";
  const pre = lang === "es" ? "en" : "in";
  if (minutes < 60) return `${pre} ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${pre} ${hours} h`;
  return `${pre} ${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/**
 * The pace of the window that matters for an account (its preferred
 * model's, else its weekly one; windowForecast in src/ui.ts):
 * «Fable: se acaba en 20 h a este ritmo (30 %/día)». Null when there is
 * nothing worth saying.
 */
export function forecastText(
  forecasts: Record<string, Record<string, ForecastLike>> | undefined,
  account: string,
  preferredModel: string,
  now: number,
  lang: Lang,
): string | null {
  const picked = windowForecast(forecasts, account, preferredModel);
  if (picked === null) return null;
  const [key, f] = picked;
  const name = key === "weekly" ? (lang === "es" ? "Semana" : "Week") : key;
  const es = lang === "es";
  const pace = (f: { percentPerDay: number }) => formatNumber(f.percentPerDay, lang);
  switch (f.kind) {
    case "runs-out":
      return es
        ? `${name}: se acaba ${inTime(f.at - now, lang)} a este ritmo (${pace(f)} %/día)`
        : `${name}: runs out ${inTime(f.at - now, lang)} at this pace (${pace(f)} %/day)`;
    case "lasts":
      return es
        ? `${name}: llega al reinicio a este ritmo (${pace(f)} %/día)`
        : `${name}: lasts until the reset at this pace (${pace(f)} %/day)`;
    default:
      return null;
  }
}
