// Claude Switcher — bb plugin backend.
//
// Four jobs:
//   1. Measure every Claude Code account on this machine (one config dir
//      each) and publish the windows to bb's Provider usage panel.
//   2. When a thread is created, put a new project on the best account, and
//      move a known one off an account already measured unable to run, so
//      the first turn does not fail.
//   3. When a turn fails on a subscription limit, move the thread's project to
//      another account (CLAUDE_CONFIG_DIR as a project machine env var) and
//      retry the turn; when no account is free, retry at the earliest reset.
//   4. Let the user pin a project to an account from Settings or the CLI.
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
  type Account,
  type AccountsIo,
} from "./src/accounts.js";
import { UsageCollector } from "./src/collector.js";
import type { CredentialIo } from "./src/credentials.js";
import { nodeAccountsIo, nodeCredentialIo } from "./src/node-io.js";
import {
  CLAUDE_CODE_PROVIDER,
  declineReason,
  bestAccount,
  decidePlacement,
  decideSwitch,
} from "./src/switch.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageSourceRpcContract,
} from "./src/usage-source-contract.js";
import { toMeasurement, toResource } from "./src/usage-source.js";

export const ENV_VAR = "CLAUDE_CONFIG_DIR";
/** Realtime channel app.tsx listens on after any state change. */
export const CHANGED = "accounts-changed";
/**
 * After a switch, turns that were already running on the old account keep
 * failing on it for a while. A failure of another turn of the same project
 * inside this window is one of those: retried as is, no second switch.
 */
export const SWITCH_GRACE_MS = 60_000;
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
const switchRecordSchema = z.object({
  at: z.number(),
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
});

export interface PluginDeps {
  credentialIo: CredentialIo;
  accountsIo: AccountsIo;
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
  function measuredAccounts() {
    const maxAgeMs = 2 * Math.max(1, current.refreshMinutes) * 60_000;
    return collector.usable(maxAgeMs, current.preferredModel);
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
      // In the project's queue: never interleaved with a failure or a placement.
      await inProjectQueue(projectId, async () => {
        // Always: an account directory added since the last discovery is pickable.
        await discover();
        const from = await projectAccount(projectId);
        const to = account === null ? null : findAccount(account);
        await applyAccount(projectId, to, from);
        await markHandled(projectId);
        const fromName = from.account ?? current.defaultAccountName;
        const toName = to?.name ?? current.defaultAccountName;
        if (toName === fromName) return;
        // A turn already running on the old account fails there after the
        // pick: like after a switch, it runs again once on the picked account,
        // when that account is measured able to run. Otherwise it is judged.
        const pickRuns =
          bestAccount(
            measuredAccounts().filter((a) => a.name === toName),
            current.preferredModel,
            deps.now(),
          ) === toName;
        if (pickRuns)
          recentSwitches.set(projectId, {
            at: deps.now(),
            to: toName,
            threadId: null,
            sendAt: undefined,
            graced: new Set(),
          });
        else recentSwitches.delete(projectId);
      });
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
        bb.log.info(`thread ${threadId}: the queued retry is already on its way`);
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
  }

  /** Same variable state: nobody moved the project while we were deciding. */
  function sameAccount(a: ProjectAccount, b: ProjectAccount): boolean {
    return (
      a.account === b.account && a.owned === b.owned && a.external === b.external
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
    if (
      measured.length === 0 ||
      (isNew && measured.length < accounts.length)
    ) {
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

  // ---- Automatic switch on subscription limit ---------------------------
  async function handleFailure(
    event: PluginTurnFailedEvent,
    projectId: string,
  ): Promise<void> {
    const now = deps.now();
    const recent = recentSwitches.get(projectId);
    if (
      recent !== undefined &&
      now - recent.at <= SWITCH_GRACE_MS &&
      recent.threadId !== event.threadId &&
      !recent.graced.has(event.threadId)
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
    await refreshAll();
    const from = await projectAccount(projectId);
    if (from.external) {
      bb.log.info(
        `thread ${event.threadId}: no switch (${ENV_VAR} on project ${projectId} was set outside this plugin)`,
      );
      return;
    }
    const fromName = from.account ?? current.defaultAccountName;
    const decision = decideSwitch({
      failure: event,
      currentAccount: fromName,
      accounts: collector.usable(
        2 * Math.max(1, current.refreshMinutes) * 60_000,
        current.preferredModel,
      ),
      preferredModel: current.preferredModel,
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
        ? `Switched to account ${decision.account}${decision.model === null ? "" : ` (${decision.model})`}`
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
    const skipped = notTheUsersThread(thread);
    if (skipped !== null) {
      bb.log.debug(`thread ${event.threadId}: ignored (${skipped})`);
      return;
    }
    await inProjectQueue(thread.projectId, () =>
      handleFailure(event, thread.projectId),
    );
  });

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
      return `${a.name}\tsession ${pct(a.usage.session.usedPercent)}\tweekly ${pct(a.usage.weekly.usedPercent)}\t${models}${a.usage.blocked ? "\tLOCKED" : ""}`;
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
            await applyAccount(
              project.id,
              accountOrDefault(name),
              await projectAccount(project.id),
            );
            await markHandled(project.id);
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
                lines.push(`${p.name}\tleft alone (external CLAUDE_CONFIG_DIR)`);
              } else if (p.owned) {
                try {
                  await applyAccount(p.id, null, await projectAccount(p.id));
                  lines.push(`${p.name}\treleased (was ${p.account ?? "a vanished account"})`);
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
    now: Date.now,
    random: Math.random,
  });
}
