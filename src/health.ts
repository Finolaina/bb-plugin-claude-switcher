// `bb claude-switcher health`: a stable read of every account for other
// threads and scripts (Optimizador informes/2026-10-30/ultra/SPEC.md §4,
// version 1). The same schema as the Mac's `claude-cuentas.py salud
// --json`: Spanish keys as they are, times ISO 8601 with Madrid's offset.
// New fields may be added; the meaning of one never changes without a new
// version.
import type { PlanInfo } from "./accounts.js";
import { DAY_ZONE, zoneOffsetMs, type Pace } from "./pace.js";
import type { Atasco, EsperaTeam } from "./atascos.js";
import { opusRoom, type AccountUsage, type UsageWindow } from "./policy.js";

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
  /**
   * Set when the policy no longer trusts the latest good read (see
   * UsageCollector.usable): it was out, only the clock frees it, and the
   * queries have failed for too long since. When that read was taken.
   */
  unconfirmedSince?: number;
  /** The same for a model's window alone: the policy does not trust the account for these. */
  unconfirmedModels?: readonly string[];
  /** It can run a turn now: logged in, measured whole, unlocked, session and weekly under 100 %, and a read the policy trusts. */
  usable: boolean;
}

interface Point {
  pct: number;
  /** Unrounded: 99.6 % is `pct` 100 and still runs a turn. */
  pctExacto: number;
  vuelve: string | null;
  /** Its reset passed with the queries failing: only the clock says it is free, and the policy does not trust it. Only when so. */
  sinConfirmar?: true;
}

export interface HealthReport {
  version: typeof HEALTH_VERSION;
  medido: string;
  inicioDia: number;
  /** The day's pace holds background work back (the plugin's paceHoldsBackground; off by default). */
  freno: boolean;
  /** Threads this plugin holds 10 min or more with another account free; null when the queue could not be read. */
  atascos: Atasco[] | null;
  /** Opus and Sonnet turns this plugin holds for a Team seat, with the minutes (Aitor 2026-11-06); null when the queue could not be read. */
  esperandoTeam: EsperaTeam[] | null;
  /**
   * The accounts a turn failed on for want of a session, per machine, while
   * their mark stands (0.2.51, Aitor 2026-11-10): no project with threads on
   * that machine is placed there. `maquina` is bb's host id ("" when the
   * thread's machine could not be told).
   */
  sinSesion: SinSesion[];
  /**
   * The usage limits turns failed on, while their mark stands (0.2.52,
   * Aitor 2026-11-11): the account takes no turn in `modelo` ("todos": in
   * any model) where the placement, the rescue and a retry look, whatever
   * its read says, until `hasta`.
   */
  limites: Limite[];
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
      /** It may take background work: always with the brake off. */
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
    /**
     * Only with a reserve given (0.2.48). A Max or Ultra account's room for
     * another model in points of its weekly: (100 − weekly) − share ·
     * (100 − preferred) (see opusRoom in src/policy.ts), one decimal; null
     * for a Team seat or an account not read whole.
     */
    huecoOpus?: number | null;
    /**
     * Only with a reserve given (0.2.48). The points of the preferred
     * model's own window left unspent when the weekly reaches 100 % if the
     * account goes on as now: −huecoOpus / share when huecoOpus is below 0,
     * else 0; one decimal; null where huecoOpus is.
     */
    fablePerdida?: number | null;
  }>;
}

/** One account without a session on one machine (see HealthReport.sinSesion). */
export interface SinSesion {
  cuenta: string;
  maquina: string;
  nombreMaquina: string;
  hasta: string;
}

/** One account kept from a model by a usage limit (see HealthReport.limites). */
export interface Limite {
  cuenta: string;
  modelo: string;
  hasta: string;
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
    pctExacto: w.usedPercent,
    vuelve: w.resetsAt === null ? null : isoInZone(w.resetsAt),
  };
}

