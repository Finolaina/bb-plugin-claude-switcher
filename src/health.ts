// `bb claude-switcher health`: a stable read of every account for other
// threads and scripts (Optimizador informes/2026-10-30/ultra/SPEC.md §4,
// version 1). The same schema as the Mac's `claude-cuentas.py salud
// --json`: Spanish keys as they are, times ISO 8601 with Madrid's offset.
// New fields may be added; the meaning of one never changes without a new
// version.
import type { PlanInfo } from "./accounts.js";
import { DAY_ZONE, zoneOffsetMs, type Pace } from "./pace.js";
import type { AccountUsage, UsageWindow } from "./policy.js";

export const HEALTH_VERSION = 1;

export interface HealthAccount {
  name: string;
  plan: PlanInfo;
  /** The latest usage, its passed resets already settled; null when none. */
  usage: AccountUsage | null;
  problem:
    { kind: "unauthenticated" } | { kind: "error"; message: string } | null;
  pace: Pace | null;
  /** Undefined when the plugin keeps none for the account. capacity 0 = no limit. */
  seats:
    | {
        capacity: number;
        running: number;
        reserved: number;
        /** Seats held from outside bb (`reserve`), counted as taken. */
        external?: ReadonlyArray<{ id: string; until: number }>;
      }
    | undefined;
  /** It can run a turn now: logged in, measured whole, unlocked, session and weekly under 100 %. */
  usable: boolean;
}

interface Point {
  pct: number;
  vuelve: string | null;
}

export interface HealthReport {
  version: typeof HEALTH_VERSION;
  medido: string;
  inicioDia: number;
  cuentas: Array<{
    nombre: string;
    plan: "ultra" | "max" | "team" | "desconocido";
    planTexto: string;
    cincoHoras: boolean | null;
    sesion: Point | null;
    semana: Point | null;
    modelos: Record<string, Point>;
    ritmo: {
      presupuesto: number;
      gastado: number;
      pctDia: number;
      fondo: boolean;
    } | null;
    plazas: {
      usadas: number;
      total: number | null;
      /** Held from outside bb (`reserve`); counted in usadas. */
      externas: { id: string; hasta: string }[];
    } | null;
    usable: boolean;
    problema: string | null;
  }>;
}

/** "2026-11-01T18:00:00+01:00": ISO 8601 with the zone's offset at that time. */
export function isoInZone(ms: number, timeZone: string = DAY_ZONE): string {
  const offset = zoneOffsetMs(ms, timeZone);
  const local = new Date(Math.floor(ms / 1000) * 1000 + offset)
    .toISOString()
    .slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset) / 60_000;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

function point(w: UsageWindow): Point {
  return {
    pct: Math.round(w.usedPercent),
    vuelve: w.resetsAt === null ? null : isoInZone(w.resetsAt),
  };
}

function problemText(a: HealthAccount): string | null {
  if (a.problem?.kind === "unauthenticated") return "sin login";
  if (a.problem?.kind === "error")
    return `consulta fallida: ${a.problem.message}`;
  const u = a.usage;
  if (u === null) return "sin medir";
  if (u.unknown === true) return "datos incompletos de la API de uso";
  if (u.blocked) return "bloqueada por Anthropic";
  const full = [u.session, u.weekly].filter((w) => w.usedPercent >= 100);
  if (full.length > 0) {
    const until = full.some((w) => w.resetsAt === null)
      ? null
      : Math.max(...full.map((w) => w.resetsAt!));
    return `agotada hasta ${until === null ? "sin fecha" : isoInZone(until)}`;
  }
  return null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function healthReport(input: {
  /** When the latest measurement was taken (or the report, without one). */
  measured: number;
  dayStartHour: number;
  accounts: HealthAccount[];
}): HealthReport {
  return {
    version: HEALTH_VERSION,
    medido: isoInZone(input.measured),
    inicioDia: input.dayStartHour,
    cuentas: input.accounts.map((a) => {
      const u = a.usage;
      const whole = u !== null && u.unknown !== true;
      return {
        nombre: a.name,
        plan: a.plan.plan === "unknown" ? "desconocido" : a.plan.plan,
        planTexto: a.plan.label,
        cincoHoras: a.plan.fiveHour,
        sesion: whole && u.session.absent !== true ? point(u.session) : null,
        semana: whole && u.weekly.absent !== true ? point(u.weekly) : null,
        // Only the windows the usage API reports: no model is made up.
        modelos: Object.fromEntries(
          Object.entries(u?.models ?? {}).map(([m, w]) => [m, point(w)]),
        ),
        ritmo:
          a.pace === null
            ? null
            : {
                presupuesto: round1(a.pace.budget),
                gastado: round1(a.pace.spent),
                pctDia: Math.round(a.pace.dayPercent),
                fondo: a.pace.background,
              },
        plazas:
          a.seats === undefined
            ? null
            : {
                usadas:
                  a.seats.running +
                  a.seats.reserved +
                  (a.seats.external?.length ?? 0),
                total: a.seats.capacity === 0 ? null : a.seats.capacity,
                externas: (a.seats.external ?? []).map((e) => ({
                  id: e.id,
                  hasta: isoInZone(e.until),
                })),
              },
        usable: a.usable,
        problema: problemText(a),
      };
    }),
  };
}

/** The same report as text: one line per account. */
export function healthText(report: HealthReport): string {
  const width = Math.max(0, ...report.cuentas.map((c) => c.nombre.length));
  const lines = report.cuentas.map((c) => {
    const parts = [
      c.planTexto,
      ...(c.sesion === null ? [] : [`ses ${c.sesion.pct}%`]),
      ...(c.semana === null ? [] : [`sem ${c.semana.pct}%`]),
      ...Object.entries(c.modelos).map(([m, p]) => `${m} ${p.pct}%`),
      ...(c.ritmo === null
        ? []
        : [`ritmo ${c.ritmo.pctDia}% (fondo ${c.ritmo.fondo ? "sí" : "no"})`]),
      ...(c.plazas === null
        ? []
        : [`plazas ${c.plazas.usadas}/${c.plazas.total ?? "sin límite"}`]),
      c.usable ? "usable" : `no usable: ${c.problema ?? "sin motivo"}`,
    ];
    return `${c.nombre.padEnd(width)}  ${parts.join(" · ")}`;
  });
  return [
    `medido ${report.medido} · el día empieza a las ${report.inicioDia}:00`,
    ...lines,
    "",
  ].join("\n");
}
