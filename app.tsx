// Claude Switcher — bb plugin frontend.
//
// A Settings section: every Claude Code account with its usage windows and
// their forecast, a form to add an account and log it in, which account each
// project runs on (with a picker to change it), and the history of moves. The windows themselves are ALSO published to bb's
// Provider usage panel through server.ts; this section is where you act.
// And, in a Claude Code thread's header, the project's account with a menu
// to change it (an experimental bb slot, registered only when the host has it);
// the same control in the new-thread composer, for the project picked there;
// and over a thread's composer, the advice to switch it to Opus when nothing
// queued says it.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, State } from "./server";
import {
  accountSummary,
  accountWindows,
  askForProject,
  composerProject,
  forecastLine,
  headerStatus,
  newestFirst,
  noLoginFound,
  outText,
  picksOnSelect,
  projectsByAccount,
  projectName,
  projectRead,
  retryDelayMs,
  seatsText,
  sharedWith,
  type SeatsLike,
  signalsBack,
  windowForecast,
  windowPercent,
} from "./src/ui";
import { CLAUDE_CODE_PROVIDER } from "./src/switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type AccountState = State["accounts"][number];
/** Select value for a project whose CLAUDE_CONFIG_DIR was set by something else. */
const EXTERNAL = "__external__";
const STALE = "__stale__";

// The last list any view received: a header mounting for another thread
// shows it at once while its own read is under way (bb can take seconds).
let lastSeen: State | null = null;
// Shared by every view, as lastSeen is: a read started before a pick that
// lands after it must not show the account the project had before.
const answers = newestFirst<State>();
// Whether each thread is a Claude Code thread: a thread keeps its provider.
const claudeThreads = new Map<string, boolean>();