function problemText(a: HealthAccount): string | null {
  if (a.problem?.kind === "unauthenticated") return "sin login";
  if (a.unconfirmedSince !== undefined)
    return `reset sin confirmar: la última lectura buena (${isoInZone(a.unconfirmedSince)}) la daba agotada y las consultas fallan desde entonces${a.problem?.kind === "error" ? ` (${a.problem.message})` : ""}`;
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
  /** The brake is on: an account past 90 % of its day takes no background work. */
  holdsBackground: boolean;
  /** See HealthReport.atascos. */
  atascos: Atasco[] | null;
  /** See HealthReport.esperandoTeam. */
  esperandoTeam: EsperaTeam[] | null;
  /** See HealthReport.sinSesion; `until` in ms. */
  sinSesion?: ReadonlyArray<{ account: string; host: string; hostName: string; until: number }>;
  /** See HealthReport.limites; `scope` "" for every model, else the model's name in lower case; `until` in ms. */
  limites?: ReadonlyArray<{ account: string; scope: string; until: number }>;
  accounts: HealthAccount[];
  /** The preferred model and the weekly it spends per point of its own window (reserveShare): adds huecoOpus and fablePerdida. */
  reserve?: { model: string; share: number };
}): HealthReport {
  return {
    version: HEALTH_VERSION,
    medido: isoInZone(input.measured),
    inicioDia: input.dayStartHour,
    freno: input.holdsBackground,
    atascos: input.atascos,
    esperandoTeam: input.esperandoTeam,
    sinSesion: (input.sinSesion ?? []).map((m) => ({
      cuenta: m.account,
      maquina: m.host,
      nombreMaquina: m.hostName,
      hasta: isoInZone(m.until),
    })),
    limites: (input.limites ?? []).map((m) => ({
      cuenta: m.account,
      modelo: m.scope === "" ? "todos" : m.scope[0]!.toUpperCase() + m.scope.slice(1),
      hasta: isoInZone(m.until),
    })),
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
          Object.entries(u?.models ?? {}).map(([m, w]) => [
            m,
            a.unconfirmedModels?.includes(m) === true
              ? { ...point(w), sinConfirmar: true as const }
              : point(w),
          ]),
        ),
        ritmo:
          a.pace === null
            ? null
            : {
                presupuesto: round1(a.pace.budget),
                gastado: round1(a.pace.spent),
                pctDia: Math.round(a.pace.dayPercent),
                fondo: !input.holdsBackground || a.pace.background,
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
        ...(input.reserve === undefined ? {} : roomOf(a, input.reserve)),
      };
    }),
  };
}

/** huecoOpus and fablePerdida of an account (see HealthReport). */
function roomOf(
  a: HealthAccount,
  reserve: { model: string; share: number },
): { huecoOpus: number | null; fablePerdida: number | null } {
  const room =
    a.usage === null || (a.plan.plan !== "max" && a.plan.plan !== "ultra")
      ? null
      : opusRoom(a.usage, reserve.model, reserve.share);
  if (room === null) return { huecoOpus: null, fablePerdida: null };
  return {
    huecoOpus: round1(room),
    fablePerdida: room < 0 && reserve.share > 0 ? round1(-room / reserve.share) : 0,
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
      ...(c.huecoOpus === undefined || c.huecoOpus === null
        ? []
        : [`hueco Opus ${c.huecoOpus} (Fable perdida ${c.fablePerdida})`]),
      ...report.limites
        .filter((l) => l.cuenta === c.nombre)
        .map((l) => `límite ${l.modelo === "todos" ? "" : `${l.modelo} `}hasta ${l.hasta}`),
      c.usable ? "usable" : `no usable: ${c.problema ?? "sin motivo"}`,
    ];
    return `${c.nombre.padEnd(width)}  ${parts.join(" · ")}`;
  });
  return [
    `medido ${report.medido} · el día empieza a las ${report.inicioDia}:00 · freno de fondo ${report.freno ? "encendido" : "apagado"}`,
    ...lines,
    ...(report.atascos === null
      ? ["atascos: la cola no se pudo leer"]
      : report.atascos.map(
          (a) =>
            `atasco: ${a.cuenta} retiene ${a.hilo} (${a.modelo}) ${a.minutos} min; ${a.libres.length === 0 ? `sin cuenta libre para ${a.modelo}${a.vuelve === undefined ? "" : ` hasta ${a.vuelve}`}` : `libres: ${a.libres.join(", ")}`}${a.proyectoOcupado ? "; proyecto con otro hilo en marcha" : ""}`,
        )),
    ...(report.esperandoTeam === null
      ? ["esperando Team: la cola no se pudo leer"]
      : report.esperandoTeam.map((e) => `esperando Team: ${e.hilo} (${e.modelo}) ${e.minutos} min`)),
    ...report.sinSesion.map((m) => `sin sesión: ${m.cuenta} en ${m.nombreMaquina} hasta ${m.hasta}`),
    "",
  ].join("\n");
}
