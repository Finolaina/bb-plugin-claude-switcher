// What the Settings section and the account menu say of each account
// (Optimizador informes/2026-10-30/ultra/propuestas/DISENO.md, design B):
// a sentence on top, then one row per account with what is LEFT of its
// week (of its 5 hours on a Team seat), today's share striped at the end,
// its state as an icon and a word, and when it is back. Pure, so every text
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
  /** Fable's week as the brake reads it (src/pace.ts, fableRoom); null on a Team seat. */
  fable?: {
    left: number;
    reserve: number;
    open: boolean;
    why: "pace" | "reserve" | "unknown" | null;
    pace: { budget: number; spent: number; dayPercent: number; background: boolean } | null;
    nextAt: number | null;
    resetsAt: number | null;
  } | null;
  /** Who spent its Fable on this computer: percentages from `fable-quien.json`. */
  who?: { interactivo: number; fondo: number; hilos: number } | null;
  /** A reading that went down with no reset, per window: the highest seen (see trackDrop). */
  dropped?: { fable?: number; week?: number; five?: number } | null;
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
 * What has been spent, 0 to 100, in every bar (Aitor, 2026-10-31: «en el plugin
 * me gusta más ver lo que llevo consumido, que se vayan coloreando según
 * avanzan y no para atrás»).
 */
export interface PanelBar {
  /** What is spent, 0-100: figure, bar and label say the same. */
  used: number;
  /** Today's share not yet spent, right after what is spent (points of the week). */
  today: number;
  tone: "green" | "amber" | "red";
  /** «Has gastado el 35 % de la semana de Fable». */
  label: string;
  /** Where the user's reserve starts, in spent percent: a mark on the bar. */
  reserve?: number;
}