function useAccounts() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State | null>(lastSeen);
  const [error, setError] = useState<string | null>(null);
  /** Only a change the user made (not a refresh) that failed. */
  const [changeError, setChangeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const keep = useCallback((ticket: number, next: State) => {
    const shown = answers.accept(ticket, next);
    lastSeen = shown;
    setState(shown);
    return shown;
  }, []);
  // A failed read is tried again (bb busy or restarting) rather than leaving
  // the view empty until the next change; one pending retry per view.
  const retry = useRef<{
    alive: boolean;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
  }>({ alive: true, attempt: 0 });
  const refetch = useCallback(() => {
    clearTimeout(retry.current.timer);
    const ticket = answers.start();
    rpc.call("accounts_list", null).then(
      (next) => {
        retry.current.attempt = 0;
        keep(ticket, next);
        setError(null);
      },
      (cause) => {
        report(cause);
        if (!retry.current.alive) return;
        clearTimeout(retry.current.timer);
        retry.current.timer = setTimeout(
          refetch,
          retryDelayMs(retry.current.attempt++),
        );
      },
    );
  }, [rpc, report, keep]);
  useEffect(() => {
    const current = retry.current;
    current.alive = true;
    refetch();
    return () => {
      current.alive = false;
      clearTimeout(current.timer);
    };
  }, [refetch]);
  useRealtime("accounts-changed", refetch);
  /**
   * A list that must include this project (see sharedProjects in server.ts);
   * false when the read failed, or a newer list without it hid its answer.
   */
  const readProject = useCallback(
    (project: string) => {
      const ticket = answers.start();
      return rpc.call("accounts_list", { project }).then(
        (next) => {
          const shown = keep(ticket, next);
          setError(null);
          return projectRead(next, shown, project);
        },
        (cause: unknown) => {
          report(cause);
          return false;
        },
      );
    },
    [rpc, report, keep],
  );
  const run = useCallback(
    async (work: () => Promise<State>) => {
      setBusy(true);
      // Cleared first, so a repeated failure is announced again.
      setChangeError(null);
      const ticket = answers.start();
      try {
        keep(ticket, await work());
        setError(null);
      } catch (cause) {
        report(cause);
        setChangeError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [report, keep],
  );
  return {
    state,
    error,
    changeError,
    busy,
    refetch,
    readProject,
    refresh: () => run(() => rpc.call("accounts_refresh", null)),
    setProjectAccount: (projectId: string, account: string | null) =>
      run(() => rpc.call("project_set_account", { projectId, account })),
    startLogin: (name: string) =>
      run(() => rpc.call("account_login_start", { name })),
    sendCode: (code: string) =>
      run(() => rpc.call("account_login_code", { code })),
    cancelLogin: () => run(() => rpc.call("account_login_cancel", null)),
  };
}

type Forecast = State["forecasts"][string][string];

function formatReset(resetsAt: number | null): string {
  if (resetsAt === null) return "";
  const diff = resetsAt - Date.now();
  if (diff <= 0) return "resetting";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

function formatObserved(observedAt: number | null): string {
  if (observedAt === null) return "never measured";
  const minutes = Math.round((Date.now() - observedAt) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function barClass(usedPercent: number): string {
  if (usedPercent >= 95) return "bg-destructive";
  if (usedPercent >= 80) return "bg-warning";
  return "bg-primary";
}

/**
 * An account's windows in short lines: "ses 10% · sem 40% · Fable 20%"
 * (no weekly on a Team seat), "agotada hasta …" when one is full, a thin
 * bar per window side by side, and in small text when each resets and the
 * pace of the window that matters (as in the thread's menu). Written out,
 * not only in the titles, which neither a keyboard nor a touch opens
 * (Codex E46-R6-003).
 */
export function UsageRow({
  usage,
  preferredModel,
  forecasts,
}: {
  usage: NonNullable<AccountState["usage"]>;
  preferredModel: string;
  forecasts: Record<string, Forecast> | undefined;
}) {
  const now = Date.now();
  const summary = accountSummary(usage, preferredModel, now);
  const windows = accountWindows(usage).map((w) => {
    const used = Math.round(windowPercent(w.window, now));
    const forecast = forecasts?.[w.key];
    const pace = forecast === undefined ? null : forecastLine(forecast, now);
    const reset =
      w.window.resetsAt === null ? "" : ` · ${formatReset(w.window.resetsAt)}`;
    return {
      ...w,
      used,
      title: `${w.label}: ${used}%${reset}${pace === null ? "" : ` · ${pace}`}`,
    };
  });
  const resets = windows.flatMap((w) =>
    w.window.resetsAt === null
      ? []
      : [`${w.short} ${formatReset(w.window.resetsAt)}`],
  );
  const paced = windowForecast(
    forecasts === undefined ? undefined : { own: forecasts },
    "own",
    preferredModel,
  );
  const pace = paced === null ? null : forecastLine(paced[1], now);
  const details = [
    ...(resets.length === 0 ? [] : [`resets ${resets.join(", ")}`]),
    ...(pace === null
      ? []
      : [`${windows.find((w) => w.key === paced?.[0])?.short ?? paced?.[0]} ${pace}`]),
  ];
  return (
    <div className="mt-1">
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] tabular-nums text-muted-foreground">
        {windows.map((w, i) => (
          <span key={w.key} title={w.title}>
            {i === 0 ? "" : "· "}
            {w.short} {w.used}%
          </span>
        ))}
        {summary.outUntil === undefined ? null : (
          <span className="text-destructive">
            {outText(summary.outUntil, now)}
          </span>
        )}
      </p>
      <div className="mt-1 flex gap-1">
        {windows.map((w) => {
          const pct = Math.max(0, Math.min(100, w.used));
          return (
            <div
              key={w.key}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={w.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={w.used}
              title={w.title}
            >
              <div
                className={cn("h-full rounded-full", barClass(pct))}
                style={{ width: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      {details.length === 0 ? null : (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {details.join(" · ")}
        </p>
      )}
    </div>
  );
}

export function AccountCard({
  account,
  isDefault,
  preferredModel,
  forecasts,
  twin = null,
  onLogin,
  busy = false,
  seats,
}: {
  account: AccountState;
  isDefault: boolean;
  preferredModel: string;
  forecasts: Record<string, Forecast> | undefined;
  /** Another listed account that is the same Claude account. */
  twin?: string | null;
  /**
   * Offered for an account without a login, or logged in to the Claude
   * account of another one; undefined while a login runs.
   */
  onLogin?: () => void;
  /** Another request of this page is on its way. */
  busy?: boolean;
  /** Its seats (threads at once) and who waits for one. */
  seats?: SeatsLike;
}) {
  const usage = account.usage;
  const seated = seatsText(seats);
  const status =
    account.problem?.kind === "unauthenticated"
      ? isDefault
        ? "Not logged in (run `claude` once if you want to use this account)"
        : "Not logged in"
      : account.problem?.kind === "error"
        ? account.problem.message
        : null;
  const noLogin = account.problem?.kind === "unauthenticated";
  // The default account's directory is the CLI's own: the other one is redone.
  const again = twin !== null && !isDefault;
  return (
    <li className="rounded-md border border-border px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{account.name}</span>
          {isDefault ? (
            <span
              className="ml-1.5 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
              title="The CLI's own directory, ~/.claude"
            >
              default
            </span>
          ) : null}
          {account.email === null ? null : (
            <span
              className="ml-1.5 truncate text-xs text-muted-foreground"
              title={account.email}
            >
              {account.email}
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {seated === null ? null : (
            <span
              className="mr-1.5"
              title="Threads running or about to start on this account, of the most allowed at once, and threads waiting for a seat"
            >
              {seated} ·
            </span>
          )}
          {formatObserved(account.observedAt)}
        </span>
      </div>
      {usage?.blocked ? (
        <p className="mt-1 text-xs text-destructive">
          Locked by the provider, or incomplete usage data
        </p>
      ) : null}
      {status === null ? null : (
        <p
          className={cn(
            "mt-1 text-xs",
            usage === null ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status}
        </p>
      )}
      {twin === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Same Claude account as {twin}: the two share one usage
        </p>
      )}
      {(noLogin || again) && onLogin !== undefined ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onLogin}
          disabled={busy}
          aria-label={`Log in ${account.name}${noLogin ? "" : " again"}`}
        >
          <Icon name="LogIn" className="size-3.5" />
          {noLogin ? "Log in" : "Log in again"}
        </Button>
      ) : null}
      {usage === null ? null : (
        <UsageRow
          usage={usage}
          preferredModel={preferredModel}
          forecasts={forecasts}
        />
      )}
    </li>
  );
}

/** The "add an account" form and the login it started. */
function AddAccount({
  login,
  busy,
  onStart,
  onCode,
  onCancel,
}: {
  login: State["login"];
  busy: boolean;
  onStart: (name: string) => void;
  onCode: (code: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  if (login === null) {
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== "") onStart(name.trim());
        }}
      >
        <Input
          className="h-8 w-40 text-xs"
          aria-label="Name of the new account"
          placeholder="new account name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy || name.trim() === ""}
        >
          <Icon name="Plus" className="size-3.5" />
          Add account
        </Button>
        <span className="text-xs text-muted-foreground">
          Opens Claude's login in the browser; the account gets its own
          directory under the accounts directory.
        </span>
      </form>
    );
  }
  const running = login.phase === "running";
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-xs",
        // A finished login with a message did not leave what was asked for.
        login.phase === "failed" || login.message !== null
          ? "border-destructive"
          : "border-border",
      )}
    >
      <p role={login.phase === "failed" ? "alert" : "status"}>
        <span className="font-medium">{login.name}</span>
        {": "}
        {login.phase === "running"
          ? "waiting for the login in the browser…"
          : login.phase === "done"
            ? (login.message ?? "logged in")
            : login.phase === "cancelled"
              ? "login cancelled"
              : `login failed: ${login.message ?? "no message"}`}
      </p>
      {running && login.manualUrl?.startsWith("https://") ? (
        <p className="mt-1 text-muted-foreground">
          If no browser window opened,{" "}
          <a
            className="underline"
            href={login.manualUrl}
            target="_blank"
            rel="noreferrer"
          >
            open the login page
          </a>{" "}
          and paste the code it shows below.
        </p>
      ) : null}
      {running && login.wantsCode ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim() !== "") {
              onCode(code.trim());
              setCode("");
            }
          }}
        >
          <Input
            className="h-8 w-56 text-xs"
            aria-label="Code shown by Claude"
            placeholder="code shown by Claude, if any"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || code.trim() === ""}
          >
            Send code
          </Button>
        </form>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="mt-2"
        onClick={onCancel}
        disabled={busy}
      >
        {running ? "Cancel" : "Dismiss"}
      </Button>
    </div>
  );
}

function AccountsSection() {
  const {
    state,
    error,
    busy,
    refresh,
    refetch,
    setProjectAccount,
    startLogin,
    sendCode,
    cancelLogin,
  } = useAccounts();
  if (state === null) {
    return (
      <div className="space-y-2 text-sm">
        <p
          role={error === null ? "status" : "alert"}
          className={
            error === null ? "text-muted-foreground" : "text-destructive"
          }
        >
          {error === null ? "Loading accounts…" : error}
        </p>
        {error === null ? null : (
          <Button variant="outline" size="sm" onClick={refetch}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground">
          {state.accounts.length} account
          {state.accounts.length === 1 ? "" : "s"}
          {state.autoSwitch
            ? " · automatic account choice is on"
            : " · automatic switch is off"}
          {state.preferredModel === ""
            ? ""
            : ` · prefers ${state.preferredModel}`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={busy}
          aria-busy={busy}
        >
          <Icon
            name="RotateCcw"
            className={cn("size-3.5", busy && "animate-spin")}
          />
          Refresh usage
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {noLoginFound(state.accounts) ? (
        <p className="text-muted-foreground">
          No Claude Code login found. Log in once with <code>claude</code> (the
          default account) or with{" "}
          <code>CLAUDE_CONFIG_DIR=&lt;dir&gt; claude</code> for an extra one,
          then refresh.
        </p>
      ) : null}
      <ul aria-label="Claude accounts" className="grid gap-2 lg:grid-cols-2">
        {state.accounts.map((account) => (
          <AccountCard
            key={account.name}
            account={account}
            isDefault={account.name === state.defaultAccountName}
            preferredModel={state.preferredModel}
            forecasts={state.forecasts?.[account.name]}
            twin={sharedWith(account, state.accounts)}
            seats={state.seats?.[account.name]}
            onLogin={
              state.login?.phase === "running"
                ? undefined
                : () => startLogin(account.name)
            }
            busy={busy}
          />
        ))}
      </ul>
      <AddAccount
        login={state.login ?? null}
        busy={busy}
        onStart={startLogin}
        onCode={sendCode}
        onCancel={cancelLogin}
      />
      <div>
        <h4 className="font-medium">Projects</h4>
        <p className="text-xs text-muted-foreground">
          Which account each project runs Claude Code with (its
          CLAUDE_CONFIG_DIR). New threads use it at once; a running thread picks
          it up on its next turn.
        </p>
        {state.projects.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No projects yet.</p>
        ) : null}
        <div role="group" aria-label="Projects" className="mt-2 grid gap-2">
          {projectsByAccount(state).map((group) => {
            const account = state.accounts.find(
              (a) => a.name === group.account,
            );
            return (
              <section key={group.heading} aria-label={`Projects on ${group.heading}`}>
                <div className="flex items-baseline justify-between gap-2 px-1 text-xs">
                  <span className="shrink-0 font-medium">{group.heading}</span>
                  {account === undefined ? null : (
                    <span className="truncate text-muted-foreground">
                      {usageLine(account, state.preferredModel, Date.now())}
                    </span>
                  )}
                </div>
                <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                  {group.projects.map((project) => (
                    <li
                      key={project.id}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0 truncate" title={project.name}>
                        {project.name}
                      </span>
                      <select
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                        aria-label={`Account for ${project.name}`}
                        title={
                          project.external
                            ? "CLAUDE_CONFIG_DIR is set outside this plugin; change it in the project's machine environment"
                            : undefined
                        }
                        value={
                          project.external
                            ? EXTERNAL
                            : project.owned && project.account === null
                              ? STALE
                              : (project.account ?? "")
                        }
                        disabled={busy || project.external}
                        onChange={(event) =>
                          setProjectAccount(
                            project.id,
                            event.target.value === "" ? null : event.target.value,
                          )
                        }
                      >
                        {project.external ? (
                          <option value={EXTERNAL} disabled>
                            CLAUDE_CONFIG_DIR set outside this plugin
                          </option>
                        ) : null}
                        {project.owned && project.account === null ? (
                          <option value={STALE} disabled>
                            account no longer exists: pick one
                          </option>
                        ) : null}
                        <option value="">{state.defaultAccountName} (~/.claude)</option>
                        {state.accounts
                          .filter((a) => a.name !== state.defaultAccountName)
                          .map((a) => (
                            <option key={a.name} value={a.name}>
                              {a.name}
                              {a.problem?.kind === "unauthenticated"
                                ? " (not logged in)"
                                : ""}
                            </option>
                          ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      <History state={state} />
    </div>
  );
}

const HISTORY_SHOWN = 20;

/** Every move of a project, latest first: automatic, ahead of the limit, or by hand. */
function History({ state }: { state: State }) {
  const [all, setAll] = useState(false);
  // A server older than this page sends only the last automatic switch.
  const moves =
    state.history ?? (state.lastSwitch === null ? [] : [state.lastSwitch]);
  if (moves.length === 0) return null;
  const shown = all ? moves : moves.slice(0, HISTORY_SHOWN);
  return (
    <div>
      <h4 className="font-medium">History</h4>
      <p className="text-xs text-muted-foreground">
        Every move of a project to another account, every thread told to
        switch to Opus, and why.
      </p>
      <ol
        aria-label="Moves"
        className="mt-2 divide-y divide-border rounded-md border border-border text-xs"
      >
        {shown.map((move, i) => (
          <li
            key={`${move.at}-${i}`}
            className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-1.5"
          >
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {new Date(move.at).toLocaleString()}
            </span>
            <span className="min-w-0 break-words">
              <span className="font-medium">
                {projectName(state.projects, move.projectId)}
              </span>
              : {move.from} → {move.to}
              <span className="text-muted-foreground"> · {move.reason}</span>
            </span>
          </li>
        ))}
      </ol>
      {moves.length > HISTORY_SHOWN ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${moves.length}`}
        </Button>
      ) : null}
    </div>
  );
}

type Tone = NonNullable<ReturnType<typeof headerStatus>>["tone"];
const TONE_DOT: Record<Tone, string> = {
  ok: "bg-success",
  tight: "bg-warning",
  out: "bg-destructive",
  unknown: "bg-muted-foreground",
  nologin: "bg-destructive",
};
const TONE_TEXT: Record<Tone, string> = {
  ok: "has room",
  tight: "running low",
  out: "out of usage",
  unknown: "not measured",
  nologin: "not logged in",
};

/** "session 10% · weekly 40% · Fable 100%" for the account menu. */
function usageLine(
  account: AccountState,
  preferredModel: string,
  now: number,
): string {
  if (account.problem?.kind === "unauthenticated") return "not logged in";
  const failed = account.problem?.kind === "error";
  if (account.usage === null)
    return failed ? "last measurement failed" : "not measured yet";
  if (account.usage.unknown === true) return "not measured (incomplete answer)";
  if (account.usage.blocked) return "locked by the provider";
  // Never "100%" for an account that still has a little room.
  const pct = (w: { usedPercent: number; resetsAt: number | null }) => {
    const used = windowPercent(w, now);
    return `${used < 100 ? Math.min(99, Math.round(used)) : Math.round(used)}%`;
  };
  const parts = [
    `session ${pct(account.usage.session)}`,
    // A Team seat has no general weekly.
    ...(account.usage.weekly.absent === true
      ? []
      : [`weekly ${pct(account.usage.weekly)}`]),
  ];
  const model = Object.entries(account.usage.models).find(
    ([name]) =>
      preferredModel !== "" &&
      name.toLowerCase() === preferredModel.toLowerCase(),
  );
  if (model !== undefined) parts.push(`${model[0]} ${pct(model[1])}`);
  return parts.join(" · ") + (failed ? " (last query failed)" : "");
}

/**
 * The thread header control: which Claude Code account the thread's project
 * runs on, how that account stands, and a menu to move the project to the
 * best account or to any other one. Only for Claude Code threads.
 */
function ThreadAccount({
  threadId,
  projectId,
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const sdk = useSdk();
  const [claudeThread, setClaudeThread] = useState<string | null>(
    claudeThreads.get(threadId) === true ? threadId : null,
  );
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const known = claudeThreads.get(threadId);
    setClaudeThread(known === true ? threadId : null);
    if (known !== undefined) return;
    let attempt = 0;
    const ask = () => {
      sdk.threads.get({ threadId }).then(
        (thread) => {
          const claude = thread.providerId === CLAUDE_CODE_PROVIDER;
          claudeThreads.set(threadId, claude);
          if (live && claude) setClaudeThread(threadId);
        },
        () => {
          if (live) timer = setTimeout(ask, retryDelayMs(attempt++));
        },
      );
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sdk, threadId]);
  if (claudeThread !== threadId) return null;
  return (
    <ThreadAccountMenu
      projectId={projectId}
      isCompactViewport={isCompactViewport}
    />
  );
}

function ThreadAccountMenu({
  projectId,
  isCompactViewport,
  newThread = false,
  focusComposer,
}: {
  projectId: string;
  isCompactViewport: boolean;
  /** Puts the caret back in the draft once the menu closes. */
  focusComposer?: () => void;
  /**
   * In the new-thread composer: name the best account beside the button when
   * it is another one, and let a pick of the shown account keep it.
   */
  newThread?: boolean;
}) {
  const {
    state,
    changeError: error,
    busy,
    readProject,
    setProjectAccount,
  } = useAccounts();
  const helpId = useId();
  // A project made a moment ago can be missing from the list the views
  // share: asked for by name, and again after a failed read (bb busy).
  const missing =
    state !== null && headerStatus(state, projectId, Date.now()) === null;
  const [failedReads, setFailedReads] = useState(0);
  useEffect(() => {
    if (!missing) return;
    return askForProject(
      () => readProject(projectId),
      failedReads,
      () => setFailedReads((n) => n + 1),
    );
  }, [missing, projectId, readProject, failedReads]);
  if (state === null) return null;
  const now = Date.now();
  const status = headerStatus(state, projectId, now);
  if (status === null) return null;
  const name = status.account ?? "unknown account";
  // The pace of the window that decides for this account, when it is known.
  const picked =
    status.account === null
      ? null
      : windowForecast(state.forecasts, status.account, state.preferredModel);
  const pace = picked === null ? null : forecastLine(picked[1], now);
  const toValue = (account: string) =>
    account === state.defaultAccountName ? null : account;
  const keepsHelp = newThread && state.autoSwitch && !status.external;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-busy={busy}
          aria-label={`Claude account: ${name}, ${TONE_TEXT[status.tone]}${
            newThread && status.canSwitch ? `, best: ${status.best}` : ""
          }${error === null ? "" : ", the last change failed"}`}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              TONE_DOT[status.tone],
            )}
          />
          {isCompactViewport ? null : (
            <span className="max-w-32 truncate">{name}</span>
          )}
          {newThread && status.canSwitch && !isCompactViewport ? (
            <span className="max-w-32 truncate text-muted-foreground">
              · best: {status.best}
            </span>
          ) : null}
          {error === null ? null : (
            <span aria-hidden className="font-semibold text-destructive">
              !
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      {error === null ? null : (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
      <DropdownMenuContent
        align="start"
        className="w-72"
        mobileTitle="Claude account"
        // Read out with the menu: the arrow keys never reach a label.
        aria-describedby={keepsHelp ? helpId : undefined}
        // bb's composer form takes a mousedown that is not on a button for a
        // click on its draft, and React passes it up through the portal.
        onMouseDown={newThread ? (event) => event.stopPropagation() : undefined}
        // As bb's own composer menu does; unless something else took focus.
        // On a phone bb hides the keyboard when a menu closes: left so.
        onCloseAutoFocus={
          focusComposer === undefined
            ? undefined
            : (event) => {
                const active = document.activeElement;
                if (active !== null && active !== document.body) return;
                event.preventDefault();
                focusComposer();
              }
        }
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Claude account for this project, used by all its threads from their
          next turn
          {keepsHelp ? (
            <span id={helpId} className="block">
              Pick one, even the current one, before you send to keep it:
              otherwise a new project moves to the best account after its
              first turn.
            </span>
          ) : null}
          {picked === null || pace === null ? null : (
            <span className="block text-foreground">
              {picked[0] === "weekly" ? "Weekly" : picked[0]}: {pace}
            </span>
          )}
        </DropdownMenuLabel>
        {status.canSwitch && status.best !== null ? (
          <>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() =>
                setProjectAccount(projectId, toValue(status.best!))
              }
            >
              <Icon name="Repeat" className="size-3.5" />
              Switch now to {status.best}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {status.external ? (
          <DropdownMenuLabel className="text-xs font-normal">
            Set outside this plugin; change it where it was set.
          </DropdownMenuLabel>
        ) : (
          // Plain items marked as radios: the registry's radio group renders
          // nothing in the compact drawer, which would leave nothing to pick.
          <DropdownMenuGroup aria-label="Accounts">
            {state.accounts.map((account) => (
              <DropdownMenuItem
                key={account.name}
                role="menuitemradio"
                aria-checked={account.name === status.account}
                disabled={busy}
                onSelect={() => {
                  if (
                    !busy &&
                    picksOnSelect(account.name, status.account, newThread)
                  )
                    setProjectAccount(projectId, toValue(account.name));
                }}
              >
                {account.name === status.account ? (
                  <Icon name="Check" className="size-4 shrink-0" />
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {account.name}
                    {account.name === status.best ? " · best now" : ""}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {usageLine(account, state.preferredModel, now)}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {error === null ? null : (
          <DropdownMenuLabel className="text-xs font-normal text-destructive">
            {error}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The account control in the new-thread composer: the account the picked
 * project is on, the best one beside it when it is another, and the menu to
 * pick one before the first turn.
 */
function NewThreadAccount() {
  const composer = useComposer();
  // The composer only reports its collapsed layout, where bb hides plugin
  // actions anyway: the screen width is what keeps the button short.
  const narrow = useIsCompactViewport();
  const projectId = composerProject(composer.scope, composer.selection);
  if (projectId === null) return null;
  return (
    <ThreadAccountMenu
      key={projectId}
      projectId={projectId}
      isCompactViewport={composer.layout === "compact" || narrow}
      newThread
      focusComposer={() => composer.focus()}
    />
  );
}

/**
 * Over a thread's composer: the advice of its latest failure to switch it
 * to Opus, when nothing queued says it (a decline: beyond the maximum wait,
 * or no account will free; D3, Sol B2-004). It only shows: switching is the
 * user's, with bb's model picker. Read again on the server's signal for
 * this thread; a failed read is tried again.
 */
function ThreadAdvice() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [shown, setShown] = useState<{
    threadId: string;
    text: string | null;
  } | null>(null);
  const [signals, setSignals] = useState(0);
  useEffect(() => {
    if (threadId === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const ask = () => {
      rpc.call("thread_advice", { threadId }).then(
        ({ text }) => {
          if (live) setShown({ threadId, text });
        },
        () => {
          if (live) timer = setTimeout(ask, retryDelayMs(attempt++));
        },
      );
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, threadId, signals]);
  useRealtime("opus-advice", (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId)
      setSignals((n) => n + 1);
  });
  // A signal sent while bb's connection was down is lost, whether it added
  // the advice or took it away: read again when it is back (Sol B2-R2-004).
  const connection = useRealtimeConnectionState();
  const seen = useRef<typeof connection | undefined>(undefined);
  useEffect(() => {
    if (signalsBack(seen.current, connection)) setSignals((n) => n + 1);
    seen.current = connection;
  }, [connection]);
  if (shown === null || shown.threadId !== threadId || shown.text === null)
    return null;
  return (
    <div role="status" className="flex items-start gap-2 px-3 py-2 text-xs">
      <Icon name="Repeat" aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{shown.text}</span>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "claude-switcher",
    title: "Claude Switcher",
    description:
      "Every Claude Code account on this machine, its usage windows, and which account each project uses.",
    component: AccountsSection,
  });
  // Experimental in bb: a host without it (older, or once it is renamed)
  // keeps the Settings section instead of failing the whole frontend.
  if (typeof app.slots.experimental_threadHeaderAction === "function")
    app.slots.experimental_threadHeaderAction({
      id: "claude-account",
      title: "Claude account",
      component: ThreadAccount,
    });
  if (typeof app.composer?.customize === "function") {
    app.composer.customize({
      id: "claude-account",
      scopes: ["new-thread"],
      actions: [{ id: "claude-account", component: NewThreadAccount }],
    });
    app.composer.customize({
      id: "claude-opus-advice",
      scopes: ["thread"],
      banners: [{ id: "claude-opus-advice", component: ThreadAdvice }],
    });
  }
});
