// Claude Switcher — bb plugin backend.
//
// Seven jobs:
//   1. Measure every Claude Code account on this machine (one config dir
//      each) and publish the windows to bb's Provider usage panel.
//   2. When a thread is created, put a new project on the best account, and
//      move a known one off an account already measured unable to run, so
//      the first turn does not fail. Before every turn, the same for the
//      model the turn is sent with (bb's dispatch checkpoint), whatever the
//      preferred model.
//   3. When a turn fails on a subscription limit, move the thread's project to
//      another account (CLAUDE_CONFIG_DIR as a project machine env var) and
//      retry the turn; when no account is free, retry at the earliest reset.
//   4. Let the user pin a project to an account from Settings or the CLI.
//   5. Optionally, when a turn ends with the project's account close to its
//      limit, move the project to an account with more room.
//   6. Keep the history of moves and a forecast of each weekly window.
//   7. Log an account in from Settings (`claude auth login` as a child).
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginThreadEventPayloads,
  type PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  discoverAccounts,
  expandHome,
  type Account,
  type AccountsIo,
} from "./src/accounts.js";
import { UsageCollector } from "./src/collector.js";
import {
  forecastWindow,
  recordSample,
  type Forecast,
  type Series,
} from "./src/forecast.js";
import type { CredentialIo } from "./src/credentials.js";
import {
  LoginFlow,
  type LoginIo,
  type LoginStatus,
} from "./src/login.js";
import {
  loginHelperPath,
  nodeAccountsIo,
  nodeCredentialIo,
  nodeLoginIo,
} from "./src/node-io.js";
import {
  CLAUDE_CODE_PROVIDER,
  declineReason,
  bestAccount,
  decideAhead,
  decidePlacement,
  decideSwitch,
  isRefusal,
  modelFamily,
} from "./src/switch.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageSourceRpcContract,
} from "./src/usage-source-contract.js";
import { toMeasurement, toResource } from "./src/usage-source.js";
import { forecastLine, projectName, sharedWith } from "./src/ui.js";

export const ENV_VAR = "CLAUDE_CONFIG_DIR";
/** Realtime channel app.tsx listens on after any state change. */
export const CHANGED = "accounts-changed";
/**
 * After a switch, turns that were already running on the old account keep
 * failing on it for a while. A failure of another turn of the same project
 * inside this window is one of those: retried as is, no second switch.
 */
export const SWITCH_GRACE_MS = 60_000;
/**
 * An account that refused a turn (its organization turned subscription access
 * off, or its login stopped working) is chosen for nothing this long, though
 * its usage still measures fine.
 */
export const REFUSAL_MS = 6 * 60 * 60_000;
/** A measurement older than this is taken again before moving a project ahead of the limit. */
export const AHEAD_FRESH_MS = 60_000;
/** bb fails a dispatch whose checkpoint takes 10 s: the placement before a turn is left behind well before. */
export const DISPATCH_LIMIT_MS = 3_000;
/** A login left waiting in the browser this long is given up. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** An account directory name: one path segment, no leading dot. */
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Note written next to CLAUDE_CONFIG_DIR; the account name is read back from it (values are secret). */
const NOTE_PREFIX = 'Claude Code account "';
const NOTE_SUFFIX = '" (set by the Claude Switcher plugin)';
export function noteFor(name: string): string {
  return `${NOTE_PREFIX}${name}${NOTE_SUFFIX}`;
}
export function accountFromNote(note: string | null): string | null {
  if (
    note === null ||
    !note.startsWith(NOTE_PREFIX) ||
    !note.endsWith(NOTE_SUFFIX)
  )
    return null;
  return (
    note.slice(NOTE_PREFIX.length, note.length - NOTE_SUFFIX.length) || null
  );
}
const KV_LAST_SWITCH = "last-switch";
/** Every move (automatic, ahead of the limit, or by hand), latest first. */
const KV_HISTORY = "switch-history";
/** Usage samples per account and window, for the forecast. */
const KV_SERIES = "usage-series";
export const HISTORY_LIMIT = 100;
/** A thread as bb reports it (the SDK does not export the type by name). */
type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
/** When this plugin first ran: a project created later is new. */
const KV_INSTALLED_AT = "installed-at";
/** New projects already placed, kept, or pinned by the user: no longer new. */
const KV_HANDLED_PROJECTS = "handled-projects";

/**
 * A hidden thread (a plugin's worker, a summary): moving the whole project
 * for it would surprise the user, and its owner decides about it. A visible
 * thread is the user's work even when a plugin's composer opened it.
 */
function notTheUsersThread(thread: ThreadResponse): string | null {
  if (thread.visibility !== "hidden") return null;
  return typeof thread.originPluginId === "string"
    ? `hidden thread of plugin ${thread.originPluginId}`
    : "hidden thread";
}

const windowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
});
const accountStateSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  accountUuid: z.string().nullable(),
  configDir: z.string().nullable(),
  observedAt: z.number().nullable(),
  problem: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("unauthenticated") }),
      z.object({ kind: z.literal("error"), message: z.string() }),
    ])
    .nullable(),
  usage: z
    .object({
      blocked: z.boolean(),
      /** A window was missing from the answer: `blocked` means "unknown", not "out". */
      unknown: z.boolean().optional(),
      session: windowSchema,
      weekly: windowSchema,
      models: z.record(z.string(), windowSchema),
    })
    .nullable(),
});
const projectStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Account named by the project's CLAUDE_CONFIG_DIR variable; null = default account. */
  account: z.string().nullable(),
  /** The variable is there with this plugin's note (account null + owned = it names an account that is gone). */
  owned: z.boolean(),
  /** CLAUDE_CONFIG_DIR is set on the project (or inherited) by something other than this plugin. */
  external: z.boolean(),
});
const forecastSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("runs-out"),
    at: z.number(),
    percentPerDay: z.number(),
  }),
  z.object({
    kind: z.literal("lasts"),
    until: z.number(),
    percentPerDay: z.number(),
  }),
  z.object({ kind: z.literal("steady") }),
  z.object({ kind: z.literal("unknown") }),
]);
const seriesSchema = z.object({
  resetsAt: z.number().nullable(),
  points: z.array(z.tuple([z.number(), z.number()])),
});
const loginStatusSchema = z.object({
  name: z.string(),
  phase: z.enum(["running", "done", "failed", "cancelled"]),
  startedAt: z.number(),
  manualUrl: z.string().nullable(),
  wantsCode: z.boolean(),
  message: z.string().nullable(),
});
const switchRecordSchema = z.object({
  // A time a Date can hold: the history prints it as a date.
  at: z.number().min(0).max(8.64e15),
  threadId: z.string(),
  projectId: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
});
const stateSchema = z.object({
  accounts: z.array(accountStateSchema),
  projects: z.array(projectStateSchema),
  defaultAccountName: z.string(),
  preferredModel: z.string(),
  autoSwitch: z.boolean(),
  lastSwitch: switchRecordSchema.nullable(),
  /** The account the switch policy would pick now; null when none can run. */
  bestAccount: z.string().nullable(),
  /** Every move of a project, latest first (at most HISTORY_LIMIT). */
  history: z.array(switchRecordSchema),
  /** Per account, per window ("weekly" or a model's display name): how it stands at the pace measured. */
  forecasts: z.record(z.string(), z.record(z.string(), forecastSchema)),
  /** The login started from bb, running or just ended; null when none. */
  login: loginStatusSchema.nullable(),
});
export type State = z.infer<typeof stateSchema>;
export type SwitchRecord = z.infer<typeof switchRecordSchema>;

