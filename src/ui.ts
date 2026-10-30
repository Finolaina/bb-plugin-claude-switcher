// Pure helpers of the settings page (app.tsx has no DOM tests; these do).
import type {
  PluginComposerScope,
  PluginRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
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
 * Whether bb's realtime connection, `previous` at the view's last look and
 * `next` now, is back after it was down: its signals are ephemeral (SDK
 * 0.6.15, useRealtimeConnectionState), so one sent meanwhile is lost and a
 * view that reads on them reads again (Sol B2-R2-004). So too after a first
 * connection the view mounted before: a signal between its first read and
 * that connection is lost as well. Not on the view's first look
 * (`previous` undefined): it reads as it mounts.
 */
export function signalsBack(
  previous: PluginRealtimeConnectionState | undefined,
  next: PluginRealtimeConnectionState,
): boolean {
  return (
    previous !== undefined && previous !== "connected" && next === "connected"
  );
}

/**
 * Answers to requests that can come back out of order (a slow read started
 * before a change can land after it): an answer to a request older than the
 * one shown gives back the one shown.
 */
export function newestFirst<T>() {
  let started = 0;
  let shown: { ticket: number; value: T } | null = null;
  return {
    start: () => ++started,
    accept(ticket: number, value: T): T {
      if (shown !== null && ticket < shown.ticket) return shown.value;
      shown = { ticket, value };
      return value;
    },
  };
}

/**
 * Whether a read asked for a project is done: its own answer is shown, or the
 * newer list shown in its place has the project. Otherwise it is asked again
 * (askForProject); a project bb does not list is not asked for again.
 */
export function projectRead(
  sent: { projects: readonly { id: string }[] },
  shown: { projects: readonly { id: string }[] },
  project: string,
): boolean {
  return shown === sent || shown.projects.some((p) => p.id === project);
}

/**
 * Asks for a project missing from the views' list (`read` says whether the
 * read worked; a throw is a failure), and after a failed read calls `onFailed` once the back-off
 * for `failedReads` failures has passed, so its view asks again. Returns the
 * cleanup: nothing is called once the view is gone.
 */
export function askForProject(
  read: () => Promise<boolean>,
  failedReads: number,
  onFailed: () => void,
): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void read()
    .catch(() => false)
    .then((worked) => {
      if (!worked && alive)
        timer = setTimeout(onFailed, retryDelayMs(failedReads));
    });
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

/**
 * The project whose account the new-thread composer shows: the one picked
 * there, once resolved. Null in any other composer, and when the composer
 * has picked a provider other than Claude Code.
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

type ListWindow = Window & { absent?: true };
interface UsageLike {
  blocked: boolean;
  session: ListWindow;
  weekly: ListWindow;
  models: Record<string, ListWindow>;
}

/** What an account's compact line shows (the CLI's list, the panel's cards). */
export interface AccountSummary {
  /** null on an Ultra account freed of the 5-hour window: it has no session (absent). */
  session: number | null;
  /** null on a Team seat: it has no general weekly (absent). */
  weekly: number | null;
  /** The preferred model's window, when the account has one. */
  model: { name: string; percent: number } | null;
  /**
   * The account has a window at 100 %: until when (the latest reset of
   * those, when it can run again), or null when the provider gave none.
   * Undefined: no window is full.
   */
  outUntil?: number | null;
}

/** A share as a whole number; never "100" for a window that still has a little room. */
function shownPercent(window: Window, now: number): number {
  const used = windowPercent(window, now);
  return used < 100 ? Math.min(99, Math.round(used)) : Math.round(used);
}

export function accountSummary(
  usage: UsageLike,
  preferredModel: string,
  now: number,
): AccountSummary {
  const model = Object.entries(usage.models).find(
    ([name]) =>
      preferredModel !== "" &&
      name.toLowerCase() === preferredModel.toLowerCase(),
  );
  const team = usage.weekly.absent === true;
  const noSession = usage.session.absent === true;
  const windows = [
    ...(noSession ? [] : [usage.session]),
    ...(team ? [] : [usage.weekly]),
    ...(model === undefined ? [] : [model[1]]),
  ];
  const full = windows.filter((w) => windowPercent(w, now) >= 100);
  const summary: AccountSummary = {
    session: noSession ? null : shownPercent(usage.session, now),
    weekly: team ? null : shownPercent(usage.weekly, now),
    model:
      model === undefined
        ? null
        : { name: model[0], percent: shownPercent(model[1], now) },
  };
  if (full.length > 0)
    summary.outUntil = full.some((w) => w.resetsAt === null)
      ? null
      : Math.max(...full.map((w) => w.resetsAt!));
  return summary;
}

/** "agotada hasta 14:00" within a day, "agotada hasta 03/11" beyond (local time, or `timeZone`). */
export function outText(
  until: number | null,
  now: number,
  timeZone?: string,
): string {
  if (until === null) return "agotada";
  const options: Intl.DateTimeFormatOptions =
    until - now < 24 * 3_600_000
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : { day: "2-digit", month: "2-digit" };
  return `agotada hasta ${new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(until)}`;
}

export interface SeatsLike {
  /** 0 = no limit. */
  capacity: number;
  running: number;
  reserved: number;
  queued: ReadonlyArray<{ threadId: string; title: string | null }>;
  /** Seats held from outside bb (`reserve`). */
  external?: ReadonlyArray<{ id: string; until: number }>;
}

/** "seats 3/4", "seats 2/2 · 1 external · 2 waiting"; null when the account has no limit. */
export function seatsText(seats: SeatsLike | undefined): string | null {
  if (seats === undefined || seats.capacity === 0) return null;
  const waiting = seats.queued.length;
  const external = seats.external?.length ?? 0;
  return `seats ${seats.running + seats.reserved + external}/${seats.capacity}${external > 0 ? ` · ${external} external` : ""}${waiting > 0 ? ` · ${waiting} waiting` : ""}`;
}

interface ListInput {
  /** Per account: its seats and who waits for one (see src/seats.ts). */
  seats?: Readonly<Record<string, SeatsLike>>;
  defaultAccountName: string;
  preferredModel: string;
  accounts: ReadonlyArray<{
    name: string;
    problem: { kind: "unauthenticated" } | { kind: "error"; message: string } | null;
    usage: UsageLike | null;
    /** The plan's short label («Ultra · sin tope de 5 h», «Team»), shown under the line. */
    planShort?: string;
  }>;
  projects: ReadonlyArray<{
    name: string;
    account: string | null;
    owned: boolean;
    external: boolean;
  }>;
}

/** The heading of the projects set outside this plugin, in the list and the panel. */
export const EXTERNAL_GROUP = "(external CLAUDE_CONFIG_DIR)";
/** The heading of the projects whose variable names an account that is gone. */
export const GONE_GROUP = "(account no longer exists)";

/**
 * The projects by the account they run on, in the accounts' order, each
 * group sorted by name; then the external ones and those of a vanished
 * account. Accounts without a project are left out.
 */
export function projectsByAccount<
  P extends { name: string; account: string | null; owned: boolean; external: boolean },
>(
  state: {
    defaultAccountName: string;
    accounts: ReadonlyArray<{ name: string }>;
    projects: ReadonlyArray<P>;
  },
): { heading: string; account: string | null; projects: P[] }[] {
  const groupOf = (p: P) =>
    p.external
      ? EXTERNAL_GROUP
      : p.owned && p.account === null
        ? GONE_GROUP
        : (p.account ?? state.defaultAccountName);
  const headings = [
    ...state.accounts.map((a) => a.name),
    ...new Set(state.projects.map(groupOf)),
  ];
  const order = [
    ...new Set([
      ...headings.filter((h) => h !== EXTERNAL_GROUP && h !== GONE_GROUP),
      EXTERNAL_GROUP,
      GONE_GROUP,
    ]),
  ];
  return order.flatMap((heading) => {
    const projects = state.projects
      .filter((p) => groupOf(p) === heading)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (projects.length === 0) return [];
    const account =
      heading === EXTERNAL_GROUP || heading === GONE_GROUP ? null : heading;
    return [{ heading, account, projects }];
  });
}

/** Longest an account's name is shown in the list. */
const LIST_NAME = 10;
/** Longest an account's line in the list is. */
const LIST_LINE = 60;

/**
 * `bb claude-switcher list` as text: one aligned line per account of at
 * most 60 characters (`ses`, `sem` but on a Team seat, the preferred
 * model, `agotada hasta …` when a window is full, LOCKED), then the
 * projects by account. The pace of each window is in `--json` only.
 */
export function listText(state: ListInput, now: number, timeZone?: string): string {
  const width = Math.min(
    LIST_NAME,
    Math.max(0, ...state.accounts.map((a) => a.name.length)),
  );
  const pct = (n: number) => `${n}%`.padStart(4);
  const model = state.preferredModel.slice(0, 5);
  const lines = state.accounts.map((a) => {
    const name = a.name.slice(0, LIST_NAME).padEnd(width);
    let rest: string;
    if (a.usage === null) {
      rest =
        a.problem?.kind === "unauthenticated"
          ? "not logged in"
          : a.problem?.kind === "error"
            ? `query failed: ${a.problem.message}`
            : "not observed";
    } else {
      const s = accountSummary(a.usage, state.preferredModel, now);
      const blank = (text: string) => " ".repeat(text.length);
      const ses = `ses ${pct(s.session ?? 0)}`;
      const sem = `sem ${pct(s.weekly ?? 0)}`;
      const fable = `${model} ${pct(s.model?.percent ?? 0)}`;
      // Each column on its own: a locked account can have full windows too
      // (Codex E46-R5-002). Dropped while the line is too long, least
      // needed first: sem, LOCKED, agotada hasta, the model.
      const columns = [
        // No session on an Ultra account freed of the 5-hour window: its
        // plan says so under the line.
        { keep: 5, text: s.session === null ? blank(ses) : ses },
        { keep: 0, text: s.weekly === null ? blank(sem) : sem },
        ...(model === ""
          ? []
          : [{ keep: 4, text: s.model === null ? blank(fable) : fable }]),
        {
          keep: 3,
          text:
            s.outUntil === undefined ? "" : outText(s.outUntil, now, timeZone),
        },
        { keep: 2, text: a.usage.blocked ? "LOCKED" : "" },
      ].filter((c) => c.text !== "");
      const join = () => columns.map((c) => c.text).join(" ").trimEnd();
      while (`${name}  ${join()}`.trimEnd().length > LIST_LINE) {
        const least = columns.reduce((a, b) => (b.keep < a.keep ? b : a));
        if (least.keep === 5) break;
        columns.splice(columns.indexOf(least), 1);
      }
      rest = join();
    }
    const line = `${name}  ${rest}`.trimEnd();
    const details = [
      a.planShort ?? null,
      seatsText(state.seats?.[a.name]),
    ].filter((d): d is string => d !== null && d !== "");
    return [
      line.length <= LIST_LINE ? line : `${line.slice(0, LIST_LINE - 1)}…`,
      ...(details.length === 0
        ? []
        : [`${" ".repeat(width)}  ${details.join(" · ")}`]),
    ];
  });
  const projects = projectsByAccount(state).map(
    (g) => `${g.heading}: ${g.projects.map((p) => p.name).join(" · ")}`,
  );
  const waiting = Object.entries(state.seats ?? {}).flatMap(([account, s]) =>
    s.queued.map((q, i) =>
      `${account}  #${i + 1}  ${q.threadId}${q.title === null ? "" : `  ${q.title}`}`,
    ),
  );
  return (
    [
      ...lines.flat(),
      "",
      "projects:",
      ...projects,
      ...(waiting.length === 0 ? [] : ["", "Waiting for a seat:", ...waiting]),
    ].join("\n") + "\n"
  );
}
