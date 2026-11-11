// A thread this plugin keeps waiting while another account could run it: what
// was missed on 2026-11-03, when one account held up to 8 threads for hours
// (revisión 2026-11-04). Measured from when this plugin began to hold the
// message, not from when it was queued: a row may have waited for other
// reasons first.

/** How long a held message may wait with another account free before it counts. */
export const STUCK_WAIT_MS = 10 * 60_000;

export interface HeldRow {
  threadId: string;
  model?: string | null;
  failureReason?: string | null;
  waitingOn?: { kind: string; pluginId?: string } | null;
}

/** One message of a thread this plugin has held for at least STUCK_WAIT_MS. */
export interface HeldLong {
  threadId: string;
  /** As bb names it; null when the row names none. */
  model: string | null;
  since: number;
}

export interface Atasco {
  hilo: string;
  cuenta: string;
  modelo: string;
  minutos: number;
  /**
   * The accounts that could run it now, with a seat free. Empty only when
   * every such account is kept from its model by a usage limit's mark (the
   * plugin would not use it: culpa tras recarga, 2026-11-11).
   */
  libres: string[];
  /**
   * With `libres` empty: when the first of those marks ends (ISO 8601, see
   * isoInZone). A mark of a usage limit, or of a session lost on one of the
   * project's machines (both are limitedUntil's).
   */
  vuelve?: string;
  /** Another thread of its project is at work, so no automatic move for seats. */
  proyectoOcupado: boolean;
}

/** Whether bb's row is held by `pluginId` and still alive: the row of an archived thread waits for nothing; one whose attempt failed still does (code-reviewer r2). */
export function heldBy(row: HeldRow, pluginId: string): boolean {
  return (
    row.waitingOn?.kind === "plugin" &&
    row.waitingOn.pluginId === pluginId &&
    row.failureReason !== "Thread is archived"
  );
}

/** The threads held long enough to judge, each once: `since` is when this plugin began to hold each. */
export function heldLong(
  rows: readonly HeldRow[],
  pluginId: string,
  since: ReadonlyMap<string, number>,
  now: number,
): HeldLong[] {
  const out = new Map<string, HeldLong>();
  for (const row of rows) {
    if (!heldBy(row, pluginId) || out.has(row.threadId)) continue;
    const at = since.get(row.threadId);
    if (at === undefined || now - at < STUCK_WAIT_MS) continue;
    out.set(row.threadId, {
      threadId: row.threadId,
      model: row.model ?? null,
      since: at,
    });
  }
  return [...out.values()];
}

/** The line the log gets, at most once per STUCK_WAIT_MS and thread. */
export function atascoLine(a: Atasco): string {
  const free =
    a.libres.length === 0
      ? `no account free for ${a.modelo}${a.vuelve === undefined ? "" : ` until ${a.vuelve}`}`
      : a.libres.length === 1
        ? `${a.libres[0]} is free`
        : `${a.libres.join(", ")} are free`;
  return `STUCK: ${a.cuenta} holds thread ${a.hilo} (${a.modelo}) ${a.minutos} min, ${free}${a.proyectoOcupado ? "; another thread of its project is at work" : ""}`;
}

/** A thread this plugin holds in a model held off the reserve (Opus, Sonnet): it waits for a Team seat. */
export interface EsperaTeam {
  hilo: string;
  modelo: string;
  minutos: number;
}

/**
 * The threads waiting for a Team seat (Aitor 2026-11-06, «los Opus tienen
 * que salir por Team sí o sí»: such a turn waits rather than run on a Max or
 * Ultra), longest first, each once, from their first minute. `heldFamily`
 * names the model of a row when it is held off the reserve, null otherwise.
 */
export function waitingForTeam(
  rows: readonly HeldRow[],
  pluginId: string,
  since: ReadonlyMap<string, number>,
  now: number,
  heldFamily: (model: string | null) => string | null,
): EsperaTeam[] {
  const out = new Map<string, EsperaTeam & { since: number }>();
  for (const row of rows) {
    if (!heldBy(row, pluginId) || out.has(row.threadId)) continue;
    const at = since.get(row.threadId);
    const modelo = heldFamily(row.model ?? null);
    if (at === undefined || modelo === null) continue;
    out.set(row.threadId, {
      hilo: row.threadId,
      modelo,
      minutos: Math.floor((now - at) / 60_000),
      since: at,
    });
  }
  return [...out.values()]
    .sort((a, b) => a.since - b.since)
    .map(({ hilo, modelo, minutos }) => ({ hilo, modelo, minutos }));
}
