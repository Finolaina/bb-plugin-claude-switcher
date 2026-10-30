// Claude Switcher — bb plugin frontend.
//
// A Settings section: every Claude Code account as design B draws it (a
// sentence on top, one row per account with what is left of its week; see
// src/panel.ts), a form to add an account and log it in, which account each
// project runs on (with a picker to change it), and the history of moves. The windows themselves are ALSO published to bb's
// Provider usage panel through server.ts; this section is where you act.
// And, in a Claude Code thread's header, the project's account with a menu
// to change it (an experimental bb slot, registered only when the host has it);
// the same control in the new-thread composer, for the project picked there;
// and over a thread's composer, the advice to switch it to Opus when nothing
// queued says it.
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
  askForProject,
  composerProject,
  headerStatus,
  newestFirst,
  noLoginFound,
  picksOnSelect,
  projectsByAccount,
  projectName,
  projectRead,
  retryDelayMs,
  sharedWith,
  signalsBack,
} from "./src/ui";
import {
  accountRow,
  forecastText,
  type Lang,
  menuLine,
  moveTime,
  type PanelBar,
  type PanelRow,
  type PanelState,
  panelList,
  panelWords,
  threadLine,
  uiLang,
} from "./src/panel";
import "./app.css";
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

/** The browser's language: Spanish when it is any Spanish (the plugin is public, in English). */
function useLang(): Lang {
  return uiLang(typeof navigator === "undefined" ? undefined : navigator.language);
}

/** Whether `value` differs from the last render's (false on the first). */
function useChanged<T>(value: T): boolean {
  const last = useRef(value);
  const changed = last.current !== value;
  useEffect(() => {
    last.current = value;
  });
  return changed;
}

const STATE_ICON: Record<PanelState, ReactNode> = {
  working: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  free: <path d="M3 8.5l3 3 7-7" />,
  kept: (
    <>
      <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  out: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  nodata: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5" />
    </>
  ),
};

export function StateIcon({ state, className }: { state: PanelState; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
    >
      {STATE_ICON[state]}
    </svg>
  );
}

/** The state as an icon and a word, never colour alone; it fades in when it changes. */
function StateWord({ row }: { row: PanelRow }) {
  const changed = useChanged(row.state);
  return (
    <span
      key={row.state}
      className={cn(
        "whitespace-nowrap font-medium",
        `cs-s-${row.state}`,
        changed && "cs-fade",
      )}
    >
      <StateIcon state={row.state} className="mr-1 inline-block align-[-0.15em]" />
      {row.word}
    </span>
  );
}

/** What is left, with today's share striped at its end; read out as «Le queda el 90 % de la semana». */
export function LeftBar({ bar }: { bar: PanelBar | null }) {
  if (bar === null) return <div className="cs-bar" aria-hidden />;
  const start = bar.left - bar.today;
  return (
    <div className="cs-bar" role="img" aria-label={bar.label}>
      <div
        className={cn(
          "cs-fill",
          bar.tone === "amber" && "cs-low",
          bar.tone === "blue" && "cs-five",
        )}
        style={{ transform: `scaleX(${bar.left / 100})` }}
      />
      {bar.today > 0 ? (
        <div
          className="cs-today"
          style={{ clipPath: `inset(0 ${100 - bar.left}% 0 ${start}%)` }}
        />
      ) : null}
    </div>
  );
}

/**
 * One account of design B: name and plan, the bar with the state and
 * today's line under it, and what is left and when it is back. Two lines
 * where the panel is narrow (a container query: the Settings column, a phone).
 */