export const rpcContract = defineRpcContract({
  accounts_list: { input: z.null(), output: stateSchema },
  accounts_refresh: { input: z.null(), output: stateSchema },
  project_set_account: {
    input: z.object({ projectId: z.string(), account: z.string().nullable() }),
    output: stateSchema,
  },
  /** Log an account in from bb: a new directory under the accounts dir, or a listed account without a login. */
  account_login_start: { input: z.object({ name: z.string().max(255) }), output: stateSchema },
  account_login_code: { input: z.object({ code: z.string().max(4096) }), output: stateSchema },
  /** Stops a running login; when none runs, forgets the last outcome. */
  account_login_cancel: { input: z.null(), output: stateSchema },
});

export interface PluginDeps {
  credentialIo: CredentialIo;
  accountsIo: AccountsIo;
  loginIo: LoginIo;
  /** Path of bin/open-login.sh, the BROWSER a login runs. */
  loginHelper: string;
  /** The plugin process's environment, inherited by a login. */
  env: Record<string, string | undefined>;
  now: () => number;
  random: () => number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** What a project's CLAUDE_CONFIG_DIR variable says, as bb reports it. */
interface ProjectAccount {
  /** The account it names, or null: none, or one that no longer exists. */
  account: string | null;
  /** The variable is there and carries this plugin's note. */
  owned: boolean;
  /** Set by hand or inherited: never touched by this plugin. */
  external: boolean;
}

export async function createPlugin(bb: BbPluginApi, deps: PluginDeps) {
  const settings = bb.settings.define({
    accountsDir: {
      type: "string",
      label: "Accounts directory",
      description:
        "Every subdirectory holding a .claude.json is one Claude Code account (its CLAUDE_CONFIG_DIR). The CLI's default directory (~/.claude, login in ~/.claude.json) is always the default account.",
      default: "~/.claude-accounts",
    },
    defaultAccountName: {
      type: "string",
      label: "Name of the default account (~/.claude)",
      default: "default",
    },
    preferredModel: {
      type: "string",
      label: "Preferred model",
      description:
        "Model display name as the usage API reports it (e.g. Fable). Only accounts that can still run it are chosen; when none can, the retry waits for the first moment an account can run it again. Empty = any.",
      default: "",
    },
    autoSwitch: {
      type: "boolean",
      label:
        "Choose accounts automatically: start new projects on the best one, and switch when a turn hits a subscription limit",
      default: true,
    },
    switchAheadPercent: {
      type: "number",
      label: "Switch ahead of the limit at (%)",
      description:
        "After each turn, when the project's account is at or above this share of its session, weekly or preferred-model window and another account is below it, the project moves there before a turn fails. Needs the automatic choice above. 0 = off (switch only when a turn fails).",
      default: 0,
    },
    maximumWaitHours: {
      type: "number",
      label: "Maximum automatic wait (hours)",
      description:
        "When no account is free, retry at the earliest reset only if it is closer than this. 0 = no limit.",
      default: 6,
    },
    refreshMinutes: {
      type: "number",
      label: "Usage refresh interval (minutes)",
      description: "Never below 1.",
      default: 5,
    },
    claudeCommand: {
      type: "string",
      label: "Claude Code executable",
      description:
        "Used to log an account in from bb (`claude auth login`). A name looked up in the bb server's PATH, or a full path.",
      default: "claude",
    },
    loginPrivateWindow: {
      type: "boolean",
      label:
        "Open logins in a private Chrome window on macOS (so they do not reuse the browser's Claude session)",
      default: true,
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    const moved =
      next.accountsDir !== current.accountsDir ||
      next.defaultAccountName !== current.defaultAccountName;
    current = next;
    // Found again (and stale measurements pruned) on next use: an account of
    // the old directory must not be picked.
    if (moved) accounts = [];
  });

  const collector = new UsageCollector({
    io: deps.credentialIo,
    now: deps.now,
  });
  let accounts: Account[] = [];
  /** When each account last refused a turn (in memory: a reload forgets it). */
  const refusedAt = new Map<string, number>();
  function refusing(name: string): boolean {
    const at = refusedAt.get(name);
    return at !== undefined && deps.now() - at < REFUSAL_MS;
  }
  /** Switches applied per project, for the grace window after each one. */
  const recentSwitches = new Map<
    string,
    {
      at: number;
      to: string;
      /**
       * The thread whose failure caused it: its next failure is on the new
       * account. Null for a placement: the placing thread's first turn may
       * have started on the old account, so it gets the grace retry too.
       */
      threadId: string | null;
      /** Set when it was a wait: leftovers wait for the same reset. */
      sendAt: number | undefined;
      /** Threads already given their one grace retry. */
      graced: Set<string>;
    }
  >();
  /** One turn.failed or thread.created handler per project at a time: handlers run concurrently. */
  const projectQueue = new Map<string, Promise<void>>();
  async function inProjectQueue(
    projectId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const previous = projectQueue.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    projectQueue.set(projectId, run);
    try {
      await run;
    } finally {
      if (projectQueue.get(projectId) === run) projectQueue.delete(projectId);
    }
  }

  /**
   * A project is new when bb created it after this plugin first ran and it
   * was never placed, kept or pinned since. Null when the install time cannot
   * be read or stored: then no project is moved for being new.
   */
  let installedAt: number | null = null;
  const handled = new Set<string>();
  try {
    const stored = await bb.storage.kv.get<unknown>(KV_INSTALLED_AT);
    if (typeof stored === "number") {
      installedAt = stored;
    } else {
      await bb.storage.kv.set(KV_INSTALLED_AT, deps.now());
      installedAt = deps.now();
    }
    const raw = await bb.storage.kv.get<unknown>(KV_HANDLED_PROJECTS);
    const list = z.array(z.string()).safeParse(raw);
    if (list.success) for (const id of list.data) handled.add(id);
    else if (raw !== undefined && raw !== null)
      bb.log.warn(
        "the list of projects already placed is unreadable; starting it again",
      );
  } catch (error) {
    installedAt = null;
    bb.log.warn(
      `could not read the plugin's storage; new projects will not be placed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  /** Latest first. Unreadable storage starts it again: a list, not a decision. */
  let history: SwitchRecord[] = [];
  try {
    // Record by record: one that cannot be read does not take the rest along.
    const stored = await bb.storage.kv.get<unknown>(KV_HISTORY);
    // No history yet: a version before it kept only the last switch.
    const records = Array.isArray(stored)
      ? stored
      : stored == null
        ? [await bb.storage.kv.get<unknown>(KV_LAST_SWITCH)].filter(
            (record) => record != null,
          )
        : [];
    history = records
      .flatMap((record) => {
        const parsed = switchRecordSchema.safeParse(record);
        return parsed.success ? [parsed.data] : [];
      })
      .slice(0, HISTORY_LIMIT);
    const dropped = Math.min(records.length, HISTORY_LIMIT) - history.length;
    if (dropped > 0 || (stored != null && !Array.isArray(stored)))
      bb.log.warn(
        `the stored history of moves had ${dropped > 0 ? `${dropped} unreadable record${dropped === 1 ? "" : "s"}` : "an unreadable shape"}; kept the rest`,
      );
  } catch (error) {
    bb.log.warn(
      `could not read the history of moves; starting it again: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  /** Usage samples per account and window, inside the window's current reset. */
  let series: Record<string, Record<string, Series>> = {};
  try {
    // Account by account, for the same reason.
    const stored = await bb.storage.kv.get<unknown>(KV_SERIES);
    const byAccount = z.record(z.string(), z.unknown()).safeParse(stored);
    const unreadable: string[] = [];
    for (const [name, value] of Object.entries(
      byAccount.success ? byAccount.data : {},
    )) {
      const parsed = z.record(z.string(), seriesSchema).safeParse(value);
      if (parsed.success) series[name] = parsed.data;
      else unreadable.push(name);
    }
    if (unreadable.length > 0 || (stored != null && !byAccount.success))
      bb.log.warn(
        `the stored usage samples ${unreadable.length > 0 ? `of ${unreadable.join(", ")}` : ""} could not be read; their forecast starts again`,
      );
  } catch (error) {
    bb.log.warn(
      `could not read the usage samples; starting them again: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let seriesWrites: Promise<void> = Promise.resolve();
  /**
   * Note the measured windows of every known account (the weekly one and
   * each model's) and drop the accounts that are gone. One write per pass.
   */
  function recordSamples(): Promise<void> {
    // No account found (an unreadable home, a directory being changed) is
    // not every account removed: the samples wait.
    if (accounts.length === 0) return seriesWrites;
    const next: Record<string, Record<string, Series>> = {};
    for (const account of accounts) {
      const m = collector.get(account.name);
      const own = series[account.name] ?? {};
      if (m?.usage === null || m?.usage === undefined || m.observedAt === null) {
        if (series[account.name] !== undefined) next[account.name] = own;
        continue;
      }
      // Only a fresh measurement is a sample: a failed query keeps the old usage.
      if (m.problem !== null && m.problem.kind === "error") {
        next[account.name] = own;
        continue;
      }
      const windows: [string, { usedPercent: number; resetsAt: number | null }][] = [
        ["weekly", m.usage.weekly],
        ...Object.entries(m.usage.models),
      ];
      const updated: Record<string, Series> = {};
      for (const [name, w] of windows)
        updated[name] = recordSample(own[name], {
          at: m.observedAt,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt,
        });
      next[account.name] = updated;
    }
    series = next;
    const snapshot = series;
    seriesWrites = seriesWrites.then(async () => {
      try {
        await bb.storage.kv.set(KV_SERIES, snapshot);
      } catch (error) {
        bb.log.warn(
          `could not store the usage samples: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return seriesWrites;
  }
  function forecasts(): State["forecasts"] {
    const now = deps.now();
    const out: State["forecasts"] = {};
    for (const [name, windows] of Object.entries(series)) {
      const own: Record<string, Forecast> = {};
      for (const [w, s] of Object.entries(windows))
        own[w] = forecastWindow(s, now);
      out[name] = own;
    }
    return out;
  }
  // ---- Login from bb -------------------------------------------------------
  /** What the check after a finished login found, shown with its status. */
  let loginNote: { of: LoginStatus; text: string } | null = null;
  function loginStatus(): State["login"] {
    const status = login.status();
    // The note of the very login on show: each end is its own status object.
    return status !== null && loginNote?.of === status
      ? { ...status, message: loginNote.text }
      : status;
  }
  const login = new LoginFlow(deps.loginIo, {
    command: () => current.claudeCommand.trim() || "claude",
    helper: deps.loginHelper,
    timeoutMs: LOGIN_TIMEOUT_MS,
    now: deps.now,
    onShared(name, linked, failed) {
      bb.log.info(
        linked.length === 0
          ? `created the directory of ${name}; nothing to share from the default account's directory`
          : `created the directory of ${name}, sharing ${linked.join(", ")} with the default account's directory`,
      );
      if (failed.length > 0)
        bb.log.warn(
          `the directory of ${name} could not share ${failed.join("; ")}: link them by hand (see the README)`,
        );
    },
    onChange(status) {
      bb.log.info(
        `login of ${status.name}: ${status.phase}${status.message === null ? "" : ` (${status.message})`}`,
      );
      bb.realtime.publish(CHANGED, { at: deps.now() });
      if (status.phase !== "done") return;
      // The directory and its login are new: find and measure the account.
      void (async () => {
        try {
          const found = await discover();
          const account = found.find((a) => a.name === status.name);
          if (account !== undefined) await collector.collect(account);
          await recordSamples();
          // Exit 0 is Claude Code's word; what it left is checked here.
          const twin =
            account === undefined ? null : sharedWith(account, found);
          const text =
            account === undefined
              ? "Claude Code reported a login, but no account was found in its directory"
              : collector.get(account.name)?.problem?.kind === "unauthenticated"
                ? "Claude Code reported a login, but the account still has no login; try again"
                : twin !== null
                  ? `logged in to the same Claude account as ${twin}: the two share one usage. Log in again and pick another account in the browser`
                  : null;
          if (text !== null) {
            loginNote = { of: status, text };
            bb.log.warn(`login of ${status.name}: ${text}`);
          }
        } catch (error) {
          const text = `the account could not be checked after its login: ${error instanceof Error ? error.message : String(error)}`;
          loginNote = { of: status, text };
          bb.log.warn(`login of ${status.name}: ${text}`);
        }
        bb.realtime.publish(CHANGED, { at: deps.now() });
      })();
    },
  });
  /**
   * An absolute path without `.`, `..` or repeated slashes, in lower case:
   * for comparing where two paths lead, on a disk that may ignore case.
   */
  function plainPath(path: string): string {
    const parts: string[] = [];
    for (const part of path.toLowerCase().split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }
  /**
   * Where a login for `name` goes: the default account (no directory), a
   * listed account without a login, or a new directory under the accounts
   * dir. An account already logged in is refused: its store would be
   * overwritten while a thread may be using it. The exception is a directory
   * logged in to the Claude account of another one (the browser answered
   * with the session it had): its login is the mistake to redo.
   */
  async function loginTarget(name: string): Promise<Account> {
    await discover();
    // A listed account keeps the name its directory has, whatever it is.
    const known = accounts.find((a) => a.name === name);
    if (known !== undefined) {
      if (known.configDir !== null && sharedWith(known, accounts) !== null)
        return known;
      if (collector.get(name) === undefined) await collector.collect(known);
      if (collector.get(name)?.problem?.kind !== "unauthenticated")
        throw new Error(`${name} is already logged in`);
      return known;
    }
    // From here the name becomes a new directory: a trust boundary.
    if (!ACCOUNT_NAME.test(name))
      throw new Error(
        "an account name starts with a letter or a digit and goes on with letters, digits, dots, dashes or underscores (up to 64)",
      );
    if (name === "default" && name !== current.defaultAccountName)
      throw new Error(
        `"default" names the default account, called ${current.defaultAccountName} here; use that name`,
      );
    // On a disk that ignores case, `Team` IS the directory of `team`: the
    // login would overwrite the store of an account that may be in use.
    const lower = name.toLowerCase();
    const twin = accounts.find((a) => a.name.toLowerCase() === lower);
    if (twin !== undefined)
      throw new Error(
        `an account named ${twin.name} already exists; use that name`,
      );
    const dir = expandHome(
      current.accountsDir.trim(),
      deps.accountsIo.home,
    ).replace(/\/+$/, "");
    // Under ~/.claude a new name can be `projects` or `plugins`: the login
    // would write into what every account shares, and list it as an account.
    const own = plainPath(`${deps.accountsIo.home}/.claude`);
    const plain = plainPath(dir);
    if (plain === own || plain.startsWith(`${own}/`))
      throw new Error(
        "the accounts directory is inside the default account's directory (~/.claude); set another one to add accounts from here",
      );
    for (const entry of await deps.loginIo.entries(dir)) {
      if (entry.name.toLowerCase() !== lower) continue;
      if (entry.name !== name)
        throw new Error(
          `a directory named ${entry.name} already exists in the accounts directory; use that name`,
        );
      // A link would take the login, and what is linked into it, elsewhere.
      if (!entry.directory)
        throw new Error(
          `${name} in the accounts directory is not a directory`,
        );
    }
    return {
      name,
      configDir: `${dir}/${name}`,
      email: null,
      accountUuid: null,
    };
  }
  /** Writes in order, like the handled list. */
  let historyWrites: Promise<void> = Promise.resolve();
  function addHistory(record: SwitchRecord): Promise<void> {
    history = [record, ...history].slice(0, HISTORY_LIMIT);
    const snapshot = history;
    historyWrites = historyWrites.then(async () => {
      try {
        await bb.storage.kv.set(KV_HISTORY, snapshot);
      } catch (error) {
        bb.log.warn(
          `could not record the move in the history: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return historyWrites;
  }
  /** Writes in order, so a slow write never overwrites a later, longer list. */
  let handledWrites: Promise<void> = Promise.resolve();
  function markHandled(projectId: string): Promise<void> {
    if (handled.has(projectId)) return handledWrites;
    handled.add(projectId);
    handledWrites = handledWrites.then(async () => {
      try {
        await bb.storage.kv.set(KV_HANDLED_PROJECTS, [...handled]);
      } catch (error) {
        bb.log.warn(
          `could not record project ${projectId} as handled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return handledWrites;
  }

  async function discover(): Promise<Account[]> {
    accounts = await discoverAccounts(deps.accountsIo, {
      accountsDir: current.accountsDir,
      defaultAccountName: current.defaultAccountName,
      warn: (message) => bb.log.warn(message),
    });
    // A measurement of an account that is gone must never be chosen.
    collector.prune(accounts);
    return accounts;
  }

  async function refreshAll(): Promise<void> {
    const found = await discover();
    await collector.collectAll(found);
    await recordSamples();
    bb.realtime.publish(CHANGED, { at: deps.now() });
  }

  /**
   * The project's account is whatever its CLAUDE_CONFIG_DIR machine variable
   * says, read from bb every time: bb never returns values, so the name comes
   * from the note this plugin writes next to it. A variable with another note
   * (set by hand, or inherited from the global environment) is "external"
   * and this plugin never touches it.
   */
  async function projectAccount(projectId: string): Promise<ProjectAccount> {
    const env = await bb.sdk.projects.machineEnvironment({ projectId });
    const own = env.variables.find((v) => v.name === ENV_VAR);
    if (own !== undefined) {
      const name = accountFromNote(own.note);
      if (name === null) return { account: null, owned: false, external: true };
      const known = accounts.some((a) => a.name === name);
      return { account: known ? name : null, owned: true, external: false };
    }
    const inherited = env.inheritedVariables.some((v) => v.name === ENV_VAR);
    return { account: null, owned: false, external: inherited };
  }

  /** Point the project at `account` (null = default). Refuses an external variable. */
  async function applyAccount(
    projectId: string,
    account: Account | null,
    from: ProjectAccount,
  ): Promise<void> {
    if (from.external) {
      throw new Error(
        `${ENV_VAR} on project ${projectId} was set outside this plugin; change it in the project's machine environment`,
      );
    }
    if (account === null || account.configDir === null) {
      // Default account = no variable. Only ours can be there (see above).
      if (from.owned) {
        await bb.sdk.projects.deleteMachineEnvironmentVariable({
          projectId,
          name: ENV_VAR,
        });
      }
    } else {
      await bb.sdk.projects.setMachineEnvironmentVariable({
        projectId,
        name: ENV_VAR,
        value: account.configDir,
        note: noteFor(account.name),
      });
    }
    bb.realtime.publish(CHANGED, { at: deps.now() });
  }

  /** Measurements recent enough to decide on (two refresh periods). */
  function measuredAccounts(model = current.preferredModel) {
    const maxAgeMs = 2 * Math.max(1, current.refreshMinutes) * 60_000;
    // A refusing account is out, whatever its numbers say.
    return collector.usable(maxAgeMs, model).map((a) => {
      if (!refusing(a.name)) return a;
      const { unknown: _, ...known } = a;
      return { ...known, blocked: true };
    });
  }

  async function state(): Promise<State> {
    if (accounts.length === 0) await discover();
    // The personal project too: a variable set there must be visible and releasable.
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return {
      accounts: accounts.map((account) => {
        const m = collector.get(account.name);
        return {
          name: account.name,
          email: account.email,
          accountUuid: account.accountUuid,
          configDir: account.configDir,
          observedAt: m?.observedAt ?? null,
          problem: m?.problem ?? null,
          usage: m?.usage ?? null,
        };
      }),
      projects: await Promise.all(
        projects.map(async (p) => ({
          id: p.id,
          name: p.name,
          ...(await projectAccount(p.id)),
        })),
      ),
      defaultAccountName: current.defaultAccountName,
      preferredModel: current.preferredModel,
      autoSwitch: current.autoSwitch,
      lastSwitch:
        (await bb.storage.kv.get<SwitchRecord>(KV_LAST_SWITCH)) ?? null,
      bestAccount: bestAccount(
        measuredAccounts(),
        current.preferredModel,
        deps.now(),
      ),
      history,
      forecasts: forecasts(),
      login: loginStatus(),
    };
  }

  function findAccount(name: string): Account {
    const account = accounts.find((a) => a.name === name);
    if (account === undefined) {
      throw new Error(
        `unknown account "${name}"; known: ${accounts.map((a) => a.name).join(", ") || "none"}`,
      );
    }
    return account;
  }

  /**
   * The default account is "no variable": its name means null, and so does
   * the literal `default` unless an account is actually called that.
   */
  function accountOrDefault(name: string): Account | null {
    if (name === current.defaultAccountName) return null;
    if (name === "default" && !accounts.some((a) => a.name === "default"))
      return null;
    return findAccount(name);
  }

  /**
   * A project's account chosen by hand (thread header, Settings, `use`), in
   * the project's queue: never interleaved with a failure or a placement.
   * `choose` runs after a fresh discovery, so an account directory added
   * since the last one is pickable.
   */
  /**
   * No login, or MEASURED unable to run any model: a turn sent there would
   * fail. Not measured yet, an incomplete answer, or no preferred model left
   * do not count: those accounts may still run it.
   */
  function cannotRun(name: string): boolean {
    if (collector.get(name)?.problem?.kind === "unauthenticated") return true;
    const known = measuredAccounts().find((a) => a.name === name);
    return (
      known !== undefined &&
      known.unknown !== true &&
      bestAccount([known], "", deps.now()) !== name
    );
  }

  async function pickAccount(
    projectId: string,
    choose: (find: (name: string) => Account) => Account | null,
  ): Promise<void> {
    await inProjectQueue(projectId, async () => {
      await discover();
      const from = await projectAccount(projectId);
      const to = choose(findAccount);
      await applyAccount(projectId, to, from);
      await markHandled(projectId);
      const fromName = from.account ?? current.defaultAccountName;
      const toName = to?.name ?? current.defaultAccountName;
      if (toName === fromName) return;
      bb.log.info(
        `project ${projectId}: picked by hand, ${fromName} → ${toName}`,
      );
      await addHistory({
        at: deps.now(),
        threadId: "",
        projectId,
        from: fromName,
        to: toName,
        reason: "Picked by hand",
      });
      // A turn already running on the old account fails there after the
      // pick: like after a switch, it runs again once on the picked account.
      // The pick is the user's, so it holds unless the account cannot run a
      // turn (see cannotRun); its own failure is judged.
      // A login made after the last measurement: look again before judging.
      const picked = accounts.find((a) => a.name === toName);
      if (
        picked !== undefined &&
        collector.get(toName)?.problem?.kind === "unauthenticated"
      )
        await collector.collect(picked);
      if (!cannotRun(toName))
        recentSwitches.set(projectId, {
          at: deps.now(),
          to: toName,
          threadId: null,
          sendAt: undefined,
          graced: new Set(),
        });
      else recentSwitches.delete(projectId);
    });
  }

  // ---- Provider usage panel source -------------------------------------
  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        return {
          label: "Claude accounts",
          resources: (await discover()).map(toResource),
        };
      },
      async [usageFetchMethod]({ resourceId, refresh }) {
        const account = accounts.find((a) => a.name === resourceId);
        if (account === undefined)
          throw new Error("Usage resource no longer exists.");
        if (refresh || collector.get(account.name) === undefined)
          await collector.collect(account);
        return toMeasurement(account, collector.get(account.name));
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Usage windows of every Claude Code account on this machine (one per CLAUDE_CONFIG_DIR).",
    },
  );

  // ---- Page RPC ---------------------------------------------------------
  bb.rpc.register(rpcContract, {
    accounts_list: () => state(),
    async accounts_refresh() {
      await refreshAll();
      return state();
    },
    async project_set_account({ projectId, account }) {
      await pickAccount(projectId, (discovered) =>
        account === null ? null : discovered(account),
      );
      return state();
    },
    async account_login_start({ name }) {
      const target = await loginTarget(name);
      const shareFrom = `${deps.accountsIo.home.replace(/\/+$/, "")}/.claude`;
      await login.start({ ...target, shareFrom }, {
        ...deps.env,
        CLAUDE_SWITCHER_PRIVATE: current.loginPrivateWindow ? "1" : "0",
      });
      return state();
    },
    async account_login_code({ code }) {
      login.code(code);
      return state();
    },
    async account_login_cancel() {
      login.cancel();
      return state();
    },
  });

  // ---- Retry of a failed turn ---------------------------------------------
  /**
   * Retry row bb (or its provider-retry plugin) already queued for the failed
   * turn. bb stamps the row with `attempt` = the failed turn's attempt + 1 and
   * keys it by the ORIGINAL request of the retry chain, while a retry's
   * failure reports the retry's own id: past the first attempt only the
   * attempt tells the rows apart. A retry row of an EARLIER turn can still be
   * waiting on the thread (the user sent a message by hand meanwhile): it is
   * skipped. bb allows one row per chain, so the first match is the one.
   */
  async function queuedRetry(
    event: PluginTurnFailedEvent,
  ): Promise<{ id: string; reason: string; sendAt: number | null } | null> {
    const rows = await bb.sdk.threads.queuedMessages.list({
      threadId: event.threadId,
    });
    for (const row of rows) {
      const payload = row.payload;
      if (payload.kind !== "retry") continue;
      if (payload.attempt !== event.attemptNumber + 1) continue;
      if (
        event.attemptNumber === 1 &&
        payload.retryOfTurnRequestId !== event.requestId
      )
        continue;
      return { id: row.id, reason: payload.reason, sendAt: row.sendAt };
    }
    return null;
  }

  /**
   * bb answers 409 `queued_message_still_waiting` when the thread is busy
   * again: the row stays queued and runs when it frees. The SDK keeps bb's
   * error code apart from the message ("HTTP 409: This message cannot be
   * sent yet: …"), so the code is checked first and the text is a fallback.
   */
  function stillWaiting(error: unknown): boolean {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "queued_message_still_waiting"
    )
      return true;
    return /cannot be sent yet/.test(
      error instanceof Error ? error.message : String(error),
    );
  }

  /** bb's answers for a row that is already on its way: sent meanwhile (404) or being sent right now (409). */
  function alreadyOnItsWay(error: unknown): boolean {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? error.status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return (
      (status === 404 && /queued message not found/i.test(message)) ||
      (status === 409 && /already being sent/i.test(message))
    );
  }

  async function sendQueued(threadId: string, id: string): Promise<void> {
    try {
      await bb.sdk.threads.queuedMessages.send({
        threadId,
        queuedMessageId: id,
        mode: "auto",
      });
    } catch (error) {
      if (stillWaiting(error)) {
        bb.log.info(
          `thread ${threadId}: busy again; the queued retry runs when it frees`,
        );
        return;
      }
      if (alreadyOnItsWay(error)) {
        bb.log.info(
          `thread ${threadId}: the queued retry is already on its way`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Retry the failed turn now (no sendAt) or at `sendAt`. bb keeps ONE retry
   * per turn: if provider-retry got there first, its row is sent right away
   * (the project is already on the new account) or replaced by our timed one.
   */
  async function retryTurn(
    event: PluginTurnFailedEvent,
    reason: string,
    sendAt?: number,
  ): Promise<void> {
    const threadId = event.threadId;
    const existing = await queuedRetry(event);
    if (existing !== null) {
      if (sendAt === undefined) {
        await sendQueued(threadId, existing.id);
        return;
      }
      try {
        await bb.sdk.threads.queuedMessages.delete({
          threadId,
          queuedMessageId: existing.id,
        });
      } catch (error) {
        // Sent between the list and this delete (bb would refuse a retry
        // of a thread that is running again), or removed by the user:
        // nothing to replace.
        if (!alreadyOnItsWay(error)) throw error;
        bb.log.info(
          `thread ${threadId}: the queued retry is already on its way; leaving it`,
        );
        return;
      }
    }
    try {
      await bb.sdk.threads.retry({
        threadId,
        turnRequestId: event.requestId,
        reason,
        ...(sendAt === undefined ? {} : { sendAt }),
      });
    } catch (error) {
      // Raced with another retry of the same turn between the list and ours.
      const raced = await queuedRetry(event);
      if (raced !== null) {
        if (sendAt === undefined) {
          await sendQueued(threadId, raced.id);
        } else {
          bb.log.warn(
            `thread ${threadId}: another retry was queued first; leaving it`,
          );
        }
        return;
      }
      if (existing === null || sendAt === undefined) throw error;
      // Ours failed after replacing the queued one: put that one back rather
      // than leave the turn without any retry.
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(
        `thread ${threadId}: could not queue the retry (${message}); restoring the one queued before`,
      );
      try {
        await bb.sdk.threads.retry({
          threadId,
          turnRequestId: event.requestId,
          reason: existing.reason,
          ...(existing.sendAt === null ? {} : { sendAt: existing.sendAt }),
        });
      } catch (restoreError) {
        throw new Error(
          `${message}; restoring the retry queued before failed too: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: error },
        );
      }
    }
  }

  /**
   * Record a move as the project's latest: shown in Settings, and leftover
   * turns follow it. `cause` is the thread whose failure caused the move
   * (null for a placement, which no failure caused).
   */
  async function recordMove(
    record: SwitchRecord,
    cause: string | null,
    sendAt?: number,
  ) {
    recentSwitches.set(record.projectId, {
      at: record.at,
      to: record.to,
      threadId: cause,
      sendAt,
      graced: new Set(),
    });
    try {
      await bb.storage.kv.set(KV_LAST_SWITCH, record);
    } catch (error) {
      bb.log.warn(
        `could not record the switch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await addHistory(record);
  }

  /** Same variable state: nobody moved the project while we were deciding. */
  function sameAccount(a: ProjectAccount, b: ProjectAccount): boolean {
    return (
      a.account === b.account &&
      a.owned === b.owned &&
      a.external === b.external
    );
  }

  // ---- Placement before a new thread's first turn ----------------------
  /**
   * Races the thread's first turn, on purpose: nothing here waits on the
   * network unless no account has a usable measurement. When the turn starts
   * first, it runs where the project was, and its failure gets the grace
   * retry on the new account (see recordMove).
   */
  async function placeProject(thread: ThreadResponse): Promise<void> {
    const projectId = thread.projectId;
    // Always: picks up a changed accounts directory and prunes its measurements.
    await discover();
    const from = await projectAccount(projectId);
    if (from.external) {
      bb.log.info(
        `thread ${thread.id}: not placed (the project's CLAUDE_CONFIG_DIR was not set by this plugin)`,
      );
      await markHandled(projectId);
      return;
    }
    let isNew = false;
    if (installedAt !== null && !handled.has(projectId) && !from.owned) {
      const project = await bb.sdk.projects.get({ projectId });
      isNew = project.createdAt > installedAt;
      bb.log.debug(
        `thread ${thread.id}: project created at ${project.createdAt}, plugin installed at ${installedAt}: ${isNew ? "new" : "not new"}`,
      );
    }
    let measured = measuredAccounts();
    // A new project is placed once: measure every account first, not only
    // those the startup refresh has reached.
    if (measured.length === 0 || (isNew && measured.length < accounts.length)) {
      await refreshAll();
      measured = measuredAccounts();
    }
    if (measured.length === 0) {
      // Nothing to decide on: the project stays new for its next thread.
      bb.log.info(
        `thread ${thread.id}: not placed (no account could be measured)`,
      );
      return;
    }
    const now = deps.now();
    const fromName = from.account ?? current.defaultAccountName;
    const decision = decidePlacement({
      currentAccount: fromName,
      isNew,
      accounts: measured,
      preferredModel: current.preferredModel,
      now,
    });
    if (decision.kind === "keep") {
      bb.log.info(
        `thread ${thread.id}: project left on account ${fromName} (${isNew ? "the best account for a new project" : "its account can run"})`,
      );
      await markHandled(projectId);
      return;
    }
    const latest = await projectAccount(projectId);
    // A pick of the default account writes nothing; the handled mark shows it.
    if (!sameAccount(from, latest) || (isNew && handled.has(projectId))) {
      bb.log.info(
        `thread ${thread.id}: not placed (the project's account changed meanwhile)`,
      );
      await markHandled(projectId);
      return;
    }
    await applyAccount(projectId, accountOrDefault(decision.account), latest);
    await markHandled(projectId);
    const reason =
      decision.why === "new-project"
        ? `New project placed on account ${decision.account}${current.preferredModel === "" ? "" : ` (${current.preferredModel})`}`
        : `Moved to account ${decision.account} before the turn: ${fromName} ${current.preferredModel === "" ? "is out of usage" : `cannot run ${current.preferredModel}`}`;
    bb.log.info(`thread ${thread.id}: ${reason}`);
    await recordMove(
      {
        at: now,
        threadId: thread.id,
        projectId,
        from: fromName,
        to: decision.account,
        reason,
      },
      null,
    );
  }

  // ---- Move ahead of the limit, after a turn -----------------------------
  /** When the usage of each account was last asked for here, answered or not. */
  const aheadAsked = new Map<string, number>();
  /**
   * The turn that just ended consumed some of the account: measure it again
   * unless it was measured, or asked, within AHEAD_FRESH_MS (a provider that
   * is failing is not asked again at every turn end). Outside the project's
   * queue: a failed turn of the project must not wait on this query.
   */
  async function measureForAhead(projectId: string): Promise<void> {
    const at = await projectAccount(projectId);
    if (at.external) return;
    const name = at.account ?? current.defaultAccountName;
    const account = accounts.find((a) => a.name === name);
    if (account === undefined) return;
    const now = deps.now();
    const latest = Math.max(
      collector.get(name)?.observedAt ?? -Infinity,
      aheadAsked.get(name) ?? -Infinity,
    );
    if (now - latest <= AHEAD_FRESH_MS) return;
    aheadAsked.set(name, now);
    await collector.collect(account);
    await recordSamples();
  }
  /**
   * When a turn ends, the project's account may be close to its limit: move
   * the project now, while another account has room, rather than let the
   * next turn fail. Judged on the latest measurement of each account (see
   * measureForAhead for the project's own).
   */
  async function moveAhead(thread: ThreadResponse): Promise<void> {
    // Asked again: the settings may have changed while the account was measured.
    if (!current.autoSwitch || !(current.switchAheadPercent > 0)) return;
    const projectId = thread.projectId;
    const from = await projectAccount(projectId);
    if (from.external) return;
    const fromName = from.account ?? current.defaultAccountName;
    const now = deps.now();
    // Nothing fails if the project stays, so a target has to be sure: an
    // account listed now, measured within two refresh periods (a query that
    // keeps failing leaves an old measurement), and another Claude account
    // (a directory of the same one shares its usage and gains nothing).
    const maxAgeMs = 2 * Math.max(1, current.refreshMinutes) * 60_000;
    const own = accounts.find((a) => a.name === fromName);
    const candidates = measuredAccounts().filter((usage) => {
      if (usage.name === fromName) return true;
      const account = accounts.find((a) => a.name === usage.name);
      const observedAt = collector.get(usage.name)?.observedAt ?? null;
      return (
        account !== undefined &&
        observedAt !== null &&
        now - observedAt <= maxAgeMs &&
        (own === undefined ||
          own.accountUuid === null ||
          account.accountUuid !== own.accountUuid)
      );
    });
    const decision = decideAhead({
      currentAccount: fromName,
      accounts: candidates,
      preferredModel: current.preferredModel,
      threshold: current.switchAheadPercent,
      now,
    });
    if (decision.kind === "keep") return;
    await applyAccount(projectId, accountOrDefault(decision.account), from);
    await markHandled(projectId);
    const reason = `Switched ahead of the limit to ${decision.account}: ${fromName} at ${Math.round(decision.used)}% of ${decision.window}`;
    bb.log.info(`thread ${thread.id}: ${reason}`);
    await recordMove(
      {
        at: now,
        threadId: thread.id,
        projectId,
        from: fromName,
        to: decision.account,
        reason,
      },
      // The thread's next turn runs on the new account: its failure is
      // that account's, not a leftover of the old one.
      thread.id,
    );
  }

  bb.events.on("thread.idle", async ({ thread }) => {
    if (
      !current.autoSwitch ||
      !(current.switchAheadPercent > 0) ||
      thread.providerId !== CLAUDE_CODE_PROVIDER ||
      notTheUsersThread(thread) !== null
    )
      return;
    // Emptied by a change of the accounts directory, until the next look.
    if (accounts.length === 0) await discover();
    await measureForAhead(thread.projectId);
    await inProjectQueue(thread.projectId, () => moveAhead(thread));
  });

  /**
   * The account each thread's turn started on (read when it turned active):
   * a turn that started before its project moved runs on the old account,
   * and its failure, however long after the move, is not the new account's.
   */
  const startedOn = new Map<string, string>();
  bb.events.on("thread.active", async ({ thread }) => {
    if (
      thread.providerId !== CLAUDE_CODE_PROVIDER ||
      notTheUsersThread(thread) !== null
    )
      return;
    try {
      const at = await projectAccount(thread.projectId);
      if (at.external) startedOn.delete(thread.id);
      else startedOn.set(thread.id, at.account ?? current.defaultAccountName);
    } catch {
      startedOn.delete(thread.id);
    }
  });
  bb.events.on("thread.archived", ({ thread }) => {
    startedOn.delete(thread.id);
    threadModel.delete(thread.id);
  });

  bb.events.on("thread.created", async ({ thread }) => {
    const skipped =
      notTheUsersThread(thread) ??
      (thread.providerId === CLAUDE_CODE_PROVIDER
        ? null
        : `provider ${thread.providerId}`);
    if (skipped !== null) {
      bb.log.debug(`thread ${thread.id}: not placed (${skipped})`);
      return;
    }
    if (!current.autoSwitch) {
      // Created while the user manages accounts by hand: not new later on.
      await markHandled(thread.projectId);
      return;
    }
    await inProjectQueue(thread.projectId, () => placeProject(thread));
  });

  // ---- The model of each turn, at bb's dispatch checkpoint ----------------
  /**
   * The model each thread's latest message was sent with, as the usage API
   * names it. bb says it only at the checkpoint (a thread row and a failed
   * turn carry none): a failure of the thread is judged against it, and
   * against the preferred model when the thread has not been seen here.
   */
  const threadModel = new Map<string, string>();
  /** A thread in one of these has a turn under way: a message sent then waits in bb's queue. */
  const TURN_UNDER_WAY: ReadonlySet<string> = new Set([
    "starting",
    "active",
    "stopping",
  ]);
  /**
   * Before a turn starts: when the project's account is MEASURED unable to
   * run the model the turn is sent with and another account can, the project
   * moves there first. The preferred model does not decide here: a thread
   * the user switched to Opus runs on an account with Opus left even when
   * every account is out of the preferred one. `turn.abandoned` is set when
   * the checkpoint stopped waiting: nothing is moved after that.
   */
  async function placeTurn(
    thread: ThreadResponse,
    model: string,
    turn: { abandoned: boolean },
  ) {
    const projectId = thread.projectId;
    // Emptied by a change of the accounts directory, until the next look.
    if (accounts.length === 0) await discover();
    const from = await projectAccount(projectId);
    if (from.external) return;
    const fromName = from.account ?? current.defaultAccountName;
    const now = deps.now();
    const decision = decidePlacement({
      currentAccount: fromName,
      isNew: false,
      accounts: measuredAccounts(model),
      preferredModel: model,
      now,
    });
    if (decision.kind === "keep" || turn.abandoned) return;
    await applyAccount(projectId, accountOrDefault(decision.account), from);
    await markHandled(projectId);
    const reason = `Moved to account ${decision.account} before the turn: ${fromName} cannot run ${model}`;
    bb.log.info(`thread ${thread.id}: ${reason}`);
    await recordMove(
      {
        at: now,
        threadId: thread.id,
        projectId,
        from: fromName,
        to: decision.account,
        reason,
      },
      // Its turn has not started: it runs on the new account.
      thread.id,
    );
  }

  // bb holds every message it asks about on this answer and fails the
  // attempt when a handler throws or takes 10 s: it always proceeds, decides
  // on the measurements already there, and stays out of the project's queue
  // (a retry sent from that queue passes through here). A placement that
  // has not finished after DISPATCH_LIMIT_MS is given up.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const { thread } = ctx;
    const model = modelFamily(ctx.requestedExecution.model);
    if (
      model === null ||
      // Queued behind a turn: bb asks again when it sends the message.
      TURN_UNDER_WAY.has(thread.status) ||
      thread.providerId !== CLAUDE_CODE_PROVIDER ||
      notTheUsersThread(thread) !== null
    )
      return { action: "proceed" };
    threadModel.set(thread.id, model);
    if (current.autoSwitch && ctx.attempt === "start-turn") {
      const turn = { abandoned: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          placeTurn(thread, model, turn),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              turn.abandoned = true;
              resolve();
            }, DISPATCH_LIMIT_MS);
          }),
        ]);
      } catch (error) {
        bb.log.warn(
          `thread ${thread.id}: not placed before its turn: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    return { action: "proceed" };
  });

  // ---- Automatic switch on subscription limit ---------------------------
  async function handleFailure(
    event: PluginTurnFailedEvent,
    projectId: string,
  ): Promise<void> {
    const now = deps.now();
    const recent = recentSwitches.get(projectId);
    const started = startedOn.get(event.threadId);
    startedOn.delete(event.threadId);
    if (
      recent !== undefined &&
      now - recent.at <= SWITCH_GRACE_MS &&
      recent.threadId !== event.threadId &&
      !recent.graced.has(event.threadId) &&
      // Measured since as unable to run a turn (a wait keeps its grace:
      // the account is out by definition until its reset): judged below.
      (recent.sendAt !== undefined || !cannotRun(recent.to))
    ) {
      // Another thread of the project, still running on the old account
      // (whatever its attempt: a leftover can be a retry too): the project
      // has already moved, so its turn only needs to run again, or to wait
      // for the same reset. Once per thread: a second failure in the window
      // means the new account fails as well, and is judged below.
      recent.graced.add(event.threadId);
      const reason = `Retrying on account ${recent.to}`;
      bb.log.info(
        `thread ${event.threadId}: ${reason} (switched ${now - recent.at} ms ago)`,
      );
      await retryTurn(event, reason, recent.sendAt);
      return;
    }
    if (started !== undefined) {
      const at = await projectAccount(projectId);
      const currentName = at.account ?? current.defaultAccountName;
      if (!at.external && started !== currentName && !cannotRun(currentName)) {
        // Started on the old account before the project moved: a leftover
        // (a long tool call can outlast the grace window), not a failure of
        // the project's account. It runs again there, or waits for the same
        // reset when the project's latest move was a wait on that account.
        // Unless the project's account cannot run it either (a hand pick of
        // an account without a login, or out): then it is judged below.
        const sendAt =
          recent !== undefined &&
          recent.to === currentName &&
          recent.sendAt !== undefined &&
          recent.sendAt > now
            ? recent.sendAt
            : undefined;
        const reason = `Retrying on account ${currentName}`;
        bb.log.info(
          `thread ${event.threadId}: ${reason} (its turn started on ${started})`,
        );
        await retryTurn(event, reason, sendAt);
        return;
      }
    }
    await refreshAll();
    const from = await projectAccount(projectId);
    if (from.external) {
      bb.log.info(
        `thread ${event.threadId}: no switch (${ENV_VAR} on project ${projectId} was set outside this plugin)`,
      );
      return;
    }
    const fromName = from.account ?? current.defaultAccountName;
    const refusal = isRefusal(event);
    if (refusal) {
      refusedAt.set(fromName, now);
      bb.log.warn(
        `account ${fromName} refused a turn (HTTP ${event.errorInfo?.httpStatusCode ?? "?"}): chosen for nothing for ${REFUSAL_MS / 3_600_000} h`,
      );
    }
    const model = threadModel.get(event.threadId) ?? current.preferredModel;
    const decision = decideSwitch({
      failure: event,
      currentAccount: fromName,
      accounts: measuredAccounts(model),
      preferredModel: model,
      maximumWaitMs:
        current.maximumWaitHours > 0
          ? current.maximumWaitHours * 3_600_000
          : null,
      now,
      random: deps.random(),
    });
    if (decision.kind === "decline") {
      // The account the project sits on is no good either: a leftover
      // thread must be judged too, not retried there at once.
      recentSwitches.delete(projectId);
      bb.log.info(`thread ${event.threadId}: no switch (${decision.reason})`);
      return;
    }
    const reason =
      decision.kind === "switch"
        ? `Switched to account ${decision.account}${decision.model === null ? "" : ` (${decision.model})`}${refusal ? `: ${fromName} refused the turn` : ""}`
        : decision.reason;
    const sendAt = decision.kind === "wait" ? decision.sendAt : undefined;
    if (decision.account !== fromName) {
      await applyAccount(projectId, accountOrDefault(decision.account), from);
      await recordMove(
        {
          at: now,
          threadId: event.threadId,
          projectId,
          from: fromName,
          to: decision.account,
          reason,
        },
        event.threadId,
        sendAt,
      );
    } else {
      // A wait on this same account is still the project's latest move: a
      // leftover thread follows it (waits for the same reset) instead of
      // being retried at once on an account just found blocked.
      recentSwitches.set(projectId, {
        at: now,
        to: decision.account,
        threadId: event.threadId,
        sendAt,
        graced: new Set(),
      });
    }
    if (decision.kind === "wait") {
      bb.log.info(
        `thread ${event.threadId}: ${reason} until ${new Date(decision.sendAt).toISOString()}`,
      );
      await retryTurn(event, reason, decision.sendAt);
      return;
    }
    bb.log.info(`thread ${event.threadId}: ${reason}`);
    await retryTurn(event, reason);
  }

  bb.events.on("turn.failed", async (event) => {
    if (!current.autoSwitch) return;
    // Pure guards first: another provider's limit must not query every account.
    const declined = declineReason(event);
    if (declined !== null) {
      bb.log.debug(`thread ${event.threadId}: ignored (${declined})`);
      return;
    }
    const thread = await bb.sdk.threads.get({ threadId: event.threadId });
    const skipped =
      notTheUsersThread(thread) ??
      // A limit names its provider; a refusal only has the thread's.
      (isRefusal(event) && thread.providerId !== CLAUDE_CODE_PROVIDER
        ? `refusal of provider ${thread.providerId}`
        : null);
    if (skipped !== null) {
      bb.log.debug(`thread ${event.threadId}: ignored (${skipped})`);
      return;
    }
    await inProjectQueue(thread.projectId, () =>
      handleFailure(event, thread.projectId),
    );
  });

  // A login must not outlive the plugin that runs it (reload, disable, shutdown).
  bb.onDispose(() => login.cancel());

  // ---- Periodic refresh -------------------------------------------------
  bb.background.service("usage-refresh", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await refreshAll();
        } catch (error) {
          bb.log.warn(
            `usage refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await sleep(Math.max(1, current.refreshMinutes) * 60_000, signal);
      }
    },
  });

  // ---- CLI --------------------------------------------------------------
  const JSON_OPTION = {
    type: "boolean",
    description: "Emit machine-readable JSON",
  } as const;
  function textState(s: State): string {
    const pct = (n: number) => `${Math.round(n)}%`;
    const lines = s.accounts.map((a) => {
      if (a.usage === null)
        return `${a.name}\t${a.problem?.kind ?? "not observed"}`;
      const models = Object.entries(a.usage.models)
        .map(([m, w]) => `${m} ${pct(w.usedPercent)}`)
        .join(" ");
      // The pace of each window that has one: "weekly runs out in 2 d 5 h …".
      const paces = Object.entries(s.forecasts[a.name] ?? {}).flatMap(
        ([window, forecast]) => {
          const line = forecastLine(forecast, deps.now());
          return line === null ? [] : [`\t${window} ${line}`];
        },
      );
      return `${a.name}\tsession ${pct(a.usage.session.usedPercent)}\tweekly ${pct(a.usage.weekly.usedPercent)}\t${models}${a.usage.blocked ? "\tLOCKED" : ""}${paces.join("")}`;
    });
    const projects = s.projects.map(
      (p) =>
        `${p.name}\t${p.external ? "(external CLAUDE_CONFIG_DIR)" : (p.account ?? `(${s.defaultAccountName})`)}`,
    );
    return [...lines, "", "projects:", ...projects].join("\n") + "\n";
  }
  bb.cli.register(
    defineCli({
      name: "claude-switcher",
      summary:
        "Claude Code accounts: usage windows and which account each project uses",
      commands: {
        list: cliCommand({
          summary: "Show every account's windows and each project's account",
          options: { json: JSON_OPTION },
          async run({ options }) {
            const s = await state();
            return {
              exitCode: 0,
              stdout: options.json
                ? `${JSON.stringify(s, null, 2)}\n`
                : textState(s),
            };
          },
        }),
        refresh: cliCommand({
          summary: "Query the usage of every account now",
          options: { json: JSON_OPTION },
          async run({ options }) {
            await refreshAll();
            const s = await state();
            return {
              exitCode: 0,
              stdout: options.json
                ? `${JSON.stringify(s, null, 2)}\n`
                : textState(s),
            };
          },
        }),
        history: cliCommand({
          summary:
            "Show every move of a project to another account, latest first, and why",
          options: { json: JSON_OPTION },
          async run({ options }) {
            const s = await state();
            if (options.json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify(s.history, null, 2)}\n`,
              };
            }
            const lines = s.history.map(
              (r) =>
                `${new Date(r.at).toISOString()}\t${projectName(s.projects, r.projectId)}\t${r.from} → ${r.to}\t${r.reason}`,
            );
            return {
              exitCode: 0,
              stdout:
                (lines.length === 0 ? "no moves yet" : lines.join("\n")) + "\n",
            };
          },
        }),
        use: cliCommand({
          summary: "Pin a project to an account (or `default` to unpin)",
          positionals: [
            {
              name: "project",
              description:
                "Project id, or its name when only one project has it",
              required: true,
            },
            {
              name: "account",
              description: "Account name, or `default`",
              required: true,
            },
          ] as const,
          async run({ positionals }) {
            await discover();
            const s = await state();
            const matches = s.projects.filter(
              (p) =>
                p.id === positionals.project || p.name === positionals.project,
            );
            if (matches.length === 0) {
              throw new PluginCliError(
                `Unknown project "${positionals.project}".`,
                { code: "unknown_project" },
              );
            }
            if (matches.length > 1) {
              throw new PluginCliError(
                `"${positionals.project}" names ${matches.length} projects; use an id: ${matches.map((p) => p.id).join(", ")}`,
                { code: "ambiguous_project" },
              );
            }
            const project = matches[0]!;
            const name = positionals.account;
            await pickAccount(project.id, () => accountOrDefault(name));
            return { exitCode: 0, stdout: `${project.name} → ${name}\n` };
          },
        }),
        release: cliCommand({
          summary:
            "Remove every CLAUDE_CONFIG_DIR this plugin set (run before uninstalling)",
          async run() {
            const s = await state();
            const lines: string[] = [];
            let failed = 0;
            for (const p of s.projects) {
              if (p.external) {
                lines.push(
                  `${p.name}\tleft alone (external CLAUDE_CONFIG_DIR)`,
                );
              } else if (p.owned) {
                try {
                  await inProjectQueue(p.id, async () => {
                    await applyAccount(p.id, null, await projectAccount(p.id));
                    recentSwitches.delete(p.id);
                  });
                  lines.push(
                    `${p.name}\treleased (was ${p.account ?? "a vanished account"})`,
                  );
                } catch (error) {
                  failed += 1;
                  lines.push(
                    `${p.name}\tNOT released: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
            }
            return {
              exitCode: failed === 0 ? 0 : 1,
              stdout:
                (lines.length === 0 ? "nothing to release" : lines.join("\n")) +
                "\n",
            };
          },
        }),
      },
    }),
  );

  bb.log.info("loaded");
}

export default function plugin(bb: BbPluginApi) {
  return createPlugin(bb, {
    credentialIo: nodeCredentialIo(),
    accountsIo: nodeAccountsIo(),
    loginIo: nodeLoginIo(),
    loginHelper: loginHelperPath(import.meta.url),
    env: process.env,
    now: Date.now,
    random: Math.random,
  });
}
