// Claude Switcher — bb plugin frontend.
//
// One Settings section: every Claude Code account with its usage windows,
// which account each project runs on (with a picker to change it), and the
// last automatic switch. The windows themselves are ALSO published to bb's
// Provider usage panel through server.ts; this section is where you act.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, State } from "./server";
import { noLoginFound } from "./src/ui";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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
      try {
        setState(await work());
        setError(null);
      } catch (cause) {
        report(cause);
      } finally {
        setBusy(false);
      }
    },
    [report],
  );
  return {
    state,
    error,
    busy,
    refetch,
    refresh: () => run(() => rpc.call("accounts_refresh", null)),
    setProjectAccount: (projectId: string, account: string | null) =>
      run(() => rpc.call("project_set_account", { projectId, account })),
  };
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

function WindowBar({ label, window }: { label: string; window: Window }) {
  const pct = Math.max(0, Math.min(100, window.usedPercent));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums">
          {Math.round(window.usedPercent)}%
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
        aria-valuenow={Math.round(window.usedPercent)}
      >
        <div
          className={cn("h-full rounded-full", barClass(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function AccountCard({
  account,
  isDefault,
}: {
  account: AccountState;
  isDefault: boolean;
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
      {usage === null ? null : (
        <div className="mt-2 grid gap-2">
          <WindowBar label="Session (5 h)" window={usage.session} />
          <WindowBar label="Weekly (all models)" window={usage.weekly} />
          {Object.entries(usage.models).map(([model, window]) => (
            <WindowBar
              key={model}
              label={`Weekly · ${model}`}
              window={window}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function AccountsSection() {
  const { state, error, busy, refresh, refetch, setProjectAccount } =
    useAccounts();
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
            ? " · automatic switch on subscription limits is on"
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
          default account) or with <code>CLAUDE_CONFIG_DIR=&lt;dir&gt; claude</code>{" "}
          for an extra one, then refresh.
        </p>
      ) : null}
      <ul aria-label="Claude accounts" className="grid gap-2 lg:grid-cols-2">
        {state.accounts.map((account) => (
          <AccountCard
            key={account.name}
            account={account}
            isDefault={account.name === state.defaultAccountName}
          />
        ))}
      </ul>
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
      {state.lastSwitch === null ? null : (
        <p className="text-xs text-muted-foreground">
          Last automatic switch: {state.lastSwitch.from} →{" "}
          {state.lastSwitch.to}, {new Date(state.lastSwitch.at).toLocaleString()}
          . {state.lastSwitch.reason}.
        </p>
      )}
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
});
