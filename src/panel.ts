// What the Settings section and the account menu say of each account
// (Optimizador informes/2026-10-30/ultra/propuestas/DISENO.md, design B):
// a sentence on top, then one row per account with what is LEFT of its
// week (of its 5 hours on a Team seat), today's share striped at the end,
// its state as an icon and a word, and when it is back. Pure, so every text
// has a test; app.tsx only draws it. The words match the Mac menu-bar app
// (cuentas-claude, Sources/CuentasCore/Lista.swift) so both say the same.

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

/** The wall clock of `at` in `timeZone` (the browser's own when undefined). */
function clock(at: number, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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

type Window = { usedPercent: number; resetsAt: number | null; absent?: true };

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
  /** The zone the days are counted in; the browser's own when undefined. */
  timeZone?: string;
  preferredModel: string;
}

/** Agotada > Guardada > Trabajando > Libre; «Sin datos» when the read says nothing (DISENO.md §Estados). */
export type PanelState = "out" | "kept" | "working" | "free" | "nodata";

export interface PanelBar {
  /** What is left, 0-100: of the week, or of the 5 hours on a Team seat. */
  left: number;
  /** Today's share not yet spent, at the end of what is left (points of the week). */
  today: number;
  tone: "green" | "amber" | "empty" | "blue";
  /** «Le queda el 90 % de la semana». */
  label: string;
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
  bar: PanelBar | null;
  /** «90 %»: what is left. */
  figure: string | null;
  /** «de la semana» / «de las 5 h». */
  figureOf: string;
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
    ofWeek: "de la semana",
    ofFive: "de las 5 h",
    leftWeek: (n: number) => `Le queda el ${formatNumber(n, "es")} % de la semana`,
    leftFive: (n: number) => `Le queda el ${formatNumber(n, "es")} % de las 5 h`,
    back: (when: string) => `vuelve ${when}`,
    backLong: (when: string) => `se recupera ${when}`,
    notStarted: "sin empezar",
    todaySpent: "Ya ha gastado lo de hoy",
    todayShare: (n: number) => `Hoy ha gastado el ${formatNumber(n, "es")} % de su parte`,
    modelAt: (model: string, n: number) => `${model} al ${formatNumber(n, "es")} %`,
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
    ofWeek: "of the week",
    ofFive: "of the 5 hours",
    leftWeek: (n: number) => `${formatNumber(n, "en")} % of the week left`,
    leftFive: (n: number) => `${formatNumber(n, "en")} % of the 5 hours left`,
    back: (when: string) => `back ${when}`,
    backLong: (when: string) => `back ${when}`,
    notStarted: "not started",
    todaySpent: "Today's share is spent",
    todayShare: (n: number) => `Spent ${formatNumber(n, "en")} % of today's share`,
    modelAt: (model: string, n: number) => `${model} at ${formatNumber(n, "en")} %`,
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

  // The window the bar draws: the week, or the 5 hours on a Team seat.
  const main = !whole ? null : team ? usage.session : usage.weekly;
  const left = main === null ? null : 100 - usedOf(main, now);
  const limits = !whole
    ? []
    : [
        ...(usage.session.absent === true ? [] : [usage.session]),
        ...(team ? [] : [usage.weekly]),
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
        : !team && (pace === null || pace?.background === false)
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
  if (whole && team) {
    if (model !== undefined) parts.push(t.modelAt(model[0], usedOf(model[1], now)));
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

  const bar: PanelBar | null =
    left === null
      ? null
      : {
          left,
          today:
            team || left === 0 || pace === null || pace === undefined
              ? 0
              : Math.max(0, Math.min(left, pace.budget - pace.spent)),
          tone: team ? "blue" : left === 0 ? "empty" : left <= 15 ? "amber" : "green",
          label: team ? t.leftFive(left) : t.leftWeek(left),
        };
  const rest =
    bar === null
      ? null
      : `${bar.label}${whenAt === null ? "" : ` · ${t.backLong(long(whenAt))}`}`;
  return {
    name: account.name,
    state,
    word: t.words[state],
    team,
    planShort: plan.short,
    planLong: plan.long,
    bar,
    figure: left === null ? null : `${formatNumber(left, lang)} %`,
    figureOf: team ? t.ofFive : t.ofWeek,
    when,
    line,
    help: [plan.long, rest, line].filter((s) => s !== null && s !== "").join("\n"),
  };
}

const LIST = {
  es: {
    weekly: (onlyUltra: boolean) =>
      `${onlyUltra ? "Ultra" : "Ultra y Max"} · lo que queda de la semana`,
    team: "Team · lo que queda de sus 5 h",
    work: (n: number) => (n === 1 ? "Trabaja " : "Trabajan "),
    none: "Ahora no trabaja ninguna.",
    kept: (n: number) => (n === 1 ? " Guardada para ti: " : " Guardadas para ti: "),
    most: " La que más semana tiene es ",
    and: " y ",
  },
  en: {
    weekly: (onlyUltra: boolean) =>
      `${onlyUltra ? "Ultra" : "Ultra and Max"} · what is left of the week`,
    team: "Team · what is left of their 5 hours",
    work: () => "Working: ",
    none: "No account is working now.",
    kept: () => " Kept for you: ",
    most: " Most of the week left: ",
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
 * The accounts as design B draws them: the Ultra and Max ones by what is
 * left of their week, most first (no reading last), then the Team seats by
 * name; and the sentence that says who works, who is kept for the user and
 * which free one has most week left.
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
        (b.row.bar?.left ?? -1) - (a.row.bar?.left ?? -1) ||
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
  // The free Ultra or Max with most week: the first free one of its group.
  const most = weekly.find((r) => r.row.state === "free")?.row;
  if (most?.bar)
    sentence.push(
      { text: t.most, bold: false },
      { text: most.name, bold: true },
      { text: ` (${formatNumber(most.bar.left, ctx.lang)} %).`, bold: false },
    );
  return { sentence, groups };
}

/** Why an account cannot be read or used, when that is what matters. */
function whyNot(row: PanelRow): string | null {
  return (row.state === "out" || row.state === "nodata") && row.line !== ""
    ? row.line
    : null;
}

/** The thread's account in one line: «Ultra · sin tope de 5 h · le queda el 40 % de la semana · vuelve lun 09:00». */
export function threadLine(row: PanelRow): string {
  const left =
    row.bar === null
      ? null
      : row.bar.label.charAt(0).toLowerCase() + row.bar.label.slice(1);
  return [row.planShort, whyNot(row) ?? left, row.when]
    .filter((s) => s !== null && s !== "")
    .join(" · ");
}

/** An account in the menu, after its state: «40 % de la semana · vuelve lun 09:00». */
export function menuLine(row: PanelRow): string {
  return [whyNot(row) ?? (row.figure === null ? null : `${row.figure} ${row.figureOf}`), row.when]
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
