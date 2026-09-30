// Claude Switcher — bb plugin frontend.
//
// A Settings section: every Claude Code account with its usage windows and
// their forecast, a form to add an account and log it in, which account each
// project runs on (with a picker to change it), and the history of moves. The windows themselves are ALSO published to bb's
// Provider usage panel through server.ts; this section is where you act.
// And, in a Claude Code thread's header, the project's account with a menu
// to change it (an experimental bb slot, registered only when the host has it).
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, State } from "./server";
import {
  forecastLine,
  headerStatus,
  noLoginFound,
  projectName,
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
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type AccountState = State["accounts"][number];
/** Select value for a project whose CLAUDE_CONFIG_DIR was set by something else. */
const EXTERNAL = "__external__";
const STALE = "__stale__";
type Window = NonNullable<AccountState["usage"]>["session"];

function useAccounts() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Only a change the user made (not a refresh) that failed. */
  const [changeError, setChangeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("accounts_list", null).then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("accounts-changed", refetch);
  const run = useCallback(
    async (work: () => Promise<State>) => {
      setBusy(true);
      // Cleared first, so a repeated failure is announced again.
      setChangeError(null);
      try {
        setState(await work());
        setError(null);
      } catch (cause) {
        report(cause);
        setChangeError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [report],
  );
  return {
    state,
    error,
    changeError,
    busy,
    refetch,
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

/** The forecast under a window's bar, when there is one. */
function ForecastLine({ forecast }: { forecast: Forecast | undefined }) {
  const line =
    forecast === undefined ? null : forecastLine(forecast, Date.now());
  if (line === null) return null;
  return (
    <p
      className={cn(
        "mt-0.5 text-[11px]",
        forecast?.kind === "runs-out"
          ? "text-warning"
          : "text-muted-foreground",
      )}
    >
      {line}
    </p>
  );
}

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

function WindowBar({
  label,
  window,
  forecast,
}: {
  label: string;
  window: Window;
  forecast?: Forecast;
}) {
  const used = windowPercent(window, Date.now());
  const pct = Math.max(0, Math.min(100, used));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums">
          {Math.round(used)}%
          {window.resetsAt === null ? null : (
            <span className="text-muted-foreground">
              {" "}
              · {formatReset(window.resetsAt)}
            </span>
          )}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
      >
        <div
          className={cn("h-full rounded-full", barClass(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <ForecastLine forecast={forecast} />
    </div>
  );
}

function AccountCard({
  account,
  isDefault,
  forecasts,
  onLogin,
}: {
  account: AccountState;
  isDefault: boolean;
  forecasts: Record<string, Forecast> | undefined;
  /** Offered for an account without a login; undefined while a login runs. */
  onLogin?: () => void;
}) {
  const usage = account.usage;
  const status =
    account.problem?.kind === "unauthenticated"
      ? isDefault
        ? "Not logged in (run `claude` once if you want to use this account)"
        : "Not logged in"
      : account.problem?.kind === "error"
        ? account.problem.message
        : null;
  return (
    <li className="rounded-md border border-border p-3">
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
      {account.problem?.kind === "unauthenticated" && onLogin !== undefined ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onLogin}>
          <Icon name="LogIn" className="size-3.5" />
          Log in
        </Button>
      ) : null}
      {usage === null ? null : (
        <div className="mt-2 grid gap-2">
          <WindowBar label="Session (5 h)" window={usage.session} />
          <WindowBar
            label="Weekly (all models)"
            window={usage.weekly}
            forecast={forecasts?.weekly}
          />
          {Object.entries(usage.models).map(([model, window]) => (
            <WindowBar
              key={model}
              label={`Weekly · ${model}`}
              window={window}
              forecast={forecasts?.[model]}
            />
          ))}
        </div>
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
      role="status"
      className={cn(
        "rounded-md border p-3 text-xs",
        login.phase === "failed" ? "border-destructive" : "border-border",
      )}
    >
      <p>
        <span className="font-medium">{login.name}</span>
        {": "}
        {login.phase === "running"
          ? "waiting for the login in the browser…"
          : login.phase === "done"
            ? "logged in"
            : login.phase === "cancelled"
              ? "login cancelled"
              : `login failed: ${login.message ?? "no message"}`}
      </p>
      {running && login.manualUrl !== null ? (
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
            forecasts={state.forecasts?.[account.name]}
            onLogin={
              state.login?.phase === "running"
                ? undefined
                : () => startLogin(account.name)
            }
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
        <ul
          aria-label="Projects"
          className="mt-2 divide-y divide-border rounded-md border border-border"
        >
          {state.projects.map((project) => (
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
        Every move of a project to another account, and why.
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
            <span className="min-w-0">
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
    `weekly ${pct(account.usage.weekly)}`,
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
  const [claudeThread, setClaudeThread] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setClaudeThread(null);
    sdk.threads.get({ threadId }).then(
      (thread) => {
        if (live && thread.providerId === CLAUDE_CODE_PROVIDER)
          setClaudeThread(threadId);
      },
      () => {},
    );
    return () => {
      live = false;
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
}: {
  projectId: string;
  isCompactViewport: boolean;
}) {
  const { state, changeError: error, busy, setProjectAccount } = useAccounts();
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-busy={busy}
          aria-label={`Claude account: ${name}, ${TONE_TEXT[status.tone]}${
            error === null ? "" : ", the last change failed"
          }`}
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
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Claude account for this project, used by all its threads from their
          next turn
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
                  if (!busy && account.name !== status.account)
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
});
