// The eleven accounts of the author's machine as the panel's State carries
// them, for the panel's tests and its screenshots (docs/screenshots/
// settings-ultra-*.png). Usage and seats: `bb claude-switcher list --json`
// of 2026-10-30 22:46 CET (plugin 0.2.31, read with the plan this version
// adds: aitor is the Ultra without the 5-hour window that 0.2.31 called
// locked). The day's pace: our own count at 21:55 in Optimizador
// informes/2026-10-30/ultra/propuestas/index.html, plus the points each
// account spent since. Emails and projects are made up: the repo is public.
import type { State } from "../server.js";

export const READING_AT = Date.parse("2026-10-30T22:46:00+01:00");

type Window = { usedPercent: number; resetsAt: number | null; absent?: true };
const at = (iso: string) => Date.parse(`${iso}:00+01:00`);
const w = (usedPercent: number, reset: string | null): Window => ({
  usedPercent,
  resetsAt: reset === null ? null : at(reset),
});
const NO_SESSION: Window = { usedPercent: 0, resetsAt: null, absent: true };
const NO_WEEKLY: Window = { usedPercent: 0, resetsAt: null, absent: true };

function pace(budget: number, spent: number) {
  const dayPercent =
    budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 100;
  return { budget, spent, dayPercent, background: dayPercent < 90 };
}

function account(
  name: string,
  usage: State["accounts"][number]["usage"],
  plan: Pick<
    State["accounts"][number],
    "plan" | "planLabel" | "planShort" | "fiveHour" | "pace"
  >,
  problem: State["accounts"][number]["problem"] = null,
): State["accounts"][number] {
  return {
    name,
    email: `${name}@example.com`,
    accountUuid: `uuid-${name}`,
    configDir: name === "mariscal" ? null : `/Users/me/.claude-cuentas/${name}`,
    observedAt: usage === null ? null : READING_AT,
    problem,
    usage,
    ...plan,
  };
}

const ULTRA_5H = {
  plan: "ultra" as const,
  planLabel: "Ultra · 5 h hasta que Anthropic la verifique",
  planShort: "Ultra · con 5 h",
  fiveHour: true,
};
const TEAM = {
  plan: "team" as const,
  planLabel: "Team",
  planShort: "Team",
  fiveHour: true,
  pace: null,
};
const fable = (usedPercent: number, reset: string) => ({
  Fable: w(usedPercent, reset),
});
const team = (
  name: string,
  ses: number,
  sesReset: string,
  fab: number,
  fabReset: string,
) =>
  account(
    name,
    {
      blocked: false,
      session: w(ses, sesReset),
      weekly: NO_WEEKLY,
      models: fable(fab, fabReset),
    },
    TEAM,
  );
const seats = (
  running: number,
  reserved: number,
  capacity: number,
  queued: number,
) => ({
  capacity,
  running,
  reserved,
  queued: Array.from({ length: queued }, (_, i) => ({
    threadId: `thr_wait${i + 1}`,
    title: null,
  })),
});

export function realReading(): State {
  return {
    accounts: [
      account(
        "mariscal",
        null,
        { ...ULTRA_5H, fiveHour: null, pace: null },
        { kind: "unauthenticated" },
      ),
      account(
        "aitor",
        {
          blocked: false,
          session: NO_SESSION,
          weekly: w(98, "2026-11-01T18:00"),
          models: fable(100, "2026-11-01T17:59"),
        },
        {
          plan: "ultra",
          planLabel: "Ultra · sin tope de 5 h",
          planShort: "Ultra · sin tope de 5 h",
          fiveHour: false,
          pace: pace(5.5, 11),
        },
      ),
      account(
        "ganaresenas",
        {
          blocked: false,
          session: w(8, "2026-10-31T03:10"),
          weekly: w(92, "2026-11-01T22:00"),
          models: fable(100, "2026-11-01T22:00"),
        },
        { ...ULTRA_5H, pace: pace(3.9, 2) },
      ),
      account(
        "studio",
        {
          blocked: false,
          session: w(12, "2026-10-31T03:10"),
          weekly: w(12, "2026-11-02T09:00"),
          models: fable(12, "2026-11-02T09:00"),
        },
        { ...ULTRA_5H, pace: pace(33.3, 12) },
      ),
      account(
        "agency",
        {
          blocked: false,
          session: w(0, null),
          weekly: w(0, "2026-11-06T12:00"),
          models: fable(0, "2026-11-06T12:00"),
        },
        { ...ULTRA_5H, pace: pace(14.3, 0) },
      ),
      team("team1", 4, "2026-10-31T03:20", 76, "2026-11-05T11:59"),
      team("team2", 74, "2026-10-31T00:00", 89, "2026-11-02T17:00"),
      team("team3", 17, "2026-10-31T03:00", 100, "2026-11-03T10:00"),
      team("team4", 22, "2026-10-31T02:00", 83, "2026-11-02T17:00"),
      team("team5", 75, "2026-10-31T00:00", 60, "2026-11-05T06:59"),
      account(
        "viaulab",
        {
          blocked: false,
          session: w(0, null),
          weekly: w(68, "2026-11-04T01:00"),
          models: fable(100, "2026-11-04T01:00"),
        },
        { ...ULTRA_5H, pace: pace(11.1, 20) },
      ),
    ],
    projects: [
      {
        id: "p1",
        name: "web-shop",
        account: "studio",
        owned: true,
        external: false,
      },
      {
        id: "p2",
        name: "blog",
        account: "ganaresenas",
        owned: true,
        external: false,
      },
      {
        id: "p3",
        name: "infra",
        account: "team2",
        owned: true,
        external: false,
      },
      { id: "p4", name: "notes", account: null, owned: false, external: false },
    ],
    defaultAccountName: "mariscal",
    preferredModel: "Fable",
    autoSwitch: true,
    // Read with the brake of 0.2.32 on.
    paceHoldsBackground: true,
    lastSwitch: null,
    bestAccount: "agency",
    history: [],
    forecasts: {
      studio: {
        weekly: {
          kind: "lasts",
          until: at("2026-11-02T09:00"),
          percentPerDay: 24.3,
        },
      },
      ganaresenas: {
        weekly: {
          kind: "runs-out",
          at: at("2026-10-31T09:16"),
          percentPerDay: 18.3,
        },
      },
    },
    login: null,
    seats: {
      mariscal: seats(0, 0, 4, 0),
      aitor: seats(0, 0, 4, 0),
      ganaresenas: seats(1, 0, 4, 0),
      studio: seats(1, 1, 4, 0),
      agency: seats(0, 0, 4, 0),
      team1: seats(0, 0, 2, 0),
      team2: seats(2, 0, 2, 4),
      team3: seats(0, 0, 2, 0),
      team4: seats(1, 1, 2, 2),
      team5: seats(0, 0, 2, 0),
      viaulab: seats(0, 0, 4, 0),
    },
  };
}
