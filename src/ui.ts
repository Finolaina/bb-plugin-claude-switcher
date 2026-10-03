// Pure helpers of the settings page (app.tsx has no DOM tests; these do).
import type { PluginComposerScope } from "@get-bb/plugin-sdk/app";
import { CLAUDE_CODE_PROVIDER } from "./switch.js";

/** The notice "No Claude Code login found" applies when no listed account has a login. */
export function noLoginFound(
  accounts: ReadonlyArray<{ problem: { kind: string } | null }>,
): boolean {
  return accounts.every((a) => a.problem?.kind === "unauthenticated");
}

/**
 * The name of another listed account that is the same Claude account (two
 * directories logged in to one account share one usage), or null.
 */
export function sharedWith(
  account: { name: string; accountUuid: string | null },
  accounts: ReadonlyArray<{ name: string; accountUuid: string | null }>,
): string | null {
  if (account.accountUuid === null) return null;
  return (
    accounts.find(
      (a) => a.name !== account.name && a.accountUuid === account.accountUuid,
    )?.name ?? null
  );
}

/** The name of the project a move was about; a fixed phrase once it is gone. */
export function projectName(
  projects: ReadonlyArray<{ id: string; name: string }>,
  projectId: string,
): string {
  return (
    projects.find((p) => p.id === projectId)?.name ?? "a project that is gone"
  );
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
  tone: "ok" | "tight" | "out" | "unknown" | "nologin";
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
  // The numbers the plugin acts on, even when a later query failed.
  const entry = state.accounts.find((a) => a.name === account);
  const usage = entry?.usage ?? null;
  const model = Object.entries(usage?.models ?? {}).find(
    ([name]) =>
      state.preferredModel !== "" &&
      name.toLowerCase() === state.preferredModel.toLowerCase(),
  )?.[1];
  const used =
    usage === null
      ? []
      : [usage.session, usage.weekly, ...(model ? [model] : [])].map((w) =>
          windowPercent(w, now),
        );
  const tone =
    entry?.problem?.kind === "unauthenticated"
      ? "nologin"
      : account === null || usage === null || usage.unknown === true
        ? "unknown"
        : usage.blocked || used.some((u) => u >= 100)
          ? "out"
          : used.some((u) => u >= TIGHT_PERCENT)
            ? "tight"
            : "ok";
  // `?? null`: a server older than the header (during an update) sends none.
  const best = state.bestAccount ?? null;
  return {
    account,
    tone,
    best,
    canSwitch: !project.external && best !== null && best !== account,
    external: project.external,
  };
}

type ForecastLike =
  | { kind: "runs-out"; at: number; percentPerDay: number }
  | { kind: "lasts"; until: number; percentPerDay: number }
  | { kind: "steady" }
  | { kind: "unknown" };

/** "2 d 5 h", "3 h", "40 min", or "now". */
function inTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.floor(hours / 24);
  return `in ${days} d ${hours % 24} h`;
}

/** One line under a window's bar; null when there is nothing worth saying. */
export function forecastLine(
  forecast: ForecastLike,
  now: number,
): string | null {
  switch (forecast.kind) {
    case "runs-out":
      return `runs out ${inTime(forecast.at - now)} at this pace (${forecast.percentPerDay} %/day)`;
    case "lasts":
      return `lasts until the reset at this pace (${forecast.percentPerDay} %/day)`;
    default:
      return null;
  }
}

/**
 * The forecast that matters for an account: its preferred model's window
 * when it has one, else its weekly window. Null when the account has none.
 */
export function windowForecast(
  forecasts: Record<string, Record<string, ForecastLike>> | undefined,
  account: string,
  preferredModel: string,
): [string, ForecastLike] | null {
  const own = forecasts?.[account];
  if (own === undefined) return null;
  const model = Object.keys(own).find(
    (name) =>
      preferredModel !== "" &&
      name.toLowerCase() === preferredModel.toLowerCase(),
  );
  const key = model ?? "weekly";
  const forecast = own[key];
  return forecast === undefined ? null : [key, forecast];
}

/**
 * The wait before retry number `attempt` (from 0) of a read the screen
 * needs: soon at first, then once a minute while bb stays busy.
 */
export function retryDelayMs(attempt: number): number {
  return [2_000, 5_000, 15_000, 30_000][attempt] ?? 60_000;
}

/**
 * The project whose account the new-thread composer shows: the one picked
 * there, once resolved. Null in any other composer, and when the composer
 * reports a provider other than Claude Code (bb 0.45 hosts report their
 * pickers; 0.44 hosts do not, and the control shows for every provider).
 */
export function composerProject(
  scope: PluginComposerScope,
  selection: { providerId?: string } | null | undefined,
): string | null {
  if (scope.kind !== "new-thread") return null;
  const provider = selection?.providerId;
  if (provider !== undefined && provider !== CLAUDE_CODE_PROVIDER) return null;
  return scope.projectId ?? null;
}

type ComposerScope = PluginComposerScope;

/**
 * How the new-thread control reads its composer, chosen once per host: bb
 * 0.44 keeps the live scope and layout in `useComposerView()` (the
 * composer's own `scope` can stay at "project unresolved"); later hosts
 * dropped that hook and made `useComposer()` itself live. `viewHook` is
 * that hook, or undefined on a host without it; the returned reader calls
 * the same hooks on every render.
 */
export function composerReader(
  viewHook: (() => { scope: ComposerScope; layout: string }) | undefined,
): (composer: { scope: ComposerScope; layout?: string }) => {
  scope: ComposerScope;
  compact: boolean;
} {
  if (viewHook !== undefined)
    return () => {
      const view = viewHook();
      return { scope: view.scope, compact: view.layout === "compact" };
    };
  return (composer) => ({
    scope: composer.scope,
    compact: composer.layout === "compact",
  });
}

/**
 * Whether a click on an account in the account menu changes the project.
 * In a thread's header a click on the project's own account does nothing.
 * In the new-thread composer it picks it as well: a pick marks the project
 * as placed, so a new project stays there instead of moving to the best
 * account after its first turn.
 */
export function picksOnSelect(
  clicked: string,
  shown: string | null,
  newThread: boolean,
): boolean {
  return newThread || clicked !== shown;
}