/** A window besides the row's main one: the week, the 5 hours, Fable on a Team seat. */
export interface PanelExtra {
  bar: PanelBar;
  figure: string;
  figureOf: string;
  when: string;
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
  /** The other windows the account has, each with its own bar. */
  extras: PanelExtra[];
  /** «90 %»: what is spent. */
  figure: string | null;
  /** «de la semana» / «de las 5 h». */
  figureOf: string;
  /** «se reinicia lun 09:00», «vuelve lun 09:00», «sin empezar» or "". */
  when: string;
  /** After the state word under the bar: today's phrase, threads, why not. */
  line: string;
  /** «La gastó en este ordenador: 70 % tú · 30 % fondo»; null when not measured. */
  who: string | null;
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
    ofFable: "de Fable",
    usedFable: (n: number) => `Has gastado el ${formatNumber(n, "es")} % de la semana de Fable`,
    fableSentence: (n: number, when: string, why: string) =>
      `Fable: gastado el ${formatNumber(n, "es")} % de la semana${when === "" ? "" : ` · se reinicia ${when}`}${why === "" ? "" : ` · ${why}`}`,
    resets: (when: string) => `se reinicia ${when}`,
    didReset: (when: string) => `se reinició ${when}`,
    dropped: (what: string, from: number, to: number) =>
      `Anthropic corrigió ${what}: de ${formatNumber(from, "es")} % a ${formatNumber(to, "es")} % sin reiniciarse`,
    dropNames: { fable: "Fable", week: "la semana", five: "las 5 h" },
    noBackground: "el fondo ya no la usa",
    noBackgroundReserve: "el fondo ya no la usa: solo queda tu reserva",
    noBackgroundToday: "el fondo ya no la usa: ya gastó lo de hoy",
    who: (mine: number, bg: number) =>
      `La gastó en este ordenador: ${formatNumber(mine, "es")} % tú · ${formatNumber(bg, "es")} % fondo`,
    usedWeek: (n: number) => `Ha gastado el ${formatNumber(n, "es")} % de la semana`,
    usedFive: (n: number) => `Ha gastado el ${formatNumber(n, "es")} % de las 5 h`,
    usedModel: (model: string, n: number) => `Ha gastado el ${formatNumber(n, "es")} % de ${model}`,
    back: (when: string) => `vuelve ${when}`,
    backLong: (when: string) => `se recupera ${when}`,
    notStarted: "sin empezar",
    todaySpent: "Ya ha gastado lo de hoy",
    todayShare: (n: number) => `Hoy ha gastado el ${formatNumber(n, "es")} % de su parte`,
    modelOf: (model: string) => `de ${model}`,
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
    ofFable: "of Fable",
    usedFable: (n: number) => `You have spent ${formatNumber(n, "en")} % of Fable's week`,
    fableSentence: (n: number, when: string, why: string) =>
      `Fable: ${formatNumber(n, "en")} % of the week spent${when === "" ? "" : ` · resets ${when}`}${why === "" ? "" : ` · ${why}`}`,
    resets: (when: string) => `resets ${when}`,
    didReset: (when: string) => `reset ${when}`,
    dropped: (what: string, from: number, to: number) =>
      `Anthropic corrected ${what}: from ${formatNumber(from, "en")} % to ${formatNumber(to, "en")} % with no reset`,
    dropNames: { fable: "Fable", week: "the week", five: "the 5 hours" },
    noBackground: "background work no longer uses it",
    noBackgroundReserve: "background work no longer uses it: only your reserve is left",
    noBackgroundToday: "background work no longer uses it: today's share is spent",
    who: (mine: number, bg: number) =>
      `Spent on this computer: ${formatNumber(mine, "en")} % you · ${formatNumber(bg, "en")} % background`,
    usedWeek: (n: number) => `${formatNumber(n, "en")} % of the week spent`,
    usedFive: (n: number) => `${formatNumber(n, "en")} % of the 5 hours spent`,
    usedModel: (model: string, n: number) => `${formatNumber(n, "en")} % of ${model} spent`,
    back: (when: string) => `back ${when}`,
    backLong: (when: string) => `back ${when}`,
    notStarted: "not started",
    todaySpent: "Today's share is spent",
    todayShare: (n: number) => `Spent ${formatNumber(n, "en")} % of today's share`,
    modelOf: (model: string) => `of ${model}`,
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

/** The colour of what is spent: green at first, amber from 70 %, red from 90 %. */
export function toneOf(used: number): PanelBar["tone"] {
  return used >= 90 ? "red" : used >= 70 ? "amber" : "green";
}

/**
 * The highest reading of a window seen so far, kept while its reset stays the
 * same (the API moves it by microseconds; five minutes are the same window). A
 * new reset starts again from the reading: going back to 0 is the reset. A
 * reading lower than the highest in the same window is a correction by the
 * provider: `dropped` says so and the bar shows the reading, never a made-up
 * figure. One point of rounding is no correction.
 */
export function trackDrop(
  seen: { high: number; resetsAt: number | null } | undefined,
  used: number,
  resetsAt: number | null,
): { seen: { high: number; resetsAt: number | null }; dropped: number | null } {
  const same =
    seen !== undefined &&
    seen.resetsAt !== null &&
    resetsAt !== null &&
    Math.abs(seen.resetsAt - resetsAt) <= 5 * 60_000;
  const high = same ? Math.max(seen.high, used) : used;
  return { seen: { high, resetsAt }, dropped: high - used > 1 ? high : null };
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

  // The window the bar draws: Fable's week where the plugin reads it, else
  // the week, or the 5 hours on a Team seat.
  const fable = whole && !team ? (account.fable ?? null) : null;
  const main = !whole ? null : team ? usage.session : usage.weekly;
  const model = !whole
    ? undefined
    : Object.entries(usage.models).find(
        ([name]) =>
          ctx.preferredModel !== "" &&
          name.toLowerCase() === ctx.preferredModel.toLowerCase(),
      );
  const fableWindow = model?.[1];
  const used =
    fable !== null
      ? fableWindow !== undefined
        ? usedOf(fableWindow, now)
        : 100 - Math.round(fable.left)
      : main === null
        ? null
        : usedOf(main, now);
  const limits = !whole
    ? []
    : [
        ...(usage.session.absent === true ? [] : [usage.session]),
        ...(team ? [] : [usage.weekly]),
      ];
  const full = limits.filter((w) => usedOf(w, now) >= 100);
  const locked = whole && usage.blocked;
  const out = noLogin || locked || full.length > 0;
  const pace = fable === null ? account.pace : fable.pace;
  const braked =
    fable !== null && ctx.paceHoldsBackground === true && !fable.open;
  const state: PanelState = noLogin
    ? "out"
    : !whole
      ? "nodata"
      : out
        ? "out"
        : (fable === null
              ? ctx.paceHoldsBackground === true &&
                !team &&
                (pace === null || pace?.background === false)
              : braked && fable.left > 0)
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
    else if (ahead(fable?.resetsAt ?? null)) whenAt = fable!.resetsAt;
    else if (ahead(main.resetsAt)) whenAt = main.resetsAt;
  }
  if (whenAt !== null)
    when = out ? t.back(short(whenAt)) : t.resets(short(whenAt));

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
    if (seats !== undefined && seats.capacity > 0)
      parts.push(t.threads(seatsUsed(seats), seats.capacity));
  }
  // Whether background work runs here, in words (with the brake on).
  const whyBraked = !braked
    ? ""
    : fable.why === "reserve" && fable.left > 0
      ? t.noBackgroundReserve
      : fable.why === "pace"
        ? t.noBackgroundToday
        : t.noBackground;
  if (whole && !team && !out) {
    if (whyBraked !== "" && fable!.left > 0) parts.push(whyBraked);
    else if (pace !== null && pace !== undefined && fable?.left !== 0)
      parts.push(
        pace.dayPercent >= 90
          ? t.todaySpent
          : t.todayShare(Math.floor(Math.max(0, pace.dayPercent))),
      );
    if (
      (model !== undefined && usedOf(model[1], now) >= 100) ||
      (model !== undefined && fable?.left === 0)
    )
      parts.push(
        t.modelOut(model[0], ahead(model[1].resetsAt) ? short(model[1].resetsAt) : ""),
      );
  }
  if (external > 0 && (team || state === "working")) parts.push(t.outside(external));
  if (queued > 0) parts.push(t.waiting(queued));
  if (whole && account.problem?.kind === "error") parts.push(t.lastFailed);
  const correction = (what: "fable" | "week" | "five", reading: number | null) => {
    const from = account.dropped?.[what];
    if (from !== undefined && reading !== null)
      parts.push(t.dropped(t.dropNames[what], from, reading));
  };
  if (whole) {
    correction("fable", fableWindow === undefined ? null : usedOf(fableWindow, now));
    correction("week", team ? null : usedOf(usage.weekly, now));
    correction("five", usage.session.absent === true ? null : usedOf(usage.session, now));
  }
  const line = parts.join(" · ");

  const who =
    account.who === null || account.who === undefined || team
      ? null
      : t.who(account.who.interactivo, account.who.fondo + account.who.hilos);
  const bar: PanelBar | null =
    used === null
      ? null
      : {
          used,
          today:
            team || used >= 100 || pace === null || pace === undefined
              ? 0
              : Math.max(0, Math.min(100 - used, pace.budget - pace.spent)),
          // Past the day's share or into the reserve it is red however little
          // it has spent: "en rojo la que se pasó" (Aitor, 2026-10-31).
          tone:
            fable !== null && braked && fable.why !== "unknown"
              ? "red"
              : toneOf(used),
          label: team
            ? t.usedFive(used)
            : fable !== null
              ? t.usedFable(used)
              : t.usedWeek(used),
          ...(fable !== null && ctx.paceHoldsBackground === true
            ? { reserve: 100 - fable.reserve }
            : {}),
        };
  /** A window with its own bar: back to 0 at its reset, with the hour it happened. */
  const extra = (
    w: Window,
    of: string,
    label: (n: number) => string,
  ): PanelExtra => {
    const n = usedOf(w, now);
    return {
      bar: { used: n, today: 0, tone: toneOf(n), label: label(n) },
      figure: `${formatNumber(n, lang)} %`,
      figureOf: of,
      when:
        w.resetsAt === null
          ? ""
          : w.resetsAt > now
            ? t.resets(short(w.resetsAt))
            : t.didReset(short(w.resetsAt)),
    };
  };
  const extras: PanelExtra[] = !whole
    ? []
    : team
      ? model === undefined
        ? []
        : [extra(model[1], t.modelOf(model[0]), (n) => t.usedModel(model[0], n))]
      : [
          ...(fable === null || usage.weekly.absent === true
            ? []
            : [extra(usage.weekly, t.ofWeek, t.usedWeek)]),
          ...(fable === null && fableWindow !== undefined && model !== undefined
            ? [extra(fableWindow, t.modelOf(model[0]), (n) => t.usedModel(model[0], n))]
            : []),
          ...(usage.session.absent === true ? [] : [extra(usage.session, t.ofFive, t.usedFive)]),
        ];
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
    extras,
    figure: used === null ? null : `${formatNumber(used, lang)} %`,
    figureOf: team ? t.ofFive : fable !== null ? t.ofFable : t.ofWeek,
    when,
    line,
    who,
    help: [
      plan.long,
      fable !== null && used !== null
        ? t.fableSentence(used, whenAt === null ? "" : long(whenAt), whyBraked)
        : rest,
      ...extras.map((e) => `${e.bar.label}${e.when === "" ? "" : ` · ${e.when}`}`),
      line,
      who,
    ]
      .filter((s) => s !== null && s !== "")
      .join("\n"),
  };
}