export function AccountRowView({
  row,
  email = null,
  isDefault = false,
  twin = null,
  noLogin = false,
  forecast = null,
  onLogin,
  busy = false,
  lang,
}: {
  row: PanelRow;
  /** The pace of its window that matters, for the tooltip (forecastText). */
  forecast?: string | null;
  email?: string | null;
  isDefault?: boolean;
  twin?: string | null;
  noLogin?: boolean;
  /** Offered for an account without a login, or logged in to another one's Claude account. */
  onLogin?: () => void;
  busy?: boolean;
  lang: Lang;
}) {
  const words = panelWords(lang);
  const again = twin !== null && !isDefault;
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-2.5 @lg:grid-cols-[9.5rem_minmax(0,1fr)_9rem]"
      title={forecast === null ? row.help : `${row.help}\n${forecast}`}
    >
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col items-start gap-1">
        <span
          className="max-w-full truncate font-semibold leading-tight"
          title={[email, isDefault ? "~/.claude" : null].filter(Boolean).join(" · ") || undefined}
        >
          {row.name}
        </span>
        {row.planShort === "" ? null : (
          <span
            className="max-w-full truncate rounded-full border border-border px-1.5 text-[11px] leading-[1.125rem] text-muted-foreground"
            title={row.planLong}
          >
            {row.planShort}
          </span>
        )}
      </div>
      <div className="col-span-2 row-start-2 min-w-0 @lg:col-span-1 @lg:col-start-2 @lg:row-start-1">
        <LeftBar bar={row.bar} />
        <p className="mt-1.5 text-xs leading-snug text-pretty">
          <StateWord row={row} />
          {row.line === "" ? null : (
            <span className="text-muted-foreground"> · {row.line}</span>
          )}
        </p>
        {twin === null ? null : (
          <p className="mt-0.5 text-xs text-muted-foreground">{words.sameAs(twin)}</p>
        )}
      </div>
      <div className="col-start-2 row-start-1 flex flex-col items-end gap-0.5 text-right text-xs @lg:col-start-3">
        {row.figure === null ? (
          <span className="text-muted-foreground">{words.noFigure}</span>
        ) : (
          <span className="whitespace-nowrap">
            <span className="text-[13px] font-semibold tabular-nums">{row.figure}</span>{" "}
            <span className="text-muted-foreground">{row.figureOf}</span>
          </span>
        )}
        {row.when === "" ? null : (
          <span className="whitespace-nowrap tabular-nums text-muted-foreground">{row.when}</span>
        )}
        {(noLogin || again) && onLogin !== undefined ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-1 h-7 px-2 text-xs"
            onClick={onLogin}
            disabled={busy}
            aria-label={`${noLogin ? words.logIn : words.logInAgain}: ${row.name}`}
          >
            <Icon name="LogIn" className="size-3.5" />
            {noLogin ? words.logIn : words.logInAgain}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Design B: the sentence that says who works, who is kept for you and which
 * has most week left, then the Ultra/Max accounts by what is left of their
 * week and the Team seats by name.
 */
export function AccountsOverview({
  state,
  now,
  lang,
  timeZone,
  busy = false,
  onLogin,
  onRefresh,
}: {
  state: State;
  now: number;
  lang: Lang;
  timeZone?: string;
  busy?: boolean;
  /** Undefined while a login runs. */
  onLogin?: (name: string) => void;
  onRefresh?: () => void;
}) {
  const list = panelList(state, { now, lang, timeZone, preferredModel: state.preferredModel });
  const words = panelWords(lang);
  const byName = new Map(state.accounts.map((a) => [a.name, a]));
  return (
    <div className="cs-tone @container space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] leading-normal text-pretty" aria-live="polite">
          {list.sentence.map((piece, i) =>
            piece.bold ? (
              <b key={i} className="font-semibold">
                {piece.text}
              </b>
            ) : (
              <span key={i}>{piece.text}</span>
            ),
          )}
        </p>
        {onRefresh === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onRefresh}
            disabled={busy}
            aria-busy={busy}
          >
            <Icon name="RotateCcw" className={cn("size-3.5", busy && "animate-spin")} />
            {busy ? words.refreshing : words.refresh}
          </Button>
        )}
      </div>
      {list.groups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h4 className="text-xs font-medium text-muted-foreground">{group.title}</h4>
          <ul className="divide-y divide-border">
            {group.rows.map((row) => {
              const account = byName.get(row.name);
              return (
                <AccountRowView
                  key={row.name}
                  row={row}
                  lang={lang}
                  email={account?.email ?? null}
                  isDefault={row.name === state.defaultAccountName}
                  twin={account === undefined ? null : sharedWith(account, state.accounts)}
                  noLogin={account?.problem?.kind === "unauthenticated"}
                  forecast={forecastText(state.forecasts, row.name, state.preferredModel, now, lang)}
                  onLogin={onLogin === undefined ? undefined : () => onLogin(row.name)}
                  busy={busy}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
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
  const lang = useLang();
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
      <AccountsOverview
        state={state}
        now={Date.now()}
        lang={lang}
        busy={busy}
        onRefresh={refresh}
        onLogin={state.login?.phase === "running" ? undefined : startLogin}
      />
      <p className="text-xs text-muted-foreground">
        {state.accounts.length} account
        {state.accounts.length === 1 ? "" : "s"}
        {state.autoSwitch
          ? " · automatic account choice is on"
          : " · automatic switch is off"}
        {state.preferredModel === ""
          ? ""
          : ` · prefers ${state.preferredModel}`}
      </p>
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
                    <AccountLine
                      row={rowOf(state, account, lang)}
                      className="min-w-0"
                    />
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
              {moveTime(move.at)}
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

/** An account's row of design B, for the menu and the projects' headings. */
function rowOf(state: State, account: AccountState, lang: Lang, now = Date.now()): PanelRow {
  return accountRow(account, state.seats?.[account.name], {
    now,
    lang,
    preferredModel: state.preferredModel,
  });
}

/** «▶ Trabajando · 40 % de la semana · vuelve lun 09:00»: an account in one short line. */
function AccountLine({ row, className }: { row: PanelRow; className?: string }) {
  const rest = menuLine(row);
  return (
    <span className={cn("flex items-center gap-1 truncate text-xs", className)}>
      <span className={cn("inline-flex shrink-0 items-center gap-1", `cs-s-${row.state}`)}>
        <StateIcon state={row.state} className="size-3" />
        {row.word}
      </span>
      {rest === "" ? null : <span className="truncate text-muted-foreground">· {rest}</span>}
    </span>
  );
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

/**
 * The thread's own account at the top of its menu, as a small card with its
 * figure in large type (design B takes this from design A): what is left,
 * the bar, its state and today's line, and the one-line summary.
 */
export function ThreadAccountCard({ row, forecast }: { row: PanelRow; forecast: string | null }) {
  return (
    <div className="mx-1 mt-1 mb-1.5 rounded-md bg-muted/60 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium">{row.name}</span>
        <StateWord row={row} />
      </div>
      {row.figure === null ? null : (
        <p className="mt-1 leading-none">
          <span className="text-xl font-semibold tabular-nums">{row.figure}</span>{" "}
          <span className="text-xs text-muted-foreground">{row.figureOf}</span>
        </p>
      )}
      <div className="mt-2">
        <LeftBar bar={row.bar} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{threadLine(row)}</p>
      {row.line === "" || row.state === "out" || row.state === "nodata" ? null : (
        <p className="text-xs text-muted-foreground">{row.line}</p>
      )}
      {forecast === null ? null : <p className="text-xs text-pretty text-muted-foreground">{forecast}</p>}
    </div>
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
  const lang = useLang();
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
  // The thread's account as design B says it: its state, what is left, when it is back.
  const own = state.accounts.find((a) => a.name === status.account);
  const row = own === undefined ? null : rowOf(state, own, lang, now);
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
          aria-label={`Claude account: ${name}${
            row === null ? "" : `, ${row.word}, ${threadLine(row)}`
          }${newThread && status.canSwitch ? `, best: ${status.best}` : ""}${
            error === null ? "" : ", the last change failed"
          }`}
        >
          {row === null ? (
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground" />
          ) : (
            <StateIcon state={row.state} className={cn("size-3", `cs-s-${row.state}`)} />
          )}
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
        className="cs-tone w-72"
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
        {row === null ? null : (
          <ThreadAccountCard
            row={row}
            forecast={forecastText(state.forecasts, row.name, state.preferredModel, now, lang)}
          />
        )}
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
                  <AccountLine row={rowOf(state, account, lang, now)} />
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
