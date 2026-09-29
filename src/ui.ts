// Pure helpers of the settings page (app.tsx has no DOM tests; these do).

/** The notice "No Claude Code login found" applies when no listed account has a login. */
export function noLoginFound(
  accounts: ReadonlyArray<{ problem: { kind: string } | null }>,
): boolean {
  return accounts.every((a) => a.problem?.kind === "unauthenticated");
}

/** " (Website)" for the project the last automatic switch moved, "" if it is gone. */
export function projectLabel(
  projects: ReadonlyArray<{ id: string; name: string }>,
  projectId: string,
): string {
  const project = projects.find((p) => p.id === projectId);
  return project === undefined ? "" : ` (${project.name})`;
}

type Window = { usedPercent: number; resetsAt: number | null };

/** A window's share, 0 once its reset has passed (as the switch policy settles it). */
export function windowPercent(window: Window, now: number): number {
  return window.resetsAt !== null && window.resetsAt <= now
    ? 0
    : window.usedPercent;
}

interface HeaderInput {
  defaultAccountName: string;
  preferredModel: string;
  bestAccount: string | null;
  accounts: ReadonlyArray<{
    name: string;
    /** "error" = the last measurement failed: `usage` is an older one. */
    problem?: { kind: string } | null;
    usage: {
      blocked: boolean;
      /** A window was missing from the answer: `blocked` means "unknown", not "out". */
      unknown?: boolean;
      session: Window;
      weekly: Window;
      models: Record<string, Window>;
    } | null;
  }>;
  projects: ReadonlyArray<{
    id: string;
    account: string | null;
    owned: boolean;
    external: boolean;
  }>;
}

/** Above this share of any window an account is shown as running low. */
const TIGHT_PERCENT = 80;

/**
 * What a thread's header shows for its project: the account it runs on
 * (null when unknown: set by hand, or an account that is gone), how that
 * account stands for the preferred model, and whether "switch to the best
 * account" is on offer. `external` = set by something else, which this
 * plugin must not change. Null when the project is not listed.
 */
export function headerStatus(
  state: HeaderInput,
  projectId: string,
  now: number,
): {
  account: string | null;
  tone: "ok" | "tight" | "out" | "unknown";
  best: string | null;
  canSwitch: boolean;
  external: boolean;
} | null {
  const project = state.projects.find((p) => p.id === projectId);
  if (project === undefined) return null;
  const account =
    project.external || project.owned
      ? project.account
      : state.defaultAccountName;
  const entry = state.accounts.find((a) => a.name === account);
  // A failed measurement leaves an older one behind: not shown as current.
  const usage =
    entry?.problem?.kind === "error" ? null : (entry?.usage ?? null);
  const model = Object.entries(usage?.models ?? {}).find(
    ([name]) => name.toLowerCase() === state.preferredModel.toLowerCase(),
  )?.[1];
  const used =
    usage === null
      ? []
      : [usage.session, usage.weekly, ...(model ? [model] : [])].map(
          (w) => windowPercent(w, now),
        );
  const tone =
    account === null || usage === null || usage.unknown === true
      ? "unknown"
      : usage.blocked || used.some((u) => u >= 100)
        ? "out"
        : used.some((u) => u >= TIGHT_PERCENT)
          ? "tight"
          : "ok";
  return {
    account,
    tone,
    best: state.bestAccount,
    canSwitch:
      !project.external &&
      state.bestAccount !== null &&
      state.bestAccount !== account,
    external: project.external,
  };
}