const LIST = {
  es: {
    weekly: (onlyUltra: boolean, ofFable: boolean) =>
      `${onlyUltra ? "Ultra" : "Ultra y Max"} · lo gastado ${ofFable ? "de Fable esta semana" : "de la semana"}`,
    team: "Team · lo gastado de sus 5 h",
    work: (n: number) => (n === 1 ? "Trabaja " : "Trabajan "),
    none: "En este ordenador no trabaja ninguna.",
    total: (n: number) => ` Entre todas llevan gastado el ${formatNumber(n, "es")} % de Fable.`,
    mostFable: " La menos gastada de Fable es ",
    kept: (n: number) => (n === 1 ? " Guardada para ti: " : " Guardadas para ti: "),
    most: " La menos gastada de la semana es ",
    and: " y ",
  },
  en: {
    weekly: (onlyUltra: boolean, ofFable: boolean) =>
      `${onlyUltra ? "Ultra" : "Ultra and Max"} · ${ofFable ? "Fable spent this week" : "the week spent"}`,
    team: "Team · their 5 hours spent",
    work: () => "Working: ",
    none: "No account is working on this computer now.",
    total: (n: number) => ` ${formatNumber(n, "en")} % of Fable spent among them.`,
    mostFable: " Least Fable spent: ",
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
 * user and which free one has spent least.
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
      title: t.weekly(
        weekly.every((r) => r.account.plan === "ultra"),
        weekly.some((r) => r.account.fable != null),
      ),
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
  const withFable = weekly.filter((r) => r.account.fable != null && r.row.bar !== null);
  if (withFable.length > 0)
    sentence.push({
      text: t.total(
        Math.round(
          withFable.reduce((sum, r) => sum + r.row.bar!.used, 0) / withFable.length,
        ),
      ),
      bold: false,
    });
  // The free Ultra or Max that has spent least: the first free one of its group.
  const most = weekly.find((r) => r.row.state === "free")?.row;
  if (most?.bar)
    sentence.push(
      { text: withFable.length > 0 ? t.mostFable : t.most, bold: false },
      { text: most.name, bold: true },
      { text: ` (${formatNumber(most.bar.used, ctx.lang)} %).`, bold: false },
    );
  return { sentence, groups };
}

/** Why an account cannot be read or used, when that is what matters. */
function whyNot(row: PanelRow): string | null {
  return (row.state === "out" || row.state === "nodata") && row.line !== ""
    ? row.line
    : null;
}

/** The thread's account in one line: «Ultra · sin tope de 5 h · ha gastado el 40 % de la semana · se reinicia lun 09:00». */
export function threadLine(row: PanelRow): string {
  const spent =
    row.bar === null
      ? null
      : row.bar.label.charAt(0).toLowerCase() + row.bar.label.slice(1);
  return [row.planShort, whyNot(row) ?? spent, row.when]
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
