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
/** How long a list keeps the projects' accounts it read (see sharedProjects). */
export const PROJECTS_FRESH_MS = 30_000;
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
/** Retries cancelled by hand, per thread: the chain (first request) they were of. */
const KV_CANCELLED = "cancelled-retries";
/** Usage samples per account and window, for the forecast. */
const KV_SERIES = "usage-series";
const HISTORY_LIMIT = 100;
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
function notTheUsersThread(
  thread: Pick<ThreadResponse, "visibility" | "originPluginId">,
): string | null {
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
  /** `project`: a view's project, read fresh when the shared read lacks it. */
  accounts_list: {
    input: z.object({ project: z.string() }).nullable(),
    output: stateSchema,
  },
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
  /** The views' latest read of every project's account (see sharedProjects). */
  let projectsRead: {
    at: number;
    value: Promise<State["projects"]>;
    /** The project a view needed when this read was made for it. */
    need?: string;
  } | null = null;
  /** When each account last refused a turn (in memory: a reload forgets it). */
  const refusedAt = new Map<string, number>();
  function refusing(name: string): boolean {
    const at = refusedAt.get(name);
    return at !== undefined && deps.now() - at < REFUSAL_MS;
  }
  /** Why a project moves off `name` before a turn, for the history. */
  function whyOut(name: string, model: string): string {
    if (refusing(name)) return "refused a turn";
    return model === "" ? "is out of usage" : `cannot run ${model}`;
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
  /**
   * When each project last changed account for real, through applyAccount
   * (recentSwitches also holds a wait on the same account): a wait queued
   * before it waited on the account the project was on before.
   */
  const accountChangedAt = new Map<string, number>();
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
  const cancelled = new Map<string, string>();
  const ownDeletes = new Set<string>();
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
    const rawCancelled = await bb.storage.kv.get<unknown>(KV_CANCELLED);
    const byHand = z.record(z.string(), z.string()).safeParse(rawCancelled);
    if (byHand.success)
      for (const [threadId, chain] of Object.entries(byHand.data))
        cancelled.set(threadId, chain);
    else if (rawCancelled !== undefined && rawCancelled !== null)
      bb.log.warn(
        "the list of retries cancelled by hand is unreadable; starting it again",
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
    // Which account a project's note names depends on the accounts found.
    projectsRead = null;
    return accounts;
  }

  async function refreshAll(): Promise<void> {
    const found = await discover();
    await collector.collectAll(found);
    await recordSamples();
    bb.realtime.publish(CHANGED, { at: deps.now() });
  }

  // ponytail: bb has no batch read of machine environments, so a list costs
  // one call per project, seconds each when bb is busy, and every open view
  // refetches on the same event. The views' lists share one read, kept
  // PROJECTS_FRESH_MS; a change made here drops it, one made in bb's own
  // settings shows within that time. Everything else reads fresh, and
  // decisions read projectAccount directly. A view that needs a project the
  // shared read lacks (made a moment ago, picked in the new-thread composer)
  // gets a fresh read, which the next lists share.
  function sharedProjects(need?: string): Promise<State["projects"]> {
    const kept = projectsRead;
    if (kept === null || deps.now() - kept.at >= PROJECTS_FRESH_MS)
      return readProjects();
    // Already read again for this project (one bb does not list): no more.
    if (need === undefined || kept.need === need) return kept.value;
    return kept.value.then((projects) => {
      if (projects.some((p) => p.id === need)) return projects;
      // Another view already read again for the same reason: share it.
      if (projectsRead !== null && projectsRead !== kept)
        return projectsRead.value;
      return readProjects(need);
    });
  }

  /** A fresh read, which the views' next lists share; `need`, see sharedProjects. */
  function readProjects(need?: string): Promise<State["projects"]> {
    const now = deps.now();
    const value = (async () => {
      // The personal project too: a variable set there must be visible and releasable.
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return Promise.all(
        projects.map(async (p) => ({
          id: p.id,
          name: p.name,
          ...(await projectAccount(p.id)),
        })),
      );
    })();
    const read = { at: now, value, need };
    projectsRead = read;
    // A failed read is not kept; its callers still see the failure.
    value.catch(() => {
      if (projectsRead === read) projectsRead = null;
    });
    return value;
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
    try {
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
    } finally {
      // Also after a failure: a delete may have landed before it.
      projectsRead = null;
    }
    const toName = account === null ? current.defaultAccountName : account.name;
    if (toName !== (from.account ?? current.defaultAccountName))
      accountChangedAt.set(projectId, deps.now());
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

  /**
   * `shared`: the views' list, which may reuse a recent read (see
   * sharedProjects); `need`, a project that list must have.
   */
  async function state({
    shared = false,
    need,
  }: { shared?: boolean; need?: string } = {}): Promise<State> {
    if (accounts.length === 0) await discover();
    const projects = await (shared ? sharedProjects(need) : readProjects());
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
      projects,
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
    // applyAccount announces the change before the pick has written all it
    // writes (its history row, a new measure): the views read again once the
    // pick is over, or a read they made in between can stand. Not for a pick
    // that applied nothing (refused, or failed before): that read would clear
    // the error Settings shows for it.
    let applied = false;
    try {
      await inProjectQueue(projectId, async () => {
        await discover();
        const from = await projectAccount(projectId);
        const to = choose(findAccount);
        await applyAccount(projectId, to, from);
        applied = true;
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
    } finally {
      if (applied) bb.realtime.publish(CHANGED, { at: deps.now() });
    }
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
    accounts_list: (input) => state({ shared: true, need: input?.project }),
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

  /** bb's refusal to retry a turn that is no longer the thread's latest. */
  function superseded(error: unknown): boolean {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? error.status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return status === 409 && /is not the failed turn/i.test(message);
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
    stuck = false,
  ): Promise<void> {
    const threadId = event.threadId;
    const existing = await queuedRetry(event);
    if (existing !== null) {
      bb.log.info(
        `thread ${threadId}: a retry of the turn is already queued ("${existing.reason}"${existing.sendAt === null ? "" : `, for ${new Date(existing.sendAt).toISOString()}`})`,
      );
      // On a rescue it is left to whoever queued it: another plugin may be
      // holding it, and an explicit send would skip that hold (Codex r6,
      // IR6-002).
      if (stuck) return;
      if (sendAt === undefined) {
        await sendQueued(threadId, existing.id);
        return;
      }
      ownDeletes.add(existing.id);
      try {
        await bb.sdk.threads.queuedMessages.delete({
          threadId,
          queuedMessageId: existing.id,
        });
      } catch (error) {
        ownDeletes.delete(existing.id);
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
        if (stuck) {
          bb.log.info(
            `thread ${threadId}: another retry was queued first; leaving it`,
          );
          return;
        }
        if (sendAt === undefined) {
          await sendQueued(threadId, raced.id);
        } else {
          bb.log.warn(
            `thread ${threadId}: another retry was queued first; leaving it`,
          );
        }
        return;
      }
      // A newer turn replaced the failed one (a message sent meanwhile): it
      // runs on the project's account, and its own failure comes on its own.
      if (superseded(error)) {
        bb.log.info(
          `thread ${threadId}: turn ${event.requestId} is no longer its latest; the newer turn goes on`,
        );
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
        : `Moved to account ${decision.account} before the turn: ${fromName} ${whyOut(fromName, current.preferredModel)}`;
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
  bb.events.on("thread.archived", async ({ thread }) => {
    startedOn.delete(thread.id);
    threadModel.delete(thread.id);
    // Forgotten in storage too, or the stored list only grows (Codex r8,
    // IR8-004).
    if (cancelled.delete(thread.id)) await storeCancelled(thread.id);
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
  /**
   * The model of the thread's latest message in bb's log, for a thread whose
   * sending this plugin did not see (it was reloaded or restarted since: a
   * long turn outlives both). Null when the log cannot be read or names no
   * Claude model: the preferred model decides then.
   */
  async function loggedModel(threadId: string): Promise<string | null> {
    try {
      const [row] = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      return row?.type === "client/turn/requested"
        ? modelFamily(row.data.execution?.model ?? null)
        : null;
    } catch (error) {
      bb.log.warn(
        `thread ${threadId}: its model not read from bb: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
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
    const reason = `Moved to account ${decision.account} before the turn: ${fromName} ${whyOut(fromName, model)}`;
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
    const model =
      threadModel.get(event.threadId) ??
      (await loggedModel(event.threadId)) ??
      current.preferredModel;
    await judge(event, projectId, from, model, now, false);
  }

  /**
   * Retries the user cancelled by hand (from bb's queued card or `bb thread
   * queue`), per thread: the chain they were of. bb's only word of that
   * removal is `message.cancelled`, which this plugin's own deletions fire
   * too (`ownDeletes` tells them apart). The rescue leaves such a thread
   * alone until a new turn of it (Codex r7, IR7-004). Kept in storage: a
   * restart must not turn a cancellation into an abandoned thread.
   */
  bb.events.on("message.cancelled", async ({ entry }) => {
    if (ownDeletes.delete(entry.id)) return;
    if (entry.payload.kind !== "retry") return;
    cancelled.set(entry.threadId, entry.payload.retryOfTurnRequestId);
    bb.log.info(
      `thread ${entry.threadId}: its queued retry was cancelled by hand; not judged again until a new turn of it`,
    );
    await storeCancelled(entry.threadId);
  });

  /** The cancellations by hand, to storage; a failure is logged, not thrown. */
  async function storeCancelled(threadId: string): Promise<void> {
    try {
      await bb.storage.kv.set(KV_CANCELLED, Object.fromEntries(cancelled));
    } catch (error) {
      bb.log.warn(
        `thread ${threadId}: the cancellations by hand could not be stored (a restart would read the list as it was): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Where the failed turn runs again: the project moves there and the retry
   * is queued. `stuck`: judged on a refresh for a thread left in error (see
   * `rescueStuck`), not on its failure.
   */
  async function judge(
    event: PluginTurnFailedEvent,
    projectId: string,
    from: ProjectAccount,
    model: string,
    now: number,
    stuck: boolean,
  ): Promise<void> {
    const fromName = from.account ?? current.defaultAccountName;
    const refusal = isRefusal(event);
    if (refusal && !stuck) {
      refusedAt.set(fromName, now);
      bb.log.warn(
        `account ${fromName} refused a turn (HTTP ${event.errorInfo?.httpStatusCode ?? "?"}): chosen for nothing for ${REFUSAL_MS / 3_600_000} h`,
      );
    } else if (refusal) {
      // Found in the log on a rescue: bb masks the account in its log and
      // this plugin's history of moves cannot date a turn against a move
      // (Codex r8, IR8-001, IR8-005), so no account is marked for it. The
      // thread is judged on the measurements; if the account refuses again,
      // that failure marks it, and so two accounts without a login are
      // marked one after the other, not bounced between.
      bb.log.info(
        `thread ${event.threadId}: left in error by a refusal; no account marked for it (the one that refuses again marks itself)`,
      );
    }
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
      stuck,
    });
    const how = stuck ? "left in error: " : "";
    if (decision.kind === "decline") {
      // The account the project sits on is no good either: a leftover
      // thread must be judged too, not retried there at once.
      recentSwitches.delete(projectId);
      bb.log.info(
        `thread ${event.threadId}: ${how}no switch (${decision.reason})`,
      );
      return;
    }
    const reason =
      decision.kind === "switch"
        ? `Switched to account ${decision.account}${decision.model === null ? "" : ` (${decision.model})`}${refusal ? `: ${fromName} refused the turn` : ""}`
        : decision.kind === "retry"
          ? `Retrying on account ${decision.account}${decision.model === null ? "" : ` (${decision.model})`}: it has room now`
          : decision.reason;
    const sendAt = decision.kind === "wait" ? decision.sendAt : undefined;
    // A rescue runs between reads: switched off meanwhile, it stops before
    // moving and before retrying (Codex r6, IR6-006).
    if (stuck && !current.autoSwitch) return;
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
    } else if (decision.kind !== "retry") {
      // A wait on this same account is still the project's latest move: a
      // leftover thread follows it (waits for the same reset) instead of
      // being retried at once on an account just found blocked. A retry on
      // the project's own account is no move at all: the latest move stands,
      // with its cause, time and graced threads (Codex r7, IR7-002).
      recentSwitches.set(projectId, {
        at: now,
        to: decision.account,
        threadId: event.threadId,
        sendAt,
        graced: new Set(),
      });
    } else {
      // Retried on the project's own account: it runs there from here, so
      // a failure of it within the grace of the project's latest move is
      // that account's, judged afresh, not retried at once as a leftover
      // of the account its turn started on (Codex r8, IR8-003).
      recentSwitches.get(projectId)?.graced.add(event.threadId);
      startedOn.delete(event.threadId);
    }
    if (stuck && !current.autoSwitch) return;
    if (decision.kind === "wait") {
      bb.log.info(
        `thread ${event.threadId}: ${how}${reason} until ${new Date(decision.sendAt).toISOString()}`,
      );
      await retryTurn(event, reason, decision.sendAt, stuck);
      return;
    }
    bb.log.info(`thread ${event.threadId}: ${how}${reason}`);
    await retryTurn(event, reason, undefined, stuck);
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
    try {
      await inProjectQueue(thread.projectId, () =>
        handleFailure(event, thread.projectId),
      );
    } catch (error) {
      // A retry of the turn is already on its way (queued by another plugin,
      // or being sent): nothing to add.
      if (!bbHasTheTurn(error)) throw error;
      bb.log.info(
        `thread ${event.threadId}: bb already has a retry of the turn (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  });

  // ---- A wait another account can end sooner -----------------------------
  /**
   * Waits due within this are left alone: they run soon anyway, and every
   * backoff bb's provider-retry plugin queues for an overloaded provider is
   * shorter (5 s × 2^(n − 1) plus up to as much jitter: 80 s at its 4th and
   * last), so no backoff is cut short.
   */
  const SHORT_WAIT_MS = 2 * 60_000;
  /**
   * Waits queued back after bb did not take their retry, by retryKey (their
   * id never comes back when bb's answer is lost): newer than the move that
   * released them, they still waited on the old account.
   */
  const putBack = new Set<string>();
  /** A queued retry's turn: bb keeps one queued retry per thread, chain and attempt. */
  function retryKey(threadId: string, of: string, attempt: number): string {
    return JSON.stringify([threadId, of, attempt]);
  }

  /**
   * A timed retry waits for the reset of the account its project was on when
   * the turn failed; an account that could not be measured then may have
   * room now (2026-10-04: a thread waited three hours for a session while
   * another account was free). After each refresh, a project whose account
   * is MEASURED unable to run a waiting retry's model moves to an account
   * that can, and the wait is replaced by a retry bb dispatches at once; so
   * is a wait queued before its project last changed account, on an account
   * that can run it. Left as they are: a wait due within two minutes, one
   * another plugin holds, a retry of an earlier turn, one of an archived
   * thread, and one whose account may still run (it waits for something
   * else, such as a backoff).
   */
  async function revisitWaits(): Promise<void> {
    if (!current.autoSwitch) return;
    const all = await bb.sdk.threads.queue.list();
    for (const key of putBack)
      if (
        !all.some(
          (row) =>
            row.payload.kind === "retry" &&
            retryKey(
              row.threadId,
              row.payload.retryOfTurnRequestId,
              row.payload.attempt,
            ) === key,
        )
      )
        putBack.delete(key);
    const rows = all.filter((row) => longWait(row, deps.now()));
    for (const row of rows) {
      // Switched off meanwhile: the rest of the pass stops too.
      if (!current.autoSwitch) return;
      try {
        const thread = await bb.sdk.threads.get({ threadId: row.threadId });
        if (!waitingThread(thread)) continue;
        await inProjectQueue(thread.projectId, () =>
          moveUpWait(row.threadId, row.id),
        );
      } catch (error) {
        bb.log.warn(
          `thread ${row.threadId}: its wait was not looked at again: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await rescueStuck(all);
  }

  /**
   * Threads in error with nothing queued, as the queue stood when the pass
   * began (a queued message of any kind runs when its time comes and takes
   * the thread out of error): bb's provider-retry gives up after five
   * attempts and so does the failure handler, so nothing would look at them
   * again. Each is judged from bb's log on every refresh, until something is
   * queued for it.
   */
  async function rescueStuck(
    queue: Array<{ threadId: string; payload: { kind: string } }>,
  ): Promise<void> {
    const queuedFor = new Set(queue.map((row) => row.threadId));
    for (const thread of await errorThreads()) {
      if (!current.autoSwitch) return;
      if (queuedFor.has(thread.id)) continue;
      try {
        await inProjectQueue(thread.projectId, () => rescueThread(thread));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (bbHasTheTurn(error))
          bb.log.info(
            `thread ${thread.id}: bb already has a retry of the turn (${message})`,
          );
        else
          bb.log.warn(`thread ${thread.id}: not judged again: ${message}`);
      }
    }
  }

  type ListedThread = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];
  /** The user's Claude Code threads in error, not archived. */
  async function errorThreads(): Promise<ListedThread[]> {
    const PAGE = 200;
    const found: ListedThread[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await bb.sdk.threads.list({
        archived: false,
        limit: PAGE,
        offset,
      });
      found.push(...page.filter(waitingThread));
      if (page.length < PAGE) return found;
    }
  }

  /** The thread's failure as bb logged it, judged as a failure would be. */
  async function rescueThread(thread: ListedThread): Promise<void> {
    const threadId = thread.id;
    // Read again in the project's queue: archived, running again, moved or
    // retried meanwhile (Codex r6, IR6-005).
    if (!current.autoSwitch) return;
    const live = await bb.sdk.threads.get({ threadId });
    if (!waitingThread(live) || live.projectId !== thread.projectId) return;
    if ((await bb.sdk.threads.queuedMessages.list({ threadId })).length > 0)
      return;
    const turn = await latestTurn(threadId);
    if (turn === null) return;
    if (cancelled.get(threadId) === turn.original) {
      bb.log.debug(
        `thread ${threadId}: left in error (its retry was cancelled by hand)`,
      );
      return;
    }
    // The failure of that turn, not an older one's (a turn sent by hand
    // after a limit fails on its own account): bb reads it the same way.
    // A turn bb refused at the door leaves no provider error, only the
    // reason it was rejected for, as bb's own failure event translates it.
    const [failed] = await bb.sdk.threads.events.list({
      threadId,
      types: ["provider/error", "client/turn/rejected"],
      order: "desc",
      limit: "1",
      afterSeq: String(turn.seq),
    });
    const errorInfo =
      failed?.type === "provider/error"
        ? (failed.data.errorInfo ?? null)
        : failed?.type === "client/turn/rejected"
          ? rejectedErrorInfo(failed.data.reason)
          : undefined;
    if (errorInfo === undefined) return;
    const [reported] = await bb.sdk.threads.events.list({
      threadId,
      types: ["provider/rateLimits/updated"],
      order: "desc",
      limit: "1",
    });
    const failure: PluginTurnFailedEvent = {
      threadId,
      requestId: turn.requestId,
      turnId: null,
      errorInfo,
      inputAccepted: failed.type === "provider/error",
      rateLimits:
        reported?.type === "provider/rateLimits/updated"
          ? reported.data.rateLimits
          : null,
      attemptNumber: turn.attempt,
    };
    const declined = declineReason(failure, true);
    if (declined !== null) {
      bb.log.debug(`thread ${threadId}: left in error (${declined})`);
      return;
    }
    const from = await projectAccount(thread.projectId);
    if (from.external) return;
    await judge(
      failure,
      thread.projectId,
      from,
      turn.model ?? current.preferredModel,
      deps.now(),
      true,
    );
  }
  /** What bb's failure event says of a turn rejected at the door (bb 0.45, `doorRejectionErrorInfo`). */
  function rejectedErrorInfo(
    reason: string,
  ): PluginTurnFailedEvent["errorInfo"] {
    switch (reason) {
      case "rate_limited":
        return { category: "rate-limit", providerCode: null, httpStatusCode: null };
      case "auth_required":
        return { category: "unauthorized", providerCode: null, httpStatusCode: null };
      default:
        return null;
    }
  }

  /** A timed retry not due soon, that no other plugin holds. */
  function longWait(
    row: {
      payload: { kind: string };
      sendAt: number | null;
      waitingOn: { kind: string } | null;
    },
    now: number,
  ): boolean {
    return (
      row.payload.kind === "retry" &&
      row.sendAt !== null &&
      row.sendAt - now > SHORT_WAIT_MS &&
      (row.waitingOn === null || row.waitingOn.kind === "time")
    );
  }

  /**
   * The user's Claude Code thread with a failed turn bb can retry: not
   * archived or deleted (bb refuses those, and the wait would be lost).
   */
  function waitingThread(
    thread: Pick<
      ThreadResponse,
      | "providerId"
      | "visibility"
      | "originPluginId"
      | "status"
      | "archivedAt"
      | "deletedAt"
    >,
  ): boolean {
    return (
      thread.providerId === CLAUDE_CODE_PROVIDER &&
      notTheUsersThread(thread) === null &&
      thread.status === "error" &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    );
  }

  /** The thread's latest turn in bb's log: the one bb retries. */
  async function latestTurn(threadId: string) {
    const [row] = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
    });
    if (row?.type !== "client/turn/requested") return null;
    return {
      seq: row.seq,
      requestId: row.data.requestId,
      // bb keys a retry by the first request of its chain, and counts from 1.
      original: row.data.retryOfRequestId ?? row.data.requestId,
      attempt: row.data.retryAttempt ?? 1,
      model: modelFamily(row.data.execution?.model ?? null),
    };
  }

  async function moveUpWait(threadId: string, rowId: string): Promise<void> {
    // Read again in the project's queue: archived, sent, replaced or held
    // meanwhile.
    const thread = await bb.sdk.threads.get({ threadId });
    if (!waitingThread(thread)) return;
    const projectId = thread.projectId;
    const row = (await bb.sdk.threads.queuedMessages.list({ threadId })).find(
      (r) => r.id === rowId,
    );
    if (row?.payload.kind !== "retry" || !longWait(row, deps.now())) return;
    const wait = {
      id: row.id,
      reason: row.payload.reason,
      sendAt: row.sendAt,
      key: retryKey(
        threadId,
        row.payload.retryOfTurnRequestId,
        row.payload.attempt,
      ),
    };
    const turn = await latestTurn(threadId);
    if (
      turn === null ||
      turn.original !== row.payload.retryOfTurnRequestId ||
      turn.attempt + 1 !== row.payload.attempt
    )
      return;
    // The model the retry runs with: bb copies the failed turn's.
    const model =
      modelFamily(row.model) ?? turn.model ?? current.preferredModel;
    // Read last: nothing is awaited between this read and the move below.
    const from = await projectAccount(projectId);
    if (from.external || !current.autoSwitch) return;
    const fromName = from.account ?? current.defaultAccountName;
    const now = deps.now();
    const measured = measuredAccounts(model);
    const here = measured.find((a) => a.name === fromName);
    // Known unable to run anything, measured or not: no login, or a refusal
    // within its veto.
    const noLogin =
      collector.get(fromName)?.problem?.kind === "unauthenticated";
    if (
      !noLogin &&
      !refusing(fromName) &&
      (here === undefined ||
        here.unknown === true ||
        bestAccount([here], model, now) === fromName)
    ) {
      // It waited on the account the project was on before.
      const changed = accountChangedAt.get(projectId);
      if (
        (changed !== undefined && row.createdAt < changed) ||
        putBack.has(wait.key)
      )
        await releaseWait(
          threadId,
          projectId,
          wait,
          turn.requestId,
          `Retrying on account ${fromName}, where the project is now`,
        );
      return;
    }
    const to = bestAccount(
      measured.filter((a) => a.name !== fromName),
      model,
      now,
    );
    if (to === null) return;
    await applyAccount(projectId, accountOrDefault(to), from);
    await markHandled(projectId);
    const reason = `Moved to account ${to}, which can run the waiting turn now: ${fromName} ${noLogin ? "is not logged in" : whyOut(fromName, model)}`;
    bb.log.info(`thread ${threadId}: ${reason}`);
    await recordMove(
      { at: now, threadId, projectId, from: fromName, to, reason },
      threadId,
    );
    if (!current.autoSwitch) return;
    await releaseWait(threadId, projectId, wait, turn.requestId, reason);
  }

  /**
   * Replace a timed retry with one bb dispatches now, through every plugin's
   * checkpoint: sending the queued row would be an explicit send, which
   * skips them. If bb does not take it, the timed one is queued again as it
   * was, unless bb already has a retry of the turn or the turn is no longer
   * the failed one. bb keeps one queued retry per turn: a retry it refuses
   * for that never doubles a wait.
   */
  async function releaseWait(
    threadId: string,
    projectId: string,
    wait: { id: string; reason: string; sendAt: number | null; key: string },
    turnRequestId: string,
    reason: string,
  ): Promise<void> {
    // It runs on the project's account from here: its failure is not a
    // leftover of the account its turn started on.
    startedOn.delete(threadId);
    ownDeletes.add(wait.id);
    try {
      await bb.sdk.threads.queuedMessages.delete({
        threadId,
        queuedMessageId: wait.id,
      });
    } catch (error) {
      ownDeletes.delete(wait.id);
      if (alreadyOnItsWay(error)) {
        bb.log.info(
          `thread ${threadId}: its waiting retry is already on its way`,
        );
        return;
      }
      // bb may have removed it and lost only its answer: without the retry
      // below, the wait would be gone. Still queued, bb refuses the retry.
      bb.log.warn(
        `thread ${threadId}: could not remove its wait (${error instanceof Error ? error.message : String(error)}); retrying the turn anyway`,
      );
    }
    // It runs on the project's account now: a failure of it within the
    // grace window is that account's, judged afresh.
    recentSwitches.get(projectId)?.graced.add(threadId);
    try {
      await bb.sdk.threads.retry({ threadId, turnRequestId, reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (bbHasTheTurn(error)) {
        bb.log.info(
          `thread ${threadId}: bb did not take the retry (${message}); nothing is queued again`,
        );
        return;
      }
      bb.log.warn(
        `thread ${threadId}: could not retry the turn now (${message}); its wait is queued again`,
      );
      try {
        const back = await bb.sdk.threads.retry({
          threadId,
          turnRequestId,
          reason: wait.reason,
          ...(wait.sendAt === null ? {} : { sendAt: wait.sendAt }),
        });
        if (back.delivery === "queued") putBack.add(wait.key);
      } catch (restoreError) {
        const restore =
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError);
        // The first retry landed and only its answer was lost.
        if (bbHasTheTurn(restoreError)) {
          bb.log.info(
            `thread ${threadId}: its wait is not queued again: bb has the turn (${restore})`,
          );
          return;
        }
        // bb may have queued it and lost only its answer: looked at again in
        // the next pass if it is there.
        putBack.add(wait.key);
        const queuedAgain = await bb.sdk.threads.queuedMessages
          .list({ threadId })
          .then(
            (rows) =>
              rows.some(
                (r) =>
                  r.payload.kind === "retry" &&
                  retryKey(
                    threadId,
                    r.payload.retryOfTurnRequestId,
                    r.payload.attempt,
                  ) === wait.key,
              ),
            () => false,
          );
        if (queuedAgain) {
          bb.log.info(
            `thread ${threadId}: its wait is queued again (only bb's answer was lost: ${restore})`,
          );
          return;
        }
        bb.log.error(
          `thread ${threadId}: its wait is lost (${message}; queuing it again failed too: ${restore}); retry the turn by hand`,
        );
      }
    }
  }

  /** bb's 409s on a retry: it already has one of the turn, or the turn is no longer the failed one. */
  function bbHasTheTurn(error: unknown): boolean {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code === "retry_already_queued" || code === "no_failed_turn";
  }

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
        try {
          await revisitWaits();
        } catch (error) {
          bb.log.warn(
            `the waiting turns were not looked at again: ${error instanceof Error ? error.message : String(error)}`,
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
