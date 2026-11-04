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
  /** The accounts that could run it now, with a seat free. Never empty. */
  libres: string[];
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
    a.libres.length === 1
      ? `${a.libres[0]} is free`
      : `${a.libres.join(", ")} are free`;
  return `STUCK: ${a.cuenta} holds thread ${a.hilo} (${a.modelo}) ${a.minutos} min, ${free}${a.proyectoOcupado ? "; another thread of its project is at work" : ""}`;
}
