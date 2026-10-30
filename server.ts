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
  type MessageDispatchHookDecision,
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
import {
  UsageCollector,
  type LoginState,
  type Measurement,
} from "./src/collector.js";
import {
  forecastWindow,
  recordSample,
  type Forecast,
  type Series,
} from "./src/forecast.js";
import type { CredentialIo } from "./src/credentials.js";
import { LoginFlow, type LoginIo, type LoginStatus } from "./src/login.js";
import {
  loginHelperPath,
  nodeAccountsIo,
  nodeCredentialIo,
  nodeLoginIo,
  nodeSessionsIo,
} from "./src/node-io.js";
import {
  ADVISED_DECLINES,
  adviseOpus,
  CLAUDE_CODE_PROVIDER,
  declineReason,
  bestAccount,
  decideAhead,
  decidePlacement,
  decideSwitch,
  FALLBACK_MODEL,
  isRefusal,
  MAX_ATTEMPTS,
  mayAdviseOpus,
  modelFamily,
  fullestWindow,
  opusInstead,
  opusInsteadText,
  RESET_BUFFER_MS,
  RESET_JITTER_MS,
  settle,
  type PlacementInput,
  type SwitchDecision,
} from "./src/switch.js";
import {
  canRunModel,
  isUsable,
  modelWindow,
  reserving,
  spendsReservedWeekly,
} from "./src/policy.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageSourceRpcContract,
} from "./src/usage-source-contract.js";
import { toMeasurement, toResource } from "./src/usage-source.js";
import { shareSessions, type SessionsIo } from "./src/sessions.js";
import { Seats, capacityFor } from "./src/seats.js";
import { listText, projectName, sharedWith } from "./src/ui.js";

export const ENV_VAR = "CLAUDE_CONFIG_DIR";
/** Realtime channel app.tsx listens on after any state change. */
export const CHANGED = "accounts-changed";
/** Realtime channel of the advice a thread shows (see thread_advice); payload `{ threadId }`. */
export const ADVICE_CHANGED = "opus-advice";
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
/**
 * A new project's first message waits this long, once, when its placement
 * has not finished within DISPATCH_LIMIT_MS (the accounts are measured
 * first): bb asks again sooner, as soon as the placement ends (E44).
 */
export const FIRST_PLACEMENT_WAIT_MS = 5_000;
/**
 * A message that would start on a default account without a login waits
 * at most this many times for something that could give its project an
 * account; then it is refused (E44).
 */
export const MAX_START_WAITS = 3;
/**
 * Sharing a moved project's sessions (see shareProjectSessions) is waited
 * for this long at most: it runs in the project's queue and before a turn
 * (Codex E46-001).
 */
export const SESSIONS_LIMIT_MS = 2_000;
/** A login left waiting in the browser this long is given up. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** A thread waiting for a seat is asked about again after this long (sooner when a seat frees). */
export const SEAT_RECHECK_MS = 30_000;
/** A seat reserved for a turn that has not started within this long is freed. */
export const SEAT_TTL_MS = 90_000;
/** Times a message waits because its project's account could not be read for its seat; then it goes (Astra SEATS-R01). */
const SEAT_READ_WAITS = 3;
/** A message sent while the seats are counted after a load is asked about again after this long (Astra SEATS-R02). */
const SEATS_COUNTING_WAIT_MS = 5_000;
/** Tries of each read that counts the seats after a load, this long apart (Astra SEATS-R02). */
const SEAT_COUNT_TRIES = 3;
const SEAT_COUNT_RETRY_MS = 2_000;
/** Changes of the seats within this long are announced once (Astra SEATS-R09). */
const SEATS_CHANGED_MS = 250;
const KV_SEATS = "seat-samples";
/** The seat samples kept: a week of them (see noteSeatSample). */
const SEAT_SAMPLES_MS = 7 * 24 * 60 * 60_000;
/**
 * A seat sample, whole in itself (Astra SEATS-R06): [at, running,
 * reserved, session %, weekly % (null: no weekly window), session reset,
 * weekly reset], `at` the measurement's own time.
 */
const seatSampleSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number().nullable(),
  z.number().nullable(),
  z.number().nullable(),
]);
type SeatSample = z.infer<typeof seatSampleSchema>;
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
/** Retries cancelled by hand, per thread: the thread's latest turn at the time. */
const KV_CANCELLED = "cancelled-retries";
/** Usage samples per account and window, for the forecast. */
const KV_SERIES = "usage-series";
const HISTORY_LIMIT = 100;
/** A thread as bb reports it (the SDK does not export the type by name). */
type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
/** Where a turn runs, as placeTurn leaves it (see there). */
type TurnPlace =
  | {
      account: string;
      byDefault: boolean;
      /** The project's writes (`movesOf().writes`) for which it is there (Astra SEATS-R3-002). */
      writes: number;
    }
  | "external"
  | "unknown";
/**
 * The seat of a project whose variable names an account not among the ones
 * found: nobody's, never the default's (Astra SEATS-R3-001).
 */
const UNKNOWN_SEAT = Symbol("unknown seat");
/** A queued row bb removed, as `message.cancelled` reports it. */
type CancelledEntry = PluginThreadEventPayloads["message.cancelled"]["entry"];
/** When this plugin first ran: a project created later is new. */
const KV_INSTALLED_AT = "installed-at";
/** New projects already placed, kept, or pinned by the user: no longer new. */
const KV_HANDLED_PROJECTS = "handled-projects";
/** What each declined thread's banner is asked on (see adviceBasis), by thread. */
const KV_ADVICE = "advice-bases";
/** A stored basis of a banner (see adviceBasis). */
const storedBasisSchema = z.object({
  projectId: z.string(),
  model: z.string(),
  reason: z.enum(ADVISED_DECLINES),
  requestId: z.string(),
  chain: z.string().nullable(),
  at: z.number(),
});
/**
 * How long a basis read back after a restart is checked against bb (see
 * restoredHolds; code-reviewer r6, CR-L2): one judged longer ago than this
 * is dropped without reading its thread (every window of a limit has reset
 * since), and one whose check could not tell this many refreshes in a row
 * (the thread could not be read, or bb's log does not say how its retry
 * failed) is dropped at the last.
 */
const RESTORED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RESTORED_CHECKS = 5;

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
  /** The provider reported no such window: a Team seat's general weekly. */
  absent: z.literal(true).optional(),
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
  /** Per account: its seats (capacity 0 = no limit), taken and waited for. */
  seats: z
    .record(
      z.string(),
      z.object({
        capacity: z.number(),
        running: z.number(),
        reserved: z.number(),
        queued: z.array(
          z.object({ threadId: z.string(), title: z.string().nullable() }),
        ),
      }),
    )
    .optional(),
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
  account_login_start: {
    input: z.object({ name: z.string().max(255) }),
    output: stateSchema,
  },
  account_login_code: {
    input: z.object({ code: z.string().max(4096) }),
    output: stateSchema,
  },
  /** Stops a running login; when none runs, forgets the last outcome. */
  account_login_cancel: { input: z.null(), output: stateSchema },
  /** The Opus advice the thread shows over its composer; null: none. */
  thread_advice: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ text: z.string().nullable() }),
  },
});

export interface PluginDeps {
  credentialIo: CredentialIo;
  accountsIo: AccountsIo;
  loginIo: LoginIo;
  /**
   * The filesystem a moved project's Claude Code sessions are shared on
   * (see src/sessions.ts); none: they are not.
   */
  sessionsIo?: SessionsIo;
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
        "After each turn of a thread in the preferred model (every thread when none is set), when the project's account is at or above this share of its session, weekly or preferred-model window and another account is below it, the project moves there before a turn fails. Threads sent with another model use the setting below. Needs the automatic choice above. 0 = off (switch only when a turn fails).",
      default: 0,
    },
    switchAheadOtherPercent: {
      type: "number",
      label: "Switch ahead of the limit, threads in another model (%)",
      description:
        "For a thread sent with a model other than the preferred one (e.g. Opus while Fable is preferred): after each turn, when the project's account is at or above this share of its session, weekly or that model's window and another account is below it, the project moves there before a turn fails. Needs the automatic choice above; no effect without a preferred model. 0 = off.",
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
    // ponytail: 4 and 2 are a guess, not measured per thread. Each usage
    // sample carries the seats taken then (KV_SEATS, `bb claude-switcher
    // seats`): with a week of them, the share of a window per hour and per
    // seat sets these defaults.
    seatsMax: {
      type: "number",
      label: "Threads at once per Max account",
      description:
        "A thread whose turn is about to start waits when the project's account already runs this many; it starts as soon as one of them ends, first come first served. A project is never moved to find a seat. 0 = no limit.",
      default: 4,
    },
    seatsTeam: {
      type: "number",
      label: "Threads at once per Team account",
      description:
        "A thread whose turn is about to start waits when the project's account already runs this many; it starts as soon as one of them ends, first come first served. A project is never moved to find a seat. 0 = no limit.",
      default: 2,
    },
    loginPrivateWindow: {
      type: "boolean",
      label:
        "Open logins in a private Chrome window on macOS (so they do not reuse the browser's Claude session)",
      default: true,
    },
  });
  /**
   * Per thread, the Opus advice of its latest judgment when nothing queued
   * carries it (a decline: beyond the maximum wait, or no account will
   * free): the thread shows it in a banner over its composer (D3; Sol
   * B2-004), which schedules nothing and changes no model. Replaced by
   * every judgment of the thread, dropped when a turn of it starts, when it
   * is archived, and when the automatic choice is switched off (the advice
   * names where the placement would send an Opus turn, and none is placed
   * then). Asked again after every usage refresh (see reviseAdvice), also
   * after a restart: what it is asked on is kept in storage (adviceBasis).
   */
  const shownAdvice = new Map<string, string>();
  /**
   * Per thread whose latest judgment declined its turn in a way that can
   * tell it (see mayAdviseOpus), what that judgment judged on: after every
   * usage refresh its banner is asked again (see reviseAdvice). Dropped
   * with the banner's generation (a turn of the thread, its archiving or
   * deletion, the automatic choice switched off) and by any later judgment
   * of the thread that is no such decline. Kept in storage (KV_ADVICE): a
   * restart reads them back, and the first refresh asks each again once bb
   * says its thread still waits on the turn judged (Sol B2-R5-002).
   */
  type AdviceBasis = {
    projectId: string;
    /** The failed turn's model. */
    model: string;
    decision: Extract<SwitchDecision, { kind: "decline" }>;
    /** The failed turn's request. */
    requestId: string;
    /** The first request of its retry chain (see loggedTurn); null: unknown. */
    chain: string | null;
    /**
     * When it was judged; a later judgment of the same decline keeps it
     * (see judgedAdvice). Read back after a restart, it says how long the
     * basis is checked (see RESTORED_MAX_AGE_MS).
     */
    at: number;
    /** Read back from storage, not yet checked against bb (see reviseAdvice). */
    restored?: boolean;
    /** Checks of it read back that could not tell, in a row (see restoredHolds). */
    misses?: number;
    /** The refresh whose pass counted the latest of them (see refreshes). */
    missedIn?: number;
  };
  const adviceBasis = new Map<string, AdviceBasis>();
  /** Writes in order, like the history; awaited by nothing that decides. */
  let basesWrites: Promise<void> = Promise.resolve();
  /** What storage keeps of a basis (see storedBasisSchema). */
  function storedOf(basis: AdviceBasis) {
    return {
      projectId: basis.projectId,
      model: basis.model,
      reason: basis.decision.reason,
      requestId: basis.requestId,
      chain: basis.chain,
      at: basis.at,
    };
  }
  function storeBases(): void {
    const snapshot = Object.fromEntries(
      [...adviceBasis].map(([threadId, basis]) => [threadId, storedOf(basis)]),
    );
    basesWrites = basesWrites.then(async () => {
      try {
        await bb.storage.kv.set(KV_ADVICE, snapshot);
      } catch (error) {
        bb.log.warn(
          `could not store what the banners are asked on (a restart reads them as they were): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  /**
   * Per thread, the generation its judgments belong to: a judgment takes
   * the thread's as it begins and shows or takes away the banner only while
   * that still holds. A turn of the thread starting, its archiving and the
   * automatic choice switched off begin a new one, so a judgment that was
   * reading meanwhile says nothing when its reads end (Sol B2-R2-003). One
   * counter for every thread, only growing: switching off moves them all.
   * In memory, a number per thread whose turn started since the plugin did.
   */
  let generations = 0;
  let switchedOffIn = 0;
  const generationOf = new Map<string, number>();
  function generation(threadId: string): number {
    return Math.max(generationOf.get(threadId) ?? 0, switchedOffIn);
  }
  /** A turn of the thread starts, or it is archived or deleted: its banner goes, and what its pending judgments found with it. */
  function adviceOver(threadId: string): void {
    generationOf.set(threadId, ++generations);
    if (adviceBasis.delete(threadId)) storeBases();
    showAdvice(threadId, null);
  }
  /**
   * What a judgment of the thread shows, and what the refreshes ask again
   * (`basis`: its decline's; null for any other judgment): only in the
   * generation it began in (see generation).
   */
  function judgedAdvice(
    threadId: string,
    text: string | null,
    judgedIn: number,
    basis: AdviceBasis | null,
  ): void {
    if (judgedIn !== generation(threadId)) return;
    if (basis !== null) {
      // The same decline judged again (a rescue on every refresh): when it
      // was first judged stays, and storage, which keeps nothing else that
      // changed, is not written (code-reviewer r6, N3).
      const before = adviceBasis.get(threadId);
      const kept = before === undefined ? basis : { ...basis, at: before.at };
      const same =
        before !== undefined &&
        JSON.stringify(storedOf(kept)) === JSON.stringify(storedOf(before));
      adviceBasis.set(threadId, same ? kept : basis);
      if (!same) storeBases();
    } else if (adviceBasis.delete(threadId)) storeBases();
    showAdvice(threadId, text);
  }
  function showAdvice(threadId: string, text: string | null): void {
    // Never a banner with the automatic choice off. A second guard (a
    // mutant of it is equivalent): every text comes from a judgment that
    // began with it on or from a basis kept since, and switching off ends
    // both (see generation, adviceBasis) (code-reviewer r4, N1).
    if (text !== null && !current.autoSwitch) return;
    if ((shownAdvice.get(threadId) ?? null) === text) return;
    if (text === null) shownAdvice.delete(threadId);
    else shownAdvice.set(threadId, text);
    bb.realtime.publish(ADVICE_CHANGED, { threadId });
  }
  let current = await settings.get();
  settings.onChange((next) => {
    const moved =
      next.accountsDir !== current.accountsDir ||
      next.defaultAccountName !== current.defaultAccountName;
    // The default is `~/.claude` whatever it is called: renamed, it keeps
    // the seats it has taken (Astra SEATS-R08).
    if (next.defaultAccountName !== current.defaultAccountName)
      seatKeys.set(next.defaultAccountName, seatKey(current.defaultAccountName));
    current = next;
    // A Map visits no key deleted before its turn: the current one may go.
    if (!next.autoSwitch) {
      switchedOffIn = ++generations;
      if (adviceBasis.size > 0) {
        adviceBasis.clear();
        storeBases();
      }
      for (const threadId of shownAdvice.keys()) showAdvice(threadId, null);
    }
    // Found again (and stale measurements pruned) on next use: an account of
    // the old directory must not be picked.
    if (moved) accounts = [];
  });

  const collector = new UsageCollector({
    io: deps.credentialIo,
    now: deps.now,
    onMeasured: (name, measurement) => noteSeatSample(name, measurement),
    warn: (message) => bb.log.warn(message),
  });
  let accounts: Account[] = [];
  /**
   * Each account's seat budget by name, kept while the accounts are looked
   * for again (a directory changed, the default renamed): see seatKey.
   */
  const seatKeys = new Map<string, string>();
  /** The budgets known to be a login's (an accountUuid), not a name's. */
  const loginKeys = new Set<string>();
  /**
   * An account's seat budget: its login (accountUuid), so two directories
   * logged into one account share it and a renamed default keeps it; its
   * name while the login is unknown (Astra SEATS-R08).
   */
  function seatKey(name: string): string {
    return (
      accounts.find((a) => a.name === name)?.accountUuid ??
      seatKeys.get(name) ??
      name
    );
  }
  /** The names a seat budget goes by: one, or the aliases of one login. */
  function namesOf(key: string): string[] {
    const names = accounts
      .filter((a) => seatKey(a.name) === key)
      .map((a) => a.name);
    for (const [name, k] of seatKeys)
      if (k === key && !names.includes(name)) names.push(name);
    return names.length > 0 ? names : [key];
  }
  /** The accounts found: each name's budget is its login's from now on, with what was counted under it before. */
  function noteSeatKeys(): void {
    for (const a of accounts) {
      if (a.accountUuid === null) continue;
      const was = seatKeys.get(a.name) ?? a.name;
      if (was !== a.accountUuid && !loginKeys.has(was))
        seats.rekey(was, a.accountUuid);
      seatKeys.set(a.name, a.accountUuid);
      loginKeys.add(a.accountUuid);
    }
  }
  /**
   * Seats per account (see src/seats.ts): a thread's turn starts only with
   * one. Kept in memory: a reload counts again the threads bb says run
   * (see rebuildSeats). Keyed by seatKey; every change is announced.
   */
  const seats = new Seats((key) => {
    const name = namesOf(key)[0]!;
    return capacityFor(
      accounts.find((a) => a.name === name)?.kind,
      collector.get(name)?.usage?.weekly.absent === true,
      current,
    );
  }, seatsChanged);
  /**
   * Per account, a sample of its seats and usage each time it is measured,
   * a week of them (see noteSeatSample): what share of a window an hour of
   * one seat costs (`bb claude-switcher seats`).
   */
  const seatSamples: Record<string, SeatSample[]> = {};
  /**
   * The samples older than a week go, by the clock and not only as their
   * account is measured again: as they load, are stored and are listed
   * (Astra SEATS-R2-006). An account left with none goes too.
   */
  function pruneSeatSamples(): void {
    const now = deps.now();
    for (const [name, samples] of Object.entries(seatSamples)) {
      const kept = samples.filter(([t]) => now - t <= SEAT_SAMPLES_MS);
      if (kept.length === 0) delete seatSamples[name];
      else seatSamples[name] = kept;
    }
  }
  /** Titles of the threads waiting for a seat, for the list. */
  const seatTitles = new Map<string, string | null>();
  /**
   * Turns announced without a reservation whose project's account was not
   * read in time, by thread: their project. Each refresh reads it again and
   * counts the seat (Astra SEATS-R3-003); the turn's end forgets it.
   */
  const unseated = new Map<string, string>();
  /** Waits of a thread's message because its project's account could not be read for its seat (Astra SEATS-R01). */
  const seatReadWaits = new Map<string, number>();
  /**
   * The seats are counted after the load (see rebuildSeats): till then a
   * turn waits, so none is let in against an empty count (Astra SEATS-R02).
   */
  let seatsReady = false;
  let seatsCounted: Promise<void> = Promise.resolve();
  /** A message waited for the count: bb is asked again once it is done. */
  let seatsAwaited = false;
  /**
   * The threads whose turn ended (or that went) while the seats are being
   * counted: none of them is counted as running (Astra SEATS-R03). Null
   * when no count is under way.
   */
  let endedWhileCounting: Set<string> | null = null;
  const freeSeats = (name: string) => seats.free(seatKey(name));
  /**
   * Whose seat a turn of a project on `at` takes (Astra SEATS-R3-001): its
   * account's (by name), the default's when it has no variable, none (null)
   * on an account set outside this plugin, and UNKNOWN_SEAT when the
   * variable names an account not among the ones found: never the default's.
   */
  function seatFor(at: ProjectAccount): string | typeof UNKNOWN_SEAT | null {
    if (at.external) return null;
    if (at.owned && at.account === null) return UNKNOWN_SEAT;
    return at.account ?? current.defaultAccountName;
  }
  /** A seat budget for the log: the account's name. */
  function seatName(key: string): string {
    return namesOf(key)[0]!;
  }
  function occupancy(key: string): string {
    const s = seats.snapshot([key])[key]!;
    const taken = s.running + s.reserved;
    return `${taken}/${s.capacity === 0 ? "∞" : s.capacity} taken, ${s.queued.length} waiting`;
  }
  /**
   * The card hears every change of the seats (it has no clock of its own),
   * the changes of SEATS_CHANGED_MS as one, and only when the seats did
   * change (Astra SEATS-R09).
   */
  let seatsAnnounce: ReturnType<typeof setTimeout> | null = null;
  let seatsAnnounced = "";
  function seatsChanged(): void {
    seatsAnnounce ??= setTimeout(() => {
      seatsAnnounce = null;
      const now = JSON.stringify(seats.snapshot());
      if (now === seatsAnnounced) return;
      seatsAnnounced = now;
      bb.realtime.publish(CHANGED, { at: deps.now() });
    }, SEATS_CHANGED_MS);
  }
  bb.onDispose(() => {
    if (seatsAnnounce !== null) clearTimeout(seatsAnnounce);
  });
  /**
   * Reservations whose turn never started are freed, and every free seat
   * goes to the first in its account's queue; bb is asked again at once
   * when someone got one.
   */
  function admitWaiting(): void {
    const now = deps.now();
    for (const key of seats.expire(now, SEAT_TTL_MS))
      bb.log.info(
        `a seat reserved on ${seatName(key)} expired (its turn did not start); ${occupancy(key)}`,
      );
    const admitted = seats.admitAll(now);
    for (const threadId of admitted) {
      const key = seats.seatOf(threadId)?.account ?? "?";
      bb.log.info(
        `thread ${threadId}: admitted to a seat on ${seatName(key)}; ${occupancy(key)}`,
      );
    }
    if (admitted.length > 0)
      void bb.experimental_hooks
        .recheck("message.dispatch")
        .catch((error: unknown) =>
          bb.log.warn(
            `bb not asked again after a seat freed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
  }
  /** The thread's turn ended or the thread went: its seat goes to the next in line. */
  function releaseSeat(threadId: string, why: string): void {
    seatTitles.delete(threadId);
    unseated.delete(threadId);
    endedWhileCounting?.add(threadId);
    const key = seats.release(threadId);
    if (key === null) return;
    bb.log.info(
      `thread ${threadId}: seat on ${seatName(key)} released (${why}); ${occupancy(key)}`,
    );
    admitWaiting();
  }
  /** The thread's turn started on the seat budget `key`: its seat runs there. */
  function confirmSeat(threadId: string, key: string): void {
    unseated.delete(threadId);
    const { over } = seats.confirm(threadId, key, deps.now());
    seatTitles.delete(threadId);
    const line = `thread ${threadId}: running on ${seatName(key)}${over ? " over capacity" : ""}; ${occupancy(key)}`;
    if (over) bb.log.warn(line);
    else bb.log.info(line);
  }
  /**
   * The turns not counted as they started (see unseated): counted now, each
   * read within DISPATCH_LIMIT_MS; one still unread waits for the next
   * refresh (Astra SEATS-R3-003).
   */
  async function countUnseated(): Promise<void> {
    await Promise.all(
      [...unseated].map(async ([threadId, projectId]) => {
        const read = await within(
          projectAccount(projectId),
          DISPATCH_LIMIT_MS,
          `thread ${threadId}: its project's account not read to count its seat`,
        );
        // Ended, or counted, meanwhile.
        if (typeof read !== "object" || unseated.get(threadId) !== projectId)
          return;
        unseated.delete(threadId);
        if (seats.seatOf(threadId) !== null) return;
        const seat = seatFor(read.value);
        if (seat === UNKNOWN_SEAT) {
          bb.log.debug(
            `thread ${threadId}: no seat counted: its project's account is not among the accounts found`,
          );
          return;
        }
        if (seat !== null) confirmSeat(threadId, seatKey(seat));
      }),
    );
  }
  /**
   * Before a turn of the thread starts on `account`: null when it has a
   * seat there, else the wait bb holds its message on.
   */
  function seatWait(
    thread: ThreadResponse,
    account: string,
  ): MessageDispatchHookDecision | null {
    admitWaiting();
    const now = deps.now();
    const key = seatKey(account);
    const queuedBefore = seats.position(thread.id) !== null;
    if (seats.reserve(thread.id, key, now)) {
      seatTitles.delete(thread.id);
      if (queuedBefore)
        bb.log.info(
          `thread ${thread.id}: admitted to a seat on ${account}; ${occupancy(key)}`,
        );
      return null;
    }
    seatTitles.set(thread.id, thread.title ?? null);
    const s = seats.snapshot([key])[key]!;
    const ahead = (seats.position(thread.id)?.position ?? 1) - 1;
    const reason = `Waiting for a seat on ${account}: ${s.running + s.reserved}/${s.capacity} threads running, ${ahead} ahead in the queue`;
    bb.log.info(`thread ${thread.id}: ${reason}`);
    return { action: "wait", reason, sendAt: now + SEAT_RECHECK_MS };
  }
  /** By account name: aliases of one login show the same seats. */
  function seatsState(): NonNullable<State["seats"]> {
    const out: NonNullable<State["seats"]> = {};
    const snapshot = seats.snapshot(accounts.map((a) => seatKey(a.name)));
    const named = new Set<string>();
    const show = (name: string, key: string) => {
      const s = snapshot[key]!;
      named.add(key);
      out[name] = {
        ...s,
        queued: s.queued.map((threadId) => ({
          threadId,
          title: seatTitles.get(threadId) ?? null,
        })),
      };
    };
    for (const a of accounts) show(a.name, seatKey(a.name));
    for (const key of Object.keys(snapshot))
      if (!named.has(key)) show(seatName(key), key);
    return out;
  }
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
    if (loggedOut(name)) return "is not logged in";
    if (refusing(name)) return "refused a turn";
    if (reservedFor(name, model) && canRunHere(name, model))
      return `would spend ${current.preferredModel}'s weekly`;
    return model === "" ? "is out of usage" : `cannot run ${model}`;
  }
  /** `name` is measured able to run `model`, the reserve apart. */
  function canRunHere(name: string, model: string): boolean {
    const known = measuredAccounts(model).find((a) => a.name === name);
    return (
      known !== undefined &&
      known.unknown !== true &&
      bestAccount([known], model, deps.now()) === name
    );
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
      /**
       * Set when the wait told its thread to switch to Opus (see
       * opusInstead), for a turn in that model: a leftover in that model
       * that waits for the same reset is told it too, as the latest reads
       * have it (see followsAdvice).
       */
      advice?: { model: string };
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
  /**
   * Removals of queued rows by this plugin, under way or landed without
   * bb's word yet, by row id: bb's `message.cancelled` for one of them is
   * this plugin's own, unless the removal fails because the row was gone
   * before (the user's, then; `held` keeps the event until the removal
   * answers) (Codex r8, IR8-002).
   */
  const ownDeletes = new Map<
    string,
    { done: boolean; held: CancelledEntry | null }
  >();
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
      for (const [threadId, requestId] of Object.entries(byHand.data))
        cancelled.set(threadId, requestId);
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
  // The seat samples kept; one of another shape (before 0.2.31's second
  // round: no usage in it) is left out.
  try {
    const parsed = z
      .record(z.string(), z.array(z.unknown()))
      .safeParse(await bb.storage.kv.get<unknown>(KV_SEATS));
    if (parsed.success)
      for (const [name, samples] of Object.entries(parsed.data))
        seatSamples[name] = samples.flatMap((sample) => {
          const one = seatSampleSchema.safeParse(sample);
          return one.success ? [one.data] : [];
        });
    pruneSeatSamples();
  } catch (error) {
    bb.log.warn(
      `could not read the seat samples; starting them again: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // What the banners were asked on before the restart, thread by thread:
  // checked against bb by the first refresh (see reviseAdvice). None with
  // the automatic choice off, which ends them all.
  try {
    const stored = await bb.storage.kv.get<unknown>(KV_ADVICE);
    const byThread = z.record(z.string(), z.unknown()).safeParse(stored);
    const entries = Object.entries(byThread.success ? byThread.data : {});
    let unreadable = 0;
    for (const [threadId, value] of entries) {
      const parsed = storedBasisSchema.safeParse(value);
      if (!parsed.success) {
        unreadable += 1;
        continue;
      }
      if (!current.autoSwitch) continue;
      const { reason, ...rest } = parsed.data;
      adviceBasis.set(threadId, {
        ...rest,
        decision: { kind: "decline", reason },
        restored: true,
      });
    }
    if (unreadable > 0 || (stored != null && !byThread.success))
      bb.log.warn(
        `what the banners are asked on had ${unreadable > 0 ? `${unreadable} unreadable thread${unreadable === 1 ? "" : "s"}` : "an unreadable shape"}; kept the rest`,
      );
    // Written again without what could not be read, so the next start
    // reads it all and says nothing (code-reviewer r6, N1).
    if (
      adviceBasis.size !== entries.length ||
      (stored != null && !byThread.success)
    )
      storeBases();
  } catch (error) {
    bb.log.warn(
      `could not read what the banners are asked on; they come back with the next judgments: ${error instanceof Error ? error.message : String(error)}`,
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
      if (
        m?.usage === null ||
        m?.usage === undefined ||
        m.observedAt === null
      ) {
        if (series[account.name] !== undefined) next[account.name] = own;
        continue;
      }
      // Only a fresh measurement is a sample: a failed query keeps the old usage.
      if (m.problem !== null && m.problem.kind === "error") {
        next[account.name] = own;
        continue;
      }
      const windows: [
        string,
        { usedPercent: number; resetsAt: number | null },
      ][] = [["weekly", m.usage.weekly], ...Object.entries(m.usage.models)];
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
    for (const name of Object.keys(seatSamples))
      if (next[name] === undefined) delete seatSamples[name];
    const snapshot = series;
    pruneSeatSamples();
    const seatSnapshot = structuredClone(seatSamples);
    seriesWrites = seriesWrites.then(async () => {
      try {
        await bb.storage.kv.set(KV_SEATS, seatSnapshot);
      } catch (error) {
        bb.log.warn(
          `could not store the seat samples: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
  /**
   * The account was measured: a sample of its seats as they are now, with
   * the usage it was measured at, whole in itself (Astra SEATS-R06/R07).
   * One per account and measurement: a measurement seen again (a failed
   * query keeps the old one) adds nothing and changes nothing.
   */
  function noteSeatSample(name: string, m: Measurement): void {
    if (m.observedAt === null || m.usage === null) return;
    if (m.problem !== null && m.problem.kind === "error") return;
    const at = m.observedAt;
    const own = (seatSamples[name] ?? []).filter(
      ([t]) => at - t <= SEAT_SAMPLES_MS,
    );
    if (own.some(([t]) => t === at)) return;
    const key = seatKey(name);
    const taken = seats.snapshot([key])[key]!;
    const { session, weekly } = m.usage;
    own.push([
      at,
      taken.running,
      taken.reserved,
      session.usedPercent,
      weekly.absent === true ? null : weekly.usedPercent,
      session.resetsAt,
      weekly.absent === true ? null : weekly.resetsAt,
    ]);
    seatSamples[name] = own;
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
        throw new Error(`${name} in the accounts directory is not a directory`);
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
    noteSeatKeys();
    // A measurement of an account that is gone must never be chosen.
    collector.prune(accounts);
    // Which account a project's note names depends on the accounts found.
    projectsRead = null;
    return accounts;
  }

  /**
   * The banners' pass under way (see reviseAdvice), and whether one was
   * asked for since it began. The pass only tells, so nothing that decides
   * waits for it (Sol B2-R5-003): a refresh asks for it and goes on. One at
   * a time: asked while one runs, it runs once more after it, on the reads
   * of then.
   */
  let bannerPass: Promise<void> | null = null;
  let passAgain = false;
  /**
   * Projects a pass did not read because a move of theirs was under way:
   * the pass runs again once that move is over (see applyAccount; Sol
   * B2-R6-002).
   */
  const passAfterMove = new Set<string>();
  /**
   * Refreshes so far: a basis read back counts at most one check that could
   * not tell per refresh, however many passes run in it (see restoredHolds;
   * code-reviewer r7, CR-L1).
   */
  let refreshes = 0;
  function askBannersAgain(): void {
    passAgain = true;
    bannerPass ??= (async () => {
      try {
        while (passAgain) {
          passAgain = false;
          try {
            await reviseAdvice();
          } catch (error) {
            bb.log.warn(
              `the banners were not asked again: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } finally {
        bannerPass = null;
      }
    })();
  }

  async function refreshAll(): Promise<void> {
    try {
      const found = await discover();
      await collector.collectAll(found);
      await recordSamples();
      bb.realtime.publish(CHANGED, { at: deps.now() });
    } finally {
      refreshes += 1;
      // Seats reserved for turns that never started are freed with it.
      admitWaiting();
      // Also when the refresh fails: the reads it left grow old, and a
      // banner on reads older than two refreshes must go (Sol B2-R5-001).
      askBannersAgain();
    }
  }

  /** A refresh asked for (Settings, the CLI): it answers once the banners are asked again on its reads too. */
  async function refreshByHand(): Promise<void> {
    try {
      await refreshAll();
    } finally {
      await bannerPass;
    }
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
      for (const p of projects) projectNames.set(p.id, p.name);
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

  /**
   * The moves of each project's account by this plugin, under way and
   * done: a read of the project's account that overlaps or crosses one says
   * nothing about where a turn started (Codex IR15-001).
   */
  type MoveMark = { writes: number; picks: number };
  const moves = new Map<
    string,
    {
      epoch: number;
      inFlight: number;
      picks: number;
      writes: number;
      writing: number;
    }
  >();
  function movesOf(projectId: string): {
    epoch: number;
    inFlight: number;
    /** Choices by hand (a pick, also one that confirms the account; a release): each outranks an automatic move still under way. */
    picks: number;
    /**
     * Writes of the project's account, counted as each starts and once it
     * is over (landed or not): what decides whether a decision still holds
     * (applyAccount) and whether a move's origin is known (noteMove). An
     * attempt dropped before its write moves nothing here, so it never
     * drops nor hides the one that replaced it (Codex E46-R3-001,
     * E46-R4-002); `epoch`, which every attempt moves, only tells a read
     * of the account that a move crossed it.
     */
    writes: number;
    /**
     * Writes of the project's account under way: one may land any moment,
     * so what a read said may no longer hold (Astra SEATS-R3-002).
     */
    writing: number;
  } {
    let move = moves.get(projectId);
    if (move === undefined) {
      move = { epoch: 0, inFlight: 0, picks: 0, writes: 0, writing: 0 };
      moves.set(projectId, move);
    }
    return move;
  }
  /** The project's moves and picks as they stand, for noteMove: taken BEFORE reading the project's account. */
  function moveMark(projectId: string): MoveMark {
    const { writes, picks } = movesOf(projectId);
    return { writes, picks };
  }

  /**
   * The account each project left for a turn in another model (its
   * excursion, 2026-10-13: the Max accounts are Fable's): a turn in the
   * preferred model takes the project back there. In memory, like
   * aheadLeft: a reload forgets it and the project stays where it is.
   * Kept by noteMove, next to every applyAccount, and cleared by a pick by
   * hand and by `release`.
   */
  const excursions = new Map<string, { from: string; model: string }>();
  /** A turn in `model` is another model's: it must not spend what the preferred model needs. */
  function otherModel(model: string): boolean {
    return reserving({
      preferredModel: model,
      reserveModel: current.preferredModel,
    });
  }
  /**
   * After applyAccount moved the project from `fromName` to `toName` for a
   * turn in `model`. A move for another model notes the FIRST account left
   * and keeps it through later moves; a move for the preferred model is a
   * new home and forgets it. `before`: the project's moves and picks when
   * the caller captured them, BEFORE reading the project's account: the
   * origin is noted only when exactly this move's write happened since
   * (writes + 2)
   * and nobody picked by hand meanwhile, so neither a stale read, a move
   * that crossed the write nor a pick that confirmed the account names a
   * wrong origin (Codex BM-R2-003, BM-R3-001, BM-INSPECT-004).
   */
  function noteMove(
    projectId: string,
    fromName: string,
    toName: string,
    model: string,
    before: MoveMark,
  ): void {
    if (fromName === toName) return;
    if (!otherModel(model)) {
      excursions.delete(projectId);
      return;
    }
    if (excursions.has(projectId)) return;
    const move = movesOf(projectId);
    if (move.writes !== before.writes + 2 || move.picks !== before.picks) {
      // Logged, not debug: the project's next turn in the preferred model
      // then stays where it is, and this line is why (code-reviewer r1).
      bb.log.info(
        `project ${projectId}: excursion from ${fromName} not noted (${move.picks !== before.picks ? "picked or released by hand meanwhile" : "another move crossed it"})`,
      );
      return;
    }
    excursions.set(projectId, { from: fromName, model });
  }
  /**
   * `name` is measured keeping the preferred model AND has a weekly window:
   * a turn in `model` there spends what the preferred model needs (see
   * spendsReservedWeekly). Never retried there without judging. Judged as
   * the account will be when the turn is sent (`at`: a wait's send time;
   * now by default), at the latest: a Max account whose Fable window
   * resets before a wait ends keeps Fable again by then (code-reviewer
   * r1, M1), as decideSwitch projects its waits.
   */
  function reservedFor(name: string, model: string, at = deps.now()): boolean {
    if (!otherModel(model)) return false;
    const known = measuredAccounts(model).find((a) => a.name === name);
    if (known === undefined || known.unknown === true) return false;
    const sendBy =
      Math.max(at, deps.now()) + RESET_BUFFER_MS + RESET_JITTER_MS;
    return spendsReservedWeekly(settle(known, sendBy), {
      preferredModel: model,
      reserveModel: current.preferredModel,
    });
  }

  /**
   * Point the project at `account` (null = default). Refuses an external
   * variable. False when an automatic move is dropped: a write of the
   * project's account or a pick by hand happened while its sessions were
   * shared; nothing is written, and the caller records no move and acts on
   * none (Codex E46-R2-001, E46-R4-001). A choice by hand (`byHand`: a
   * pick, a release) always writes.
   *
   * `share: false` (placeTurn, the dispatcher's path): the sharing is
   * started and not waited for, its failures logged, and the move is not
   * looked at again (Fable, 2026-10-29). Every race of rounds r2 to r6
   * came from waiting for the sessions there. With the projects/ directory
   * shared by the accounts (the Mac already; Linux with E46) the sharing
   * does nothing; and the moves that matter most to live threads (an
   * account out: turn.failed, then judge; a pick; moveAhead; moveUpWait)
   * run in the project's queue, one at a time, and wait for it.
   */
  async function applyAccount(
    projectId: string,
    account: Account | null,
    from: ProjectAccount,
    options: { byHand?: boolean; share?: boolean } = {},
  ): Promise<boolean> {
    if (from.external) {
      throw new Error(
        `${ENV_VAR} on project ${projectId} was set outside this plugin; change it in the project's machine environment`,
      );
    }
    const toName = account === null ? current.defaultAccountName : account.name;
    // A move for real (another account name): counted before the write
    // starts and once it is over, landed or not.
    const move =
      toName === (from.account ?? current.defaultAccountName)
        ? null
        : movesOf(projectId);
    if (move !== null) {
      move.inFlight += 1;
      move.epoch += 1;
    }
    let wrote = false;
    try {
      // The sessions first, while the move is counted in flight: a turn of
      // another thread of the project that reads the new account finds its
      // session there (Codex E46-002). Links in the new account are
      // harmless if the write below fails. Past SESSIONS_LIMIT_MS the
      // variable is written anyway: a move without the sessions beats a
      // queue hung on a filesystem or on bb (Fable, 2026-10-29); what is
      // still under way only adds links.
      if (move !== null && options.share === false)
        void shareProjectSessions(projectId, account, toName, from.account);
      else if (move !== null) {
        const mark = { writes: move.writes, picks: move.picks };
        const shared = await within(
          shareProjectSessions(projectId, account, toName, from.account),
          SESSIONS_LIMIT_MS,
          `sessions of ${projectNames.get(projectId) ?? projectId} not shared into ${toName}`,
        );
        if (shared === "late")
          bb.log.warn(
            `sessions of ${projectNames.get(projectId) ?? projectId} not shared into ${toName} within ${SESSIONS_LIMIT_MS / 1000} s; the move goes on`,
          );
        if (
          options.byHand !== true &&
          (move.writes !== mark.writes || move.picks !== mark.picks)
        ) {
          bb.log.info(
            `project ${projectId}: not moved to ${toName}: picked by hand or moved meanwhile`,
          );
          return false;
        }
      }
      if (move !== null) {
        move.writes += 1;
        move.writing += 1;
        wrote = true;
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
    } finally {
      // Also after a failure: a delete may have landed before it.
      projectsRead = null;
      if (move !== null) {
        if (wrote) {
          move.writes += 1;
          move.writing -= 1;
        }
        move.inFlight -= 1;
        move.epoch += 1;
        // A banners' pass left the project unread for this move: it runs
        // again now, without being waited for (Sol B2-R6-002). With no pass
        // under way, its part up to its first read (the bases in memory, a
        // banner taken away) runs here, inside this `finally`.
        if (move.inFlight === 0 && passAfterMove.delete(projectId))
          askBannersAgain();
      }
    }
    if (toName !== (from.account ?? current.defaultAccountName))
      accountChangedAt.set(projectId, deps.now());
    bb.realtime.publish(CHANGED, { at: deps.now() });
    return true;
  }

  /** The projects named in the last list (logs only). */
  const projectNames = new Map<string, string>();
  /** Projects already logged as having a path of another machine. */
  const elsewhereLogged = new Set<string>();
  /**
   * Links into the account the project moved to the Claude Code sessions
   * it lacks of the project's paths on this machine, so a thread resumed
   * there finds its conversation (src/sessions.ts). Never fails the move:
   * whatever goes wrong is logged.
   */
  async function shareProjectSessions(
    projectId: string,
    account: Account | null,
    toName: string,
    fromName: string | null,
  ): Promise<void> {
    const io = deps.sessionsIo;
    if (io === undefined) return;
    const name = projectNames.get(projectId) ?? projectId;
    const dirOf = (a: Account | null | undefined) =>
      a?.configDir ?? `${deps.accountsIo.home}/.claude`;
    try {
      const target = dirOf(account);
      const left = accounts.find(
        (a) => a.name === (fromName ?? current.defaultAccountName),
      );
      // The account left first: it has the thread's latest session.
      const sources = [
        ...(left === undefined ? [] : [dirOf(left)]),
        ...accounts.map(dirOf),
      ];
      const environments = await bb.sdk.environments.list({ projectId });
      const paths = [
        ...new Set(
          environments.flatMap((e) =>
            e.path === null || e.status === "destroyed" ? [] : [e.path],
          ),
        ),
      ];
      const elsewhere: string[] = [];
      for (const projectPath of paths) {
        const result = await shareSessions({ projectPath, target, sources, io });
        if (result.skipped === "no-project-dir") elsewhere.push(projectPath);
        if (result.linked > 0)
          bb.log.info(
            `sessions of ${name} shared into ${toName}: ${result.linked} linked (${projectPath})`,
          );
        if (result.errors.length > 0)
          bb.log.warn(
            `sessions of ${name} not all shared into ${toName}: ${result.errors.slice(0, 3).join("; ")}${result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : ""} (${projectPath})`,
          );
      }
      if (elsewhere.length > 0 && !elsewhereLogged.has(projectId)) {
        elsewhereLogged.add(projectId);
        bb.log.info(
          `sessions not shared for ${name}: path not on this machine (${elsewhere.join(", ")})`,
        );
      }
    } catch (error) {
      bb.log.warn(
        `sessions of ${name} not shared into ${toName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** How old a measurement may be to decide on: two refresh periods. */
  function maxReadAgeMs(): number {
    return 2 * Math.max(1, current.refreshMinutes) * 60_000;
  }

  /** Measurements recent enough to decide on (see maxReadAgeMs). */
  function measuredAccounts(model = current.preferredModel) {
    // A refusing account is out, whatever its numbers say.
    return collector.usable(maxReadAgeMs(), model).map((a) => {
      if (!refusing(a.name)) return a;
      const { unknown: _, ...known } = a;
      return { ...known, blocked: true };
    });
  }

  /**
   * The accounts whose latest usage read says nothing of what they can run
   * now (see opusInstead): never read, its latest attempt had a problem (a
   * 429, the endpoint down), or it is older than two refreshes (a rescue
   * still runs after a refresh that failed: code-reviewer 0.2.20, CR-05).
   * An account without a login is not one of them: it runs nothing until
   * logged in again. With no account found (the accounts directory changed,
   * and no read of it since worked), every reading still in memory is of an
   * account not found, and none says anything (code-reviewer r6, CR-L1).
   */
  function unreadAccounts(): string[] {
    if (accounts.length === 0) return collector.usable().map((a) => a.name);
    const now = deps.now();
    return accounts
      .filter((account) => {
        const m = collector.get(account.name);
        if (m === undefined) return true;
        if (m.problem?.kind === "unauthenticated") return false;
        return (
          m.problem !== null ||
          m.observedAt === null ||
          now - m.observedAt > maxReadAgeMs()
        );
      })
      .map((account) => account.name);
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
      seats: seatsState(),
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
    if (loggedOut(name)) return true;
    const known = measuredAccounts().find((a) => a.name === name);
    return (
      known !== undefined &&
      known.unknown !== true &&
      bestAccount([known], "", deps.now()) !== name
    );
  }

  /** `name` answered its usage query unauthenticated: no login, a turn there fails. */
  function loggedOut(name: string): boolean {
    return collector.get(name)?.problem?.kind === "unauthenticated";
  }
  /**
   * The default account's login: "unknown" until a look at it has answered
   * (Astra E44-R2-01), and while its last look could not check it (the
   * store unreadable, the refresh failed: Astra E44-R3-01).
   */
  function defaultLogin(): LoginState {
    return collector.get(current.defaultAccountName)?.login ?? "unknown";
  }
  /**
   * A turn on `name` would start on a login nobody confirmed: none, or the
   * default's whose last look could not check it (Astra E44-R3-01). Never
   * looked at does not count: beforeStart looks at it first. Only the
   * default's failed look counts: a project on an account of its own stays
   * where it was put.
   */
  function unconfirmed(name: string): boolean {
    return (
      loggedOut(name) ||
      (name === current.defaultAccountName &&
        collector.get(name)?.login === "unknown")
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
        await applyAccount(projectId, to, from, { byHand: true });
        applied = true;
        // The pick is the user's: nothing to come back from, also when it
        // confirms the account the project is on; and it outranks an
        // automatic move whose answer is still pending (see noteMove).
        excursions.delete(projectId);
        movesOf(projectId).picks += 1;
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
      await refreshByHand();
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
      await login.start(
        { ...target, shareFrom },
        {
          ...deps.env,
          CLAUDE_SWITCHER_PRIVATE: current.loginPrivateWindow ? "1" : "0",
        },
      );
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
    async thread_advice({ threadId }) {
      return { text: shownAdvice.get(threadId) ?? null };
    },
  });

  // ---- Retry of a failed turn ---------------------------------------------
  /**
   * Waits queued back after bb did not take their retry, or after ours could
   * not replace them (restoreQueued), by retryKey (their id never comes back
   * when bb's answer is lost): newer than the move that released them, they
   * still waited on the old account (Codex BM-INSPECT-R4-002). A mark is
   * dropped by the next pass that reads the queue without its row; with the
   * automatic choice off, it stays until a pass runs again (a few strings,
   * and a stale mark matches no newer row: the attempt is part of the key).
   * A row put back on a project that did not move is released too once its
   * account is MEASURED able to run the turn (never on one that cannot be
   * measured), as a wait releaseWait put back is: a wait for a reset that
   * came early. Backoffs are never released: they are due within
   * SHORT_WAIT_MS (code-reviewer 0.2.18 r1, CR1-01/CR1-02).
   */
  const putBack = new Map<string, number>();
  /** Order of the marks: a pass drops only marks older than its read of the queue. */
  let putBackMarks = 0;
  function markPutBack(key: string): void {
    putBack.set(key, ++putBackMarks);
  }
  /** A queued retry's turn: bb keeps one queued retry per thread, chain and attempt. */
  function retryKey(threadId: string, of: string, attempt: number): string {
    return JSON.stringify([threadId, of, attempt]);
  }
  /** Whether a retry with this key is queued on the thread; false when bb cannot be read. */
  function rowQueued(threadId: string, key: string): Promise<boolean> {
    return bb.sdk.threads.queuedMessages.list({ threadId }).then(
      (rows) =>
        rows.some(
          (r) =>
            r.payload.kind === "retry" &&
            retryKey(threadId, r.payload.retryOfTurnRequestId, r.payload.attempt) ===
              key,
        ),
      () => false,
    );
  }

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
  ): Promise<{
    id: string;
    reason: string;
    sendAt: number | null;
    key: string;
  } | null> {
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
      return {
        id: row.id,
        reason: payload.reason,
        sendAt: row.sendAt,
        key: retryKey(event.threadId, payload.retryOfTurnRequestId, payload.attempt),
      };
    }
    return null;
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

  /**
   * Replace `rowId`, another plugin's retry of the turn, by one of ours: it is
   * deleted here and queued again by the caller, so bb dispatches the retry
   * through its checkpoint, where the turn is placed. An explicit send of
   * the row would skip that checkpoint and run the turn where the project
   * stood when the row was found, not when it is sent (Codex
   * BM-INSPECT-R2-001). False when the row is already on its way: nothing to
   * replace. Any other failure of the delete (its answer lost, bb refusing)
   * is logged and ours is queued anyway: if the row is still there, bb
   * refuses ours (one retry per turn) and the row stays, so the turn is
   * never left without a retry (Codex BM-INSPECT-R3-001).
   */
  async function replaceQueued(threadId: string, rowId: string): Promise<boolean> {
    try {
      await deleteOwn(threadId, rowId);
      return true;
    } catch (error) {
      // Sent between the list and this delete (bb would refuse a retry of a
      // thread that is running again), or removed by the user: nothing to
      // replace.
      if (alreadyOnItsWay(error)) {
        bb.log.info(
          `thread ${threadId}: the queued retry is already on its way; leaving it`,
        );
        return false;
      }
      bb.log.warn(
        `thread ${threadId}: could not remove the queued retry (${error instanceof Error ? error.message : String(error)}); queuing ours anyway`,
      );
      return true;
    }
  }

  /**
   * Retry the failed turn now (no sendAt) or at `sendAt`. bb keeps ONE retry
   * per turn: if provider-retry got there first, its row is replaced by ours,
   * at once or timed, so bb dispatches the retry through its checkpoint (see
   * replaceQueued). A row queued meanwhile, between the list and ours, is
   * replaced once more; a third one is left to bb, which dispatches it
   * through the checkpoint at its own time. If ours cannot be queued after a
   * row was replaced, that row is put back rather than leave the turn
   * without any retry (code-reviewer r3, CR3-01).
   */
  async function retryTurn(
    event: PluginTurnFailedEvent,
    /**
     * Asked right before each retry is queued, after the waits on the queue
     * (its look, the removal of a row): what it says may change meanwhile
     * (Sol B2-R6-004).
     */
    reason: string | (() => string),
    sendAt?: number,
    stuck = false,
  ): Promise<void> {
    const threadId = event.threadId;
    let row = await queuedRetry(event);
    if (row !== null) {
      bb.log.info(
        `thread ${threadId}: a retry of the turn is already queued ("${row.reason}"${row.sendAt === null ? "" : `, for ${new Date(row.sendAt).toISOString()}`})`,
      );
      // On a rescue it is left to whoever queued it: another plugin may be
      // holding it, and replacing it would drop that hold (Codex r6,
      // IR6-002).
      if (stuck) return;
    }
    for (let replacements = 0; ; replacements++) {
      if (row !== null && !(await replaceQueued(threadId, row.id))) return;
      try {
        await bb.sdk.threads.retry({
          threadId,
          turnRequestId: event.requestId,
          reason: typeof reason === "string" ? reason : reason(),
          ...(sendAt === undefined ? {} : { sendAt }),
        });
        return;
      } catch (error) {
        // Raced with another retry of the same turn between the list and ours.
        // If this look fails too, nothing is known about a race, and the row
        // replaced, if any, is still put back below (Codex BM-INSPECT-R4-001).
        let raced: Awaited<ReturnType<typeof queuedRetry>> = null;
        try {
          raced = await queuedRetry(event);
        } catch (lookError) {
          bb.log.warn(
            `thread ${threadId}: could not look at the queue again (${lookError instanceof Error ? lookError.message : String(lookError)}); going on without it`,
          );
        }
        if (raced !== null) {
          if (stuck || sendAt !== undefined || replacements > 0) {
            bb.log[stuck ? "info" : "warn"](
              row !== null && raced.id === row.id
                ? `thread ${threadId}: the retry queued before could not be removed and is still there; leaving it`
                : `thread ${threadId}: another retry was queued ${replacements > 0 ? "again" : "first"}; leaving it`,
            );
            return;
          }
          row = raced;
          continue;
        }
        // A newer turn replaced the failed one (a message sent meanwhile): it
        // runs on the project's account, and its own failure comes on its own.
        if (superseded(error)) {
          bb.log.info(
            `thread ${threadId}: turn ${event.requestId} is no longer its latest; the newer turn goes on`,
          );
          return;
        }
        // bb has the turn already (ours refused for a retry it keeps, or
        // the turn is no longer the failed one): nothing to restore, and
        // nothing is known about a race (code-reviewer 0.2.18 r1, CR1-03).
        if (bbHasTheTurn(error)) {
          bb.log.info(
            `thread ${threadId}: bb already has a retry of the turn (${error instanceof Error ? error.message : String(error)})`,
          );
          return;
        }
        if (row === null) throw error;
        await restoreQueued(threadId, event, row, error);
        return;
      }
    }
  }

  /**
   * Ours could not be queued after `row` was replaced: `row` is queued again
   * as it was, and marked put back so a later pass may still release it
   * (Codex BM-INSPECT-R4-002). Unless bb has the turn: ours landed and only
   * its answer was lost, or the turn is no longer the failed one
   * (code-reviewer r4, CR4-01).
   */
  async function restoreQueued(
    threadId: string,
    event: PluginTurnFailedEvent,
    row: { reason: string; sendAt: number | null; key: string },
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    bb.log.warn(
      `thread ${threadId}: could not queue the retry (${message}); restoring the one queued before`,
    );
    try {
      const back = await bb.sdk.threads.retry({
        threadId,
        turnRequestId: event.requestId,
        reason: row.reason,
        ...(row.sendAt === null ? {} : { sendAt: row.sendAt }),
      });
      if (back.delivery === "queued") markPutBack(row.key);
    } catch (restoreError) {
      const restore =
        restoreError instanceof Error
          ? restoreError.message
          : String(restoreError);
      if (bbHasTheTurn(restoreError)) {
        bb.log.info(
          `thread ${threadId}: the retry queued before is not restored: bb has the turn (${restore})`,
        );
        return;
      }
      // bb may have queued it and lost only its answer (as releaseWait
      // allows for): looked for, and marked put back only when found, so
      // no mark outlives a row that was never queued (Codex Sol 0.2.18 r1,
      // R0218-CODEX-001; code-reviewer r2, CR2-01). The row found may be
      // the one that could not be removed: a retry is queued either way
      // (CR2-02).
      if (await rowQueued(threadId, row.key)) {
        markPutBack(row.key);
        bb.log.info(
          `thread ${threadId}: a retry of the turn is queued after all (the restore's answer was lost: ${restore})`,
        );
        return;
      }
      throw new Error(
        `${message}; restoring the retry queued before failed too: ${restore}`,
        { cause: error },
      );
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
    advice?: { model: string },
    /**
     * The reason of the move's history row when it also tells the thread to
     * switch to Opus, asked as that row is added, once the move is stored as
     * the project's latest (null: `record.reason`): see judge (Sol
     * B2-R4-002). The latest move keeps `record.reason`: the advice is the
     * thread's.
     */
    told?: () => string | null,
  ) {
    recentSwitches.set(record.projectId, {
      at: record.at,
      to: record.to,
      threadId: cause,
      sendAt,
      advice,
      graced: new Set(),
    });
    try {
      await bb.storage.kv.set(KV_LAST_SWITCH, record);
    } catch (error) {
      bb.log.warn(
        `could not record the switch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await addHistory({ ...record, reason: told?.() ?? record.reason });
  }

  /**
   * What a leftover in the same model is told when it follows a wait that
   * told its thread to switch to Opus, while the wait is still ahead (one
   * already due is retried at once: code-reviewer 0.2.20 r2, R2-02). Judged
   * again on the latest reads, not copied (Sol B2-001): a refresh since may
   * show the account named out of Opus, or fail to read one, and then
   * nothing is said. From where the wait leaves the project, the account
   * the leftover's turn started on ruled out as the failure's (unknown:
   * none). No read here: the measurements as they stand.
   */
  function followsAdvice(
    recent: {
      to: string;
      sendAt: number | undefined;
      advice?: { model: string };
    },
    model: string,
    now: number,
    event: PluginTurnFailedEvent,
    started: string | null | undefined,
    projectId: string,
  ): string | null {
    if (
      recent.advice === undefined ||
      recent.sendAt === undefined ||
      recent.sendAt <= now ||
      recent.advice.model.toLowerCase() !== model.toLowerCase()
    )
      return null;
    const on = opusInstead(
      { kind: "wait", account: recent.to, sendAt: recent.sendAt, reason: "" },
      {
        currentAccount: recent.to,
        failedAccount: typeof started === "string" ? started : null,
        accounts: measuredAccounts(model),
        preferredModel: model,
        reserveModel: current.preferredModel,
        now,
      },
      unreadAccounts(),
      placementOf(projectId, FALLBACK_MODEL, now),
    );
    return on === null ? null : opusInsteadText(model, on);
  }

  /**
   * After a usage refresh (see askBannersAgain): the banner of each thread
   * whose latest judgment declined its turn, asked again on the new reads
   * (Sol B2-R4-001). A thread with a retry queued (bb's provider-retry) is
   * never judged again until that retry runs, while the account an Opus
   * turn would go to changes with the numbers. As a rescue's judgment would
   * ask it: the account the turn failed on judged on its numbers like the
   * rest, from where the project sits now, with the same function and the
   * same placement (opusInstead): a new account, the banner gone (Fable
   * back, no account for Opus, a read that failed) or back. A basis read
   * back after a restart is checked against bb before anything else is
   * asked of it (see restoredHolds; code-reviewer r6, CR-L2). Only the
   * banner: nothing sent, retried, moved, queued or written. One read of
   * each project's account for all its threads (Sol B2-R5-003), none for a
   * banner that goes whatever the project's account (see adviseOpus): its
   * model no longer the preferred one, a read of an account that says
   * nothing (failed, missing or older than two refreshes: Sol B2-R5-001),
   * or the preferred model back on some account (Sol B2-R6-003). A banner
   * also goes when the project's account cannot be read. In every case its
   * basis stays for the reads to come back. A judgment of the thread, a
   * turn of it, its archiving or the automatic choice switched off while
   * the project is read leave a basis other than the one read: what was
   * read says nothing, and that thread's banner is theirs.
   */
  async function reviseAdvice(): Promise<void> {
    const byProject = new Map<string, [string, AdviceBasis][]>();
    for (const [threadId, stored] of adviceBasis) {
      const basis =
        stored.restored === true ? await restoredHolds(threadId, stored) : stored;
      // A judgment of the thread that landed while the pass waited for that
      // check: its basis, and its banner, are its own (Sol B2-R7-001).
      if (basis === null || adviceBasis.get(threadId) !== basis) continue;
      if (
        !adviseOpus(
          basis.decision,
          {
            accounts: measuredAccounts(basis.model),
            preferredModel: basis.model,
            reserveModel: current.preferredModel,
            now: deps.now(),
          },
          unreadAccounts(),
          // As a rescue's judgment asks it: every account on its numbers.
          null,
        )
      ) {
        showAdvice(threadId, null);
        continue;
      }
      const threads = byProject.get(basis.projectId) ?? [];
      threads.push([threadId, basis]);
      byProject.set(basis.projectId, threads);
    }
    for (const [projectId, threads] of byProject)
      await askProject(projectId, threads);
  }

  /**
   * The banners of a project's threads that the pass asks again (see
   * reviseAdvice), on one read of where the project sits (code-reviewer
   * r7, N3).
   */
  async function askProject(
    projectId: string,
    threads: [string, AdviceBasis][],
  ): Promise<void> {
    // A move of the project under way: where it sits is being written.
    // Not read now: the pass runs again once the move is over, and the
    // banners stay as they were until then (Sol B2-R6-002).
    const move = movesOf(projectId);
    if (move.inFlight > 0) {
      passAfterMove.add(projectId);
      return;
    }
    const epoch = move.epoch;
    let at: ProjectAccount;
    try {
      at = await projectAccount(projectId);
    } catch (error) {
      for (const [threadId, basis] of threads) {
        bb.log.warn(
          `thread ${threadId}: its banner not asked again (the project's account could not be read: ${error instanceof Error ? error.message : String(error)})`,
        );
        // Where an Opus turn would go is not known: the banner goes
        // (Sol B2-R6-003).
        if (adviceBasis.get(threadId) === basis) showAdvice(threadId, null);
      }
      return;
    }
    // A move crossed the read: what it says is where the project was, or
    // is going. Dropped, and the pass runs again (Sol B2-R6-002).
    if (move.epoch !== epoch) {
      passAgain = true;
      return;
    }
    const now = deps.now();
    for (const [threadId, basis] of threads) {
      if (adviceBasis.get(threadId) !== basis) continue;
      // Set outside this plugin: no placement there (see placeTurn).
      if (at.external) {
        showAdvice(threadId, null);
        continue;
      }
      const on = opusInstead(
        basis.decision,
        {
          currentAccount: at.account ?? current.defaultAccountName,
          accounts: measuredAccounts(basis.model),
          preferredModel: basis.model,
          reserveModel: current.preferredModel,
          now,
          stuck: true,
        },
        unreadAccounts(),
        placementOf(projectId, FALLBACK_MODEL, now),
      );
      showAdvice(threadId, on === null ? null : opusInsteadText(basis.model, on));
    }
  }

  /**
   * A basis read back after a restart (see adviceBasis), checked against bb
   * before the pass asks its banner (see waitsOnJudgedTurn); a thread that
   * moved on while the plugin was away keeps nothing (Sol B2-R5-002). The
   * basis checked, now the thread's; null when it is dropped, when a
   * judgment of the thread replaced it meanwhile, or when bb could not be
   * read or does not say yet (kept, unchecked and not shown: asked again by
   * the next pass, up to RESTORED_CHECKS refreshes in a row). One judged
   * more than RESTORED_MAX_AGE_MS before is dropped unread (code-reviewer
   * r6, CR-L2).
   */
  async function restoredHolds(
    threadId: string,
    basis: AdviceBasis,
  ): Promise<AdviceBasis | null> {
    let holds: boolean | null = false;
    if (deps.now() - basis.at > RESTORED_MAX_AGE_MS)
      bb.log.debug(
        `thread ${threadId}: what its banner was asked on is dropped (judged more than ${RESTORED_MAX_AGE_MS / 86_400_000} days ago)`,
      );
    else {
      try {
        holds = await waitsOnJudgedTurn(threadId, basis);
      } catch (error) {
        bb.log.warn(
          `thread ${threadId}: its banner not asked again (the thread or its log could not be read: ${error instanceof Error ? error.message : String(error)})`,
        );
        holds = null;
      }
      if (adviceBasis.get(threadId) !== basis) return null;
      if (holds === null) {
        // One per refresh: a pass that runs again in it (after a move, or a
        // read a move crossed) counts nothing more (code-reviewer r7, CR-L1).
        if (basis.missedIn === refreshes) return null;
        const misses = (basis.misses ?? 0) + 1;
        if (misses < RESTORED_CHECKS) {
          adviceBasis.set(threadId, { ...basis, misses, missedIn: refreshes });
          return null;
        }
        bb.log.info(
          `thread ${threadId}: what its banner was asked on is dropped (${RESTORED_CHECKS} checks in a row could not tell)`,
        );
        holds = false;
      }
    }
    if (!holds) {
      adviceBasis.delete(threadId);
      storeBases();
      return null;
    }
    // A copy: the object in the map stays as it was read (code-reviewer r6,
    // N2).
    const checked = { ...basis, restored: false };
    adviceBasis.set(threadId, checked);
    return checked;
  }
  /**
   * Whether bb says the thread still waits on the turn `basis` judged: in
   * error, in the same project, its latest turn that one or a later attempt
   * of its chain. With the plugin running, such an attempt's start would
   * have ended the banner, and only its failure's judgment could put one
   * back: so that attempt must have been sent in the model judged and have
   * failed in a way a failure's judgment takes up (a limit, a refusal), as
   * a rescue reads it from bb's log (Sol B2-R6-001). Null: the log does not
   * say yet how that attempt failed.
   */
  async function waitsOnJudgedTurn(
    threadId: string,
    basis: AdviceBasis,
  ): Promise<boolean | null> {
    const live = await bb.sdk.threads.get({ threadId });
    if (!waitingThread(live) || live.projectId !== basis.projectId)
      return false;
    const turn = await latestTurn(threadId);
    if (turn === null) return false;
    if (turn.requestId === basis.requestId) return true;
    if (turn.original !== basis.chain) return false;
    // A turn whose log names no Claude model is the preferred model's, as
    // a rescue judges it.
    if (
      (turn.model ?? current.preferredModel).toLowerCase() !==
      basis.model.toLowerCase()
    )
      return false;
    const failure = await loggedFailure(threadId, turn);
    return failure === null ? null : declineReason(failure, true) === null;
  }

  /**
   * Per thread, the retry chain it was last told to switch to Opus for, by
   * the chain's first request (see loggedTurn, noteAdvice). Kept in memory:
   * after a restart a thread still in error gets one more row.
   */
  const advised = new Map<string, string>();

  /**
   * Marks the turn's chain told; false when it already was (Sol B2-003: by
   * thread and chain, not by attempt). A retry whose chain the log does not
   * name is taken for the chain last told, the likelier case.
   */
  function tellOnce(
    threadId: string,
    chain: string | null,
    requestId: string,
  ): boolean {
    const told = advised.get(threadId);
    if (told !== undefined && (chain === null || told === chain)) return false;
    advised.set(threadId, chain ?? requestId);
    return true;
  }

  /**
   * A thread told to switch to Opus where no move says it (see
   * opusInstead): a history row from its account to the same one. Once
   * per turn sent, retries included: a thread left in error is judged on
   * every refresh, and where an Opus turn would go can change between two
   * (code-reviewer 0.2.20, CR-04), and the turn's retries say nothing new;
   * a new turn gets its own row, also when it is told only at a later
   * attempt (r2, R2-01; Sol B2-003). The log says each one. `turn.chain`:
   * see loggedTurn, read before the judgment checked anything. Only in the
   * thread's generation the judgment began in, as the banner: switched off
   * meanwhile (or a turn of it started, or it was archived), no row, and
   * the chain is not taken for told (code-reviewer r3, N2).
   */
  async function noteAdvice(
    threadId: string,
    projectId: string,
    account: string,
    reason: string,
    turn: { requestId: string; chain: string | null },
    at: number,
    /** The generation of the judgment that tells it (see generation). */
    judgedIn: number,
  ): Promise<void> {
    if (judgedIn !== generation(threadId)) return;
    if (!tellOnce(threadId, turn.chain, turn.requestId)) return;
    await addHistory({
      at,
      threadId,
      projectId,
      from: account,
      to: account,
      reason,
    });
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
   * The way back from an excursion, for a turn in `model`, as decidePlacement
   * takes it: the account the project left for another model; null when it
   * left that account ahead of the limit and it is still at or above that
   * share (see aheadLeft); undefined when there is no excursion or the turn
   * is in another model. Shared by every placement, a new thread's included
   * (Codex BM-INSPECT-R3-003).
   */
  function wayHome(
    projectId: string,
    model: string,
    measured: ReturnType<typeof measuredAccounts>,
    now: number,
  ): string | null | undefined {
    const excursion = excursions.get(projectId);
    if (excursion === undefined || otherModel(model)) return undefined;
    const left = aheadLeft.get(projectId);
    const home = measured.find((a) => a.name === excursion.from);
    return left !== undefined &&
      left.account === excursion.from &&
      home !== undefined &&
      fullestWindow(settle(home, now), left.model).used >= left.threshold
      ? null
      : excursion.from;
  }

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
    const before = moveMark(projectId);
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
    // Read before noteMove, which forgets it on the way home.
    const excursion = excursions.get(projectId);
    const decision = decidePlacement({
      currentAccount: fromName,
      isNew,
      accounts: measured,
      preferredModel: current.preferredModel,
      excursionFrom: wayHome(projectId, current.preferredModel, measured, now),
      freeSeats,
      now,
      currentLoggedOut: unconfirmed(fromName),
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
    if (
      !(await applyAccount(projectId, accountOrDefault(decision.account), latest))
    ) {
      bb.log.info(
        `thread ${thread.id}: not placed (the project's account changed meanwhile)`,
      );
      await markHandled(projectId);
      return;
    }
    await markHandled(projectId);
    noteMove(
      projectId,
      fromName,
      decision.account,
      current.preferredModel,
      before,
    );
    const reason =
      decision.why === "new-project"
        ? `New project placed on account ${decision.account}${current.preferredModel === "" ? "" : ` (${current.preferredModel})`}`
        : decision.why === "back-from-excursion"
          ? `Moved back to account ${decision.account} before the turn: ${fromName} was an excursion for ${excursion?.model ?? "another model"}`
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

  /**
   * The placement of each project under way, from thread.created or from
   * its first message's checkpoint (see placeNewProject): one per project,
   * shared by both (E44).
   */
  const placing = new Map<string, Promise<void>>();
  function placeOnce(thread: ThreadResponse): Promise<void> {
    const under = placing.get(thread.projectId);
    if (under !== undefined) return under;
    const run = placeProject(thread).finally(() => {
      if (placing.get(thread.projectId) === run)
        placing.delete(thread.projectId);
    });
    placing.set(thread.projectId, run);
    return run;
  }
  /**
   * Before a thread's first turn: a project created after install and never
   * placed is placed now, not only when bb announces the thread, which may
   * come after the turn started on the default account (E44: on a machine
   * whose `~/.claude` has no login, that turn fails with «Not logged in»,
   * and so do its retries). A project seen before, or given an account
   * already (here or outside this plugin), is left to placeTurn and
   * thread.created as before.
   */
  async function placeNewProject(thread: ThreadResponse): Promise<void> {
    const projectId = thread.projectId;
    if (installedAt === null || handled.has(projectId)) return;
    const under = placing.get(projectId);
    if (under !== undefined) return under;
    const project = await bb.sdk.projects.get({ projectId });
    if (project.createdAt <= installedAt) return;
    const at = await projectAccount(projectId);
    if (at.owned || at.external) return;
    // In the project's queue, like thread.created's: a pick by hand saved
    // meanwhile runs after it and wins (Astra E44-R2-02). The checkpoint
    // never waits for it longer than DISPATCH_LIMIT_MS, so a retry a
    // handler of the queue sends through bb cannot hold it.
    await inProjectQueue(projectId, () => placeOnce(thread));
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
  /** Either switch-ahead threshold is on. */
  function aheadConfigured(): boolean {
    return (
      current.switchAheadPercent > 0 || current.switchAheadOtherPercent > 0
    );
  }
  /** The switch-ahead threshold for a thread in `model`: the preferred model's, or the other models' when one is set. */
  function aheadThreshold(model: string): number {
    const other =
      current.preferredModel !== "" &&
      model.toLowerCase() !== current.preferredModel.toLowerCase();
    return other ? current.switchAheadOtherPercent : current.switchAheadPercent;
  }

  /**
   * When a turn ends, the project's account may be close to its limit: move
   * the project now, while another account has room, rather than let the
   * next turn fail. Judged on the latest measurement of each account (see
   * measureForAhead for the project's own).
   */
  /**
   * The account each project last left ahead of the limit, with the model
   * and the share that moved it: not a target for that project again while
   * it is still at or above that share. Without it a project with a Fable
   * thread and an Opus thread, each with its own percentage, moved back and
   * forth between two accounts at every turn end (code-reviewer r2).
   */
  const aheadLeft = new Map<
    string,
    { account: string; model: string; threshold: number }
  >();
  /**
   * The accounts a move made while nothing failed may take the project to,
   * its own included. Nothing fails if the project stays, so a target has
   * to be sure: an account listed now, measured within two refresh periods
   * (a query that keeps failing leaves an old measurement), another Claude
   * account (a directory of the same one shares its usage and gains
   * nothing), and not the account the project last left ahead of the limit
   * while it is still at or above that share (see aheadLeft).
   */
  function aheadTargets(
    projectId: string,
    fromName: string,
    model: string,
    now: number,
  ) {
    const maxAgeMs = maxReadAgeMs();
    const own = accounts.find((a) => a.name === fromName);
    const left = aheadLeft.get(projectId);
    return measuredAccounts(model).filter((usage) => {
      if (usage.name === fromName) return true;
      if (
        left !== undefined &&
        usage.name === left.account &&
        fullestWindow(settle(usage, now), left.model).used >= left.threshold
      )
        return false;
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
  }
  async function moveAhead(
    thread: ThreadResponse,
    model: string,
  ): Promise<void> {
    // Asked again: the settings may have changed while the account was measured.
    if (!current.autoSwitch || !aheadConfigured()) return;
    // The threshold is the thread's model's (`model`: read by the caller from
    // bb's log): a thread in the preferred model moves at switchAheadPercent,
    // one sent with another model (Opus while Fable is preferred: it only
    // spends the 5-hour session of a Team seat) at switchAheadOtherPercent.
    // Each can be off on its own.
    const threshold = aheadThreshold(model);
    if (!(threshold > 0)) return;
    const projectId = thread.projectId;
    const before = moveMark(projectId);
    const from = await projectAccount(projectId);
    if (from.external) return;
    const fromName = from.account ?? current.defaultAccountName;
    const now = deps.now();
    const decision = decideAhead({
      currentAccount: fromName,
      accounts: aheadTargets(projectId, fromName, model, now),
      preferredModel: model,
      reserveModel: current.preferredModel,
      threshold,
      freeSeats,
      now,
    });
    if (decision.kind === "keep") return;
    // Moved by something else while the sessions were shared: this
    // decision, taken on the account before, no longer holds.
    if (!(await applyAccount(projectId, accountOrDefault(decision.account), from)))
      return;
    await markHandled(projectId);
    noteMove(projectId, fromName, decision.account, model, before);
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
    aheadLeft.set(projectId, { account: fromName, model, threshold });
  }

  bb.events.on("thread.idle", async ({ thread }) => {
    if (
      !current.autoSwitch ||
      !aheadConfigured() ||
      thread.providerId !== CLAUDE_CODE_PROVIDER ||
      notTheUsersThread(thread) !== null
    )
      return;
    // The threshold is the thread's model's, and the turn that just ended is
    // the truth about it: bb's log names the model of every turn requested,
    // also of the sends that skip the checkpoint (a Send now, an edited
    // message), which the dispatch cache never saw (Codex R0216-INSPECT-001).
    // Read before the account is measured and outside the project's queue:
    // a thread whose model has no percentage costs no query (code-reviewer r1).
    const model =
      (await loggedTurn(thread.id)).model ??
      threadModel.get(thread.id) ??
      current.preferredModel;
    if (!(aheadThreshold(model) > 0)) return;
    // Emptied by a change of the accounts directory, until the next look.
    if (accounts.length === 0) await discover();
    await measureForAhead(thread.projectId);
    await inProjectQueue(thread.projectId, () => moveAhead(thread, model));
  });

  // ---- No project left where a turn cannot run ---------------------------
  /**
   * Why `name` cannot run the preferred model, as measured now: not logged
   * in, or out of it (session, weekly or the model's own window full, or
   * locked) until when; null when it can, or nothing is known of it.
   */
  function stranded(name: string, now: number): string | null {
    if (loggedOut(name)) return "not logged in";
    const known = measuredAccounts().find((a) => a.name === name);
    if (known === undefined || known.unknown === true) return null;
    const settled = settle(known, now);
    const model = current.preferredModel;
    if (isUsable(settled) && canRunModel(settled, model)) return null;
    const full = [
      settled.session,
      settled.weekly,
      modelWindow(settled, model),
    ].filter((w) => w !== undefined && w.usedPercent >= 100);
    const until = Math.max(...full.map((w) => w!.resetsAt ?? 0), 0);
    return `exhausted for ${model === "" ? "every model" : model} until ${until === 0 ? "unknown" : new Date(until).toISOString().slice(0, 16).replace("T", " ")}`;
  }
  /**
   * After every refresh (Aitor 2026-10-30, Añadido 2: «that no project stays
   * on an exhausted account or one without a login without moving by
   * itself, respecting the seats»): bb greys out the composer of a project
   * whose account is at its limit, so the dispatch checkpoint never gets to
   * move it (Mariscal · Web on ganaresenas, Fable at 100 %). Each project
   * this plugin may move (not external) whose account cannot run the
   * preferred model goes to the best account with a free seat, as a
   * placement would choose it, whatever switchAheadPercent says. With none,
   * it stays, said once per project and refresh.
   */
  async function rescueStranded(): Promise<void> {
    if (!current.autoSwitch) return;
    const now = deps.now();
    // Each project read apart, within DISPATCH_LIMIT_MS: one that cannot be
    // read is said and left out, the rest are looked at (Astra
    // SEATS-R3-005).
    const listed = await bb.sdk.projects.list({ includePersonal: true });
    const projects = await Promise.all(
      listed.map(async (p) => {
        const read = await within(
          projectAccount(p.id),
          DISPATCH_LIMIT_MS,
          `project ${p.name}: its account not read to rescue it`,
        );
        if (read === "late")
          bb.log.warn(
            `project ${p.name}: its account not read to rescue it: no answer in time`,
          );
        return typeof read === "object" ? { ...p, ...read.value } : null;
      }),
    );
    for (const project of projects) {
      if (project === null || project.external) continue;
      if (stranded(project.account ?? current.defaultAccountName, now) === null)
        continue;
      // One project that cannot be moved does not keep the rest where they are.
      try {
        await inProjectQueue(project.id, () => rescue(project.id, project.name));
      } catch (error) {
        bb.log.warn(
          `project ${project.name}: not moved off its account: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  async function rescue(projectId: string, projectName: string): Promise<void> {
    if (!current.autoSwitch) return;
    const before = moveMark(projectId);
    // Read again, in the project's queue: the shared list may be 30 s old.
    const from = await projectAccount(projectId);
    if (from.external) return;
    const fromName = from.account ?? current.defaultAccountName;
    const now = deps.now();
    const why = stranded(fromName, now);
    if (why === null) return;
    const model = current.preferredModel;
    const decision = decidePlacement({
      currentAccount: fromName,
      isNew: false,
      accounts: aheadTargets(projectId, fromName, model, now),
      preferredModel: model,
      freeSeats,
      now,
      currentLoggedOut: loggedOut(fromName),
    });
    if (decision.kind === "keep") {
      bb.log.debug(
        `project ${projectName}: left on ${fromName} (${why}): no other account with a free seat can run ${model === "" ? "a turn" : model}`,
      );
      return;
    }
    if (
      !(await applyAccount(projectId, accountOrDefault(decision.account), from))
    )
      return;
    await markHandled(projectId);
    noteMove(projectId, fromName, decision.account, model, before);
    const s = seats.snapshot([seatKey(decision.account)])[
      seatKey(decision.account)
    ]!;
    bb.log.info(
      `project ${projectName}: moved from ${fromName} (${why}) to ${decision.account} (seats ${s.running + s.reserved}/${s.capacity === 0 ? "∞" : s.capacity})`,
    );
    await recordMove(
      {
        at: now,
        threadId: "",
        projectId,
        from: fromName,
        to: decision.account,
        reason: `Moved to account ${decision.account}: ${fromName} ${why}`,
      },
      // No failure caused it: a turn still running on the old account gets
      // the grace retry on the new one, as after a placement.
      null,
    );
  }

  /**
   * The account each thread's turn started on (read when it turned active):
   * a turn that started before its project moved runs on the old account,
   * and its failure, however long after the move, is not the new account's.
   * Null: unknown: the account is still being read, the read failed, or
   * the project moved while it was read (Codex IR14-001, IR15-001/002).
   * That turn's failure is no leftover, its report is nobody's and a
   * refusal marks no account.
   */
  const startedOn = new Map<string, string | null>();
  /** The latest `thread.active` of each thread still reading its account. */
  const starting = new Map<string, number>();
  let starts = 0;
  /**
   * The project's moves (`movesOf().epoch`) when each thread's message was
   * sent, by bb's dispatch checkpoint or by this plugin's own explicit
   * send: bb reads the account as it starts the turn and announces
   * `thread.active` after, so a move completed in between is not where the
   * turn runs (Codex IR16-001). A turn announced with no anchor was sent
   * past both (a queued row sent by hand): where the project stood when it
   * started is unknown (Codex IR17-001).
   */
  const dispatchEpoch = new Map<string, number>();
  /** From here the thread's turn is no leftover of any account. */
  function forgetStart(threadId: string): void {
    startedOn.delete(threadId);
    starting.delete(threadId);
    dispatchEpoch.delete(threadId);
  }
  bb.events.on("thread.active", async ({ thread }) => {
    // A turn of it runs: the advice of its last failure is over.
    adviceOver(thread.id);
    if (
      thread.providerId !== CLAUDE_CODE_PROVIDER ||
      notTheUsersThread(thread) !== null
    )
      return;
    // The previous turn's start is not this turn's, read or still being
    // read (code-reviewer r13).
    const anchor = dispatchEpoch.get(thread.id);
    // The seat this turn's dispatch reserved: where it runs, whatever the
    // read below says if the project moved meanwhile (Astra SEATS-R04).
    const reserved =
      anchor === undefined ? null : (seats.seatOf(thread.id)?.account ?? null);
    // Its seat runs, reserved or not: a turn sent past the checkpoint
    // spends the account all the same. An account set outside this plugin
    // has no seats.
    // Reserved by its dispatch: on the account it reserved (a move since
    // does not take the turn along: Astra SEATS-R04), and at once, before
    // anything is awaited, or the reservation may expire under the read
    // below and its seat go to another (Astra SEATS-R2-002).
    if (reserved !== null) confirmSeat(thread.id, reserved);
    // A new turn: the previous one's pending count is not this one's.
    else unseated.delete(thread.id);
    forgetStart(thread.id);
    const token = ++starts;
    starting.set(thread.id, token);
    // Unknown until read: a failure meanwhile is nobody's (Codex IR15-002).
    startedOn.set(thread.id, null);
    const move = movesOf(thread.projectId);
    const busy = move.inFlight > 0;
    // Within DISPATCH_LIMIT_MS: a read that hangs leaves the turn to be
    // counted by the next refresh, not uncounted for all of it (Astra
    // SEATS-R3-003).
    const read = await within(
      projectAccount(thread.projectId),
      DISPATCH_LIMIT_MS,
      `thread ${thread.id}: its project's account not read as its turn started`,
    );
    const seat = typeof read === "object" ? seatFor(read.value) : undefined;
    // Unknown (null) also on an account not among the ones found: never
    // the default's (Astra SEATS-R3-001).
    let account: string | null | undefined =
      seat === null ? undefined : typeof seat === "string" ? seat : null;
    // The turn ended, or a newer one started, while the account was read:
    // what that said stands, not this stale read (code-reviewer r12).
    if (starting.get(thread.id) !== token) return;
    forgetStart(thread.id);
    // Not reserved: where the read says. Not read: on a seat it holds, else
    // counted by the next refresh (Astra SEATS-R3-003). On an account not
    // found: on nobody's (Astra SEATS-R3-001).
    if (reserved === null) {
      if (typeof seat === "string") confirmSeat(thread.id, seatKey(seat));
      else if (seat === UNKNOWN_SEAT)
        bb.log.debug(
          `thread ${thread.id}: no seat counted: its project's account is not among the accounts found`,
        );
      else if (seat === undefined) {
        const held = seats.seatOf(thread.id)?.account;
        if (held !== undefined) confirmSeat(thread.id, held);
        else {
          unseated.set(thread.id, thread.projectId);
          bb.log.info(
            `thread ${thread.id}: its seat is counted on the next refresh (its project's account was not read)`,
          );
        }
      }
    }
    // The project was being moved, or moved, since the turn was sent or
    // while its account was read: the read says where the project is (or
    // was) going, not where the turn started. Unknown, rather than the new
    // account's; unknown too with no anchor to compare against.
    if (
      account !== undefined &&
      (anchor === undefined ||
        busy ||
        move.inFlight > 0 ||
        move.epoch !== anchor)
    )
      account = null;
    if (account === null)
      bb.log.debug(
        `thread ${thread.id}: where its turn started is unknown (sent past the dispatch checkpoint, the project moved, or its account could not be read)`,
      );
    if (account !== undefined) startedOn.set(thread.id, account);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    // Its turn ended there: a later failure that no new `thread.active`
    // announces (a turn refused at the door) is the project's account's,
    // not a leftover of the account this turn ran on (code-reviewer r11).
    forgetStart(thread.id);
    // Reserved too: a turn that ended needs none (its next asks again,
    // and one that starts unannounced is counted as it starts).
    releaseSeat(thread.id, "its turn ended");
  });
  /** The thread archived or deleted: nothing of its turns runs again, and what is kept for it goes. */
  async function threadGone({ thread }: { thread: ThreadResponse }) {
    forgetStart(thread.id);
    releaseSeat(thread.id, "the thread is gone");
    seatReadWaits.delete(thread.id);
    startWaits.delete(thread.id);
    threadModel.delete(thread.id);
    adviceOver(thread.id);
    // Forgotten in storage too, or the stored list only grows (Codex r8,
    // IR8-004).
    if (cancelled.delete(thread.id)) await storeCancelled(thread.id);
  }
  bb.events.on("thread.archived", threadGone);
  // Deleted (bb deletes softly): as archived (code-reviewer r5, CR-2).
  bb.events.on("thread.deleted", threadGone);

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
    await inProjectQueue(thread.projectId, () => placeOnce(thread));
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
   * What bb's log says of the thread's latest message, for a thread whose
   * sending this plugin did not see (it was reloaded or restarted since: a
   * long turn outlives both), or of a failed turn (`failed`), in one read
   * (code-reviewer r4, L3):
   *  - `model`: the model it was sent with; null when the log cannot be
   *    read or names no Claude model: the preferred model decides then;
   *  - `chain`, for a failed turn: the first request of its retry chain,
   *    as bb keys its retries (see latestTurn): the turn's own at its first
   *    attempt, else the one its row names (a retry's failure reports the
   *    retry's own request); null when the log does not say (unreadable, or
   *    the request not among its latest rows).
   */
  async function loggedTurn(
    threadId: string,
    failed?: { requestId: string; attemptNumber: number },
  ): Promise<{ model: string | null; chain: string | null }> {
    const first =
      failed !== undefined && failed.attemptNumber <= 1
        ? failed.requestId
        : null;
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: failed === undefined ? "1" : "20",
      });
      const requested = rows.flatMap((r) =>
        r.type === "client/turn/requested" ? [r.data] : [],
      );
      // A failed turn is judged by what that very turn was sent with (its
      // request id), not by the latest message: the latest may be a newer
      // turn in another model (code-reviewer r2). A turn the log does not
      // name (an older id, or none) is judged by the latest message.
      const own =
        failed === undefined
          ? undefined
          : requested.find((r) => r.requestId === failed.requestId);
      return {
        model: modelFamily((own ?? requested[0])?.execution?.model ?? null),
        chain: first ?? own?.retryOfRequestId ?? own?.requestId ?? null,
      };
    } catch (error) {
      bb.log.warn(
        `thread ${threadId}: its ${failed === undefined ? "model" : "turn's model and retry chain"} not read from bb: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { model: null, chain: first };
    }
  }
  /** A thread in one of these has a turn under way: a message sent then waits in bb's queue. */
  const TURN_UNDER_WAY: ReadonlySet<string> = new Set([
    "starting",
    "active",
    "stopping",
  ]);
  /**
   * What the placement before a turn in `model` of the project decides on,
   * but the account the project sits on (see decidePlacement): placeTurn's,
   * and the Opus advice's, which names where an Opus turn would run (Sol
   * B2-002; fix-B2-r3: one function, the same numbers).
   */
  function placementOf(
    projectId: string,
    model: string,
    now: number,
  ): Omit<PlacementInput, "currentAccount"> {
    const measured = measuredAccounts(model);
    return {
      isNew: false,
      accounts: measured,
      preferredModel: model,
      reserveModel: current.preferredModel,
      excursionFrom: wayHome(projectId, model, measured, now),
      freeSeats,
      now,
    };
  }
  /**
   * Before a turn starts: when the project's account is MEASURED unable to
   * run the model the turn is sent with and another account can, the project
   * moves there first. The preferred model does not decide here: a thread
   * the user switched to Opus runs on an account with Opus left even when
   * every account is out of the preferred one. `turn.abandoned` is set when
   * the checkpoint stopped waiting: nothing is moved after that.
   * Resolves to the account the turn runs on (`byDefault`: no variable, the
   * machine's own `~/.claude`), "external" for a variable not set by this
   * plugin, or null when the checkpoint stopped waiting.
   */
  async function placeTurn(
    thread: ThreadResponse,
    model: string,
    turn: { abandoned: boolean },
  ): Promise<TurnPlace | null> {
    const projectId = thread.projectId;
    // Emptied by a change of the accounts directory, until the next look.
    if (accounts.length === 0) await discover();
    const before = moveMark(projectId);
    // Taken before the read: the seat is reserved only while the project's
    // account has not been written since (Astra SEATS-R3-002).
    const writes = movesOf(projectId).writes;
    const from = await projectAccount(projectId);
    if (from.external) return "external";
    // An account it names that is not among the ones found: not judged as
    // the default; the dispatch looks for it again (Astra SEATS-R3-001).
    if (seatFor(from) === UNKNOWN_SEAT) return "unknown";
    const fromName = from.account ?? current.defaultAccountName;
    const now = deps.now();
    const excursion = excursions.get(projectId);
    const decision = decidePlacement({
      ...placementOf(projectId, model, now),
      currentAccount: fromName,
      currentLoggedOut: unconfirmed(fromName),
    });
    if (decision.kind === "keep") {
      // The turn runs where the project is (refused at the checkpoint only
      // when that is the default account and it has no login).
      if (decision.why === "current-reserved")
        bb.log.info(
          `thread ${thread.id}: ${model} turn stays on ${fromName}: no account spares ${current.preferredModel}`,
        );
      return { account: fromName, byDefault: !from.owned, writes };
    }
    if (turn.abandoned) return null;
    const to = accountOrDefault(decision.account);
    // The sessions are not waited for: see applyAccount (Fable, 2026-10-29).
    await applyAccount(projectId, to, from, { share: false });
    await markHandled(projectId);
    noteMove(projectId, fromName, decision.account, model, before);
    const reason =
      decision.why === "back-from-excursion"
        ? `Moved back to account ${decision.account} before the turn: ${fromName} was an excursion for ${excursion?.model ?? "another model"}`
        : `Moved to account ${decision.account} before the turn: ${fromName} ${whyOut(fromName, model)}`;
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
    return {
      account: decision.account,
      byDefault: to === null,
      // Its own write (counted as it starts and once it is over) and no
      // other.
      writes: writes + (decision.account === fromName ? 0 : 2),
    };
  }

  // bb holds every message it asks about on this answer and fails the
  // attempt when a handler throws or takes 10 s: it decides on the
  // measurements already there and stays out of the project's queue (a
  // retry sent from that queue passes through here). A placement that has
  // not finished after DISPATCH_LIMIT_MS is given up. Two exceptions
  // (E44): a new project's first placement, which its message waits for;
  // and a turn that would start on a default account without a login,
  // which waits while anything that could give the project an account is
  // under way or failed (a placement, a write, a measure of the accounts),
  // and is refused, with the command that fixes it, when nothing can.
  /** Waits asked per thread before its turn could start (see MAX_START_WAITS). */
  const startWaits = new Map<string, number>();
  /** A measure of every account started for a waiting turn, shared while it runs. */
  let measuring: Promise<void> | null = null;
  function measureForStart(): Promise<void> {
    measuring ??= refreshAll()
      .catch((error: unknown) =>
        bb.log.warn(
          `the accounts not measured for a waiting turn: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        measuring = null;
      });
    return measuring;
  }
  /**
   * The thread's message waits until FIRST_PLACEMENT_WAIT_MS from now, and
   * bb is asked again as soon as `pending` ends, when there is one. Null
   * once the thread has waited MAX_START_WAITS times.
   */
  function startWait(
    threadId: string,
    pending: Promise<unknown> | null,
    reason: string,
  ): MessageDispatchHookDecision | null {
    const waited = startWaits.get(threadId) ?? 0;
    if (waited >= MAX_START_WAITS) return null;
    startWaits.set(threadId, waited + 1);
    if (pending !== null)
      void pending
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => bb.experimental_hooks.recheck("message.dispatch"))
        .catch((error: unknown) =>
          bb.log.warn(
            `thread ${threadId}: bb not asked again after what its message waits for: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    bb.log.info(`thread ${threadId}: its message waits (${reason})`);
    return {
      action: "wait",
      reason,
      sendAt: deps.now() + FIRST_PLACEMENT_WAIT_MS,
    };
  }
  /** `work` within `ms`: its value, "late" (after `onLate`), or "failed" (logged as `what`). */
  async function within<T>(
    work: Promise<T>,
    ms: number,
    what: string,
    onLate?: () => void,
  ): Promise<{ value: T } | "late" | "failed"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then((value) => ({ value })),
        new Promise<"late">((resolve) => {
          timer = setTimeout(() => {
            onLate?.();
            resolve("late");
          }, ms);
        }),
      ]);
    } catch (error) {
      bb.log.warn(
        `${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Before a turn starts, with the automatic choice on: what bb should do
   * with the message; null = send it.
   */
  async function beforeStart(
    thread: ThreadResponse,
    model: string | null,
    /** Set to where the turn was placed, when the placement said. */
    turnAt: { at?: TurnPlace },
  ): Promise<MessageDispatchHookDecision | null> {
    const first = placeNewProject(thread);
    const placed = await within(
      first,
      DISPATCH_LIMIT_MS,
      `thread ${thread.id}: its new project not placed before its first turn`,
    );
    if (placed === "late") {
      const wait = startWait(
        thread.id,
        first,
        "Choosing a Claude account for this new project",
      );
      if (wait !== null) return wait;
    }
    // A message whose model bb does not name as a Claude model is placed
    // for the preferred one when the default has no login: it must run
    // somewhere else whatever its model (Astra E44-R1).
    const turnModel =
      model ??
      (unconfirmed(current.defaultAccountName) ? current.preferredModel : null);
    const turn = { abandoned: false };
    const turnPlaced =
      turnModel === null
        ? null
        : within(
            placeTurn(thread, turnModel, turn),
            DISPATCH_LIMIT_MS,
            `thread ${thread.id}: not placed before its turn`,
            () => {
              turn.abandoned = true;
            },
          );
    // Never measured (the plugin has just loaded): the default's login is
    // looked at meanwhile, within the same time, so no turn is sent where
    // it has none (Astra E44-R3); found missing, the placement above may not
    // have known it: the message waits below and is placed again. With no
    // login no network is asked: the look is local.
    // The default is `~/.claude` whatever the accounts directory holds: it
    // is looked at without reading that directory, which may fail.
    let look: Promise<unknown> | null = null;
    if (defaultLogin() === "unknown") {
      look = collector.collect(
        accounts.find((a) => a.name === current.defaultAccountName) ?? {
          name: current.defaultAccountName,
          configDir: null,
          email: null,
          accountUuid: null,
        },
      );
      await within(
        look,
        DISPATCH_LIMIT_MS,
        `thread ${thread.id}: the default account's login not looked at`,
      );
    }
    const done = turnPlaced === null ? null : await turnPlaced;
    const where: TurnPlace | null =
      typeof done === "object" && done !== null ? done.value : null;
    if (where !== null) turnAt.at = where;
    const login = defaultLogin();
    if (login === "yes") return null;
    if (
      where === "external" ||
      where === "unknown" ||
      (where !== null && !where.byDefault)
    )
      return null;
    // Not known where because the placement failed or was not tried (a
    // model bb does not name): a project with a variable of its own, or one
    // set outside this plugin, runs on it whatever the accounts directory
    // says; bb passes the value it holds (Astra E44-R3-02). Read apart from
    // the placement, which needs that directory and a model. Not when the
    // placement took too long: bb is slow, and the wait below covers it.
    if (where === null && done !== "late") {
      const own = await within(
        projectAccount(thread.projectId),
        DISPATCH_LIMIT_MS,
        `thread ${thread.id}: the project's account not read before its turn`,
      );
      if (typeof own === "object" && (own.value.owned || own.value.external)) {
        bb.log.warn(
          `thread ${thread.id}: not placed before its turn; it runs on the project's own CLAUDE_CONFIG_DIR`,
        );
        return null;
      }
    }
    // On the default account without a login, or not known where (a write
    // or a read failed or took too long: Astra E44-R2). What is under way
    // and could give the project an account is waited for; failed, it is
    // tried again on the next attempt.
    // Nothing is started for a message that can no longer wait (R2-04).
    const canWait = (startWaits.get(thread.id) ?? 0) < MAX_START_WAITS;
    const pending =
      placing.get(thread.projectId) ??
      (login === "unknown" ? look : null) ??
      (canWait && unreadAccounts().length > 0 ? measureForStart() : null);
    if (pending !== null || where === null || login === "unknown") {
      const wait = startWait(
        thread.id,
        pending,
        "Looking for a Claude account with a login for this project",
      );
      if (wait !== null) return wait;
    }
    const why =
      login === "no"
        ? "has no login"
        : "has a login that could not be checked";
    bb.log.warn(
      `thread ${thread.id}: refused: no account for project ${thread.projectId} and ${current.defaultAccountName} ${why}`,
    );
    return {
      action: "reject",
      message: `Claude Switcher: no account assigned to this project and the default account (${current.defaultAccountName}) ${why}. Assign one with: bb claude-switcher use ${thread.projectId} <account>`,
    };
  }

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const { thread } = ctx;
    if (
      // Queued behind a turn: bb asks again when it sends the message.
      TURN_UNDER_WAY.has(thread.status) ||
      thread.providerId !== CLAUDE_CODE_PROVIDER ||
      notTheUsersThread(thread) !== null
    )
      return { action: "proceed" };
    // Seats not yet counted after a load: no turn is let in against an
    // empty count (Astra SEATS-R02).
    if (ctx.attempt === "start-turn" && !seatsReady) {
      await within(
        seatsCounted,
        DISPATCH_LIMIT_MS,
        `thread ${thread.id}: the seats not counted before its turn`,
      );
      if (!seatsReady) {
        seatsAwaited = true;
        bb.log.info(`thread ${thread.id}: its message waits (seats are being counted)`);
        return {
          action: "wait",
          reason: "Claude Switcher: seats are being counted after a reload",
          sendAt: deps.now() + SEATS_COUNTING_WAIT_MS,
        };
      }
    }
    const model = modelFamily(ctx.requestedExecution.model);
    if (model !== null) threadModel.set(thread.id, model);
    const placed: { at?: TurnPlace } = {};
    if (current.autoSwitch && ctx.attempt === "start-turn") {
      // A message sent now, not a queued one asked again: its own waits
      // (Astra E44-R2-03).
      if (ctx.queuedMessages.length === 0) startWaits.delete(thread.id);
      const decision = await beforeStart(thread, model, placed);
      if (decision !== null) {
        if (decision.action === "reject") startWaits.delete(thread.id);
        return decision;
      }
      startWaits.delete(thread.id);
    }
    // A seat on the account the turn starts on, last: placed, the project
    // stays where it is, and a full account makes the thread wait there.
    // Not a turn under way joined, nor an account set outside this plugin.
    if (ctx.attempt === "start-turn") {
      // A message sent now, not a queued one asked again: its own waits
      // (Astra SEATS-R2-005).
      if (ctx.queuedMessages.length === 0) seatReadWaits.delete(thread.id);
      const move = movesOf(thread.projectId);
      /**
       * The project's account not written since `writes`, nor being
       * written: a move still sharing its sessions has not changed it yet.
       */
      const still = (writes: number) =>
        move.writing === 0 && move.writes === writes;
      // Where the turn starts, and the project's moves it holds for (null:
      // an account set outside this plugin, which has no seats).
      let at: { account: string | null; writes: number } | null = null;
      // Placed, and the project not moved since: where the placement left
      // it. Moved meanwhile (a pick, a rescue, while the placement recorded
      // its move), it is read again (Astra SEATS-R3-002).
      if (placed.at === "external") at = { account: null, writes: move.writes };
      else if (
        placed.at !== undefined &&
        placed.at !== "unknown" &&
        still(placed.at.writes)
      )
        at = { account: placed.at.account, writes: placed.at.writes };
      else {
        // Not placed (the automatic choice off, a model bb does not name, a
        // placement that failed or took too long), placed on an account not
        // found, or moved since: the account is the project's, read apart
        // from the model (Astra SEATS-R01). One it names that is not among
        // the accounts found (none are, after the directory or the default
        // is renamed) is looked for again; still not found, it is not read,
        // never the default's (Astra SEATS-R2-003, SEATS-R3-001). A read a
        // move crossed is made again, once (Astra SEATS-R3-002).
        const seatAccount = async (): Promise<{
          account: string | null;
          writes: number;
        }> => {
          for (let tries = 0; ; tries += 1) {
            let writes = move.writes;
            let read = await projectAccount(thread.projectId);
            if (seatFor(read) === UNKNOWN_SEAT && accounts.length === 0) {
              await discover();
              writes = move.writes;
              read = await projectAccount(thread.projectId);
            }
            const seat = seatFor(read);
            if (seat === UNKNOWN_SEAT)
              throw new Error(
                "the account it names is not among the accounts found",
              );
            if (still(writes)) return { account: seat, writes };
            if (tries >= 1) throw new Error("the project moved while it was read");
          }
        };
        const read = await within(
          seatAccount(),
          DISPATCH_LIMIT_MS,
          `thread ${thread.id}: the project's account not read for its seat`,
        );
        if (typeof read === "object") at = read.value;
      }
      // Checked last, with nothing awaited till the seat is reserved: the
      // project moved after it was read is read again (Astra SEATS-R3-002).
      if (at !== null && at.account !== null && !still(at.writes)) at = null;
      if (at === null) {
        // Unknown where it starts: it waits, and is asked again, a few
        // times; then it goes, as every wait of this plugin does, for bb
        // is never left holding a message (see MAX_START_WAITS).
        const waited = seatReadWaits.get(thread.id) ?? 0;
        if (waited < SEAT_READ_WAITS) {
          seatReadWaits.set(thread.id, waited + 1);
          return {
            action: "wait",
            reason:
              "Claude Switcher: the project's account could not be read for its seat; trying again",
            sendAt: deps.now() + SEAT_RECHECK_MS,
          };
        }
        bb.log.warn(
          `thread ${thread.id}: proceeds without a seat: its project's account could not be read ${waited + 1} times`,
        );
      }
      seatReadWaits.delete(thread.id);
      if (at !== null && at.account !== null) {
        const wait = seatWait(thread, at.account);
        if (wait !== null) return wait;
      }
    }
    // Where the project stands as the turn is sent, for `thread.active`.
    dispatchEpoch.set(thread.id, movesOf(thread.projectId).epoch);
    return { action: "proceed" };
  });

  // ---- Automatic switch on subscription limit ---------------------------
  /** `name` refused a turn (no login): chosen for nothing for a while. */
  function markRefused(
    name: string,
    now: number,
    event: PluginTurnFailedEvent,
  ): void {
    refusedAt.set(name, now);
    bb.log.warn(
      `account ${name} refused a turn (HTTP ${event.errorInfo?.httpStatusCode ?? "?"}): chosen for nothing for ${REFUSAL_MS / 3_600_000} h`,
    );
  }

  /**
   * `started`: the account the failed turn started on; null when unknown
   * (see `startedOn`), undefined when no start was recorded.
   */
  async function handleFailure(
    event: PluginTurnFailedEvent,
    projectId: string,
    started: string | null | undefined,
    /** The thread's generation as its failure came (see generation). */
    judgedIn: number,
  ): Promise<void> {
    const now = deps.now();
    // The log first, for the turn that failed: a Send now or an edited
    // message skips the checkpoint and the cache still names the model of
    // the message before it (code-reviewer r2, same hole as thread.idle).
    // Read before the shortcuts below: a leftover is not retried on an
    // account reserved for the preferred model (Codex BM-R1-001).
    // With its retry chain, for the Opus advice, in the same read: before
    // anything below is checked or marked, so no read waits between those
    // checks and a move (Sol B2-R3-005; code-reviewer r4, L3).
    const logged = await loggedTurn(event.threadId, event);
    const model =
      logged.model ?? threadModel.get(event.threadId) ?? current.preferredModel;
    const turn = { requestId: event.requestId, chain: logged.chain };
    const recent = recentSwitches.get(projectId);
    // Where the project is now: a leftover follows the recorded move only
    // while the project still sits where that move put it and no move is
    // under way. placeTurn runs outside the project's queue: a move landed
    // but not yet recorded would have the turn retried "on" an account the
    // variable no longer names (Codex BM-INSPECT-002).
    const at = await projectAccount(projectId);
    const currentName = at.account ?? current.defaultAccountName;
    const settled = !at.external && movesOf(projectId).inFlight === 0;
    if (
      recent !== undefined &&
      settled &&
      currentName === recent.to &&
      now - recent.at <= SWITCH_GRACE_MS &&
      recent.threadId !== event.threadId &&
      !recent.graced.has(event.threadId) &&
      // Started on the account the project moved to: no leftover, that
      // account's failure, judged below (code-reviewer r14). Started on an
      // account unknown: judged below too, on the measurements (IR15-004).
      started !== null &&
      // Unless the move was a wait: the account is out until its reset,
      // whatever the leftover's turn ran on (code-reviewer r15).
      (started !== recent.to || recent.sendAt !== undefined) &&
      // Measured since as unable to run a turn (a wait keeps its grace:
      // the account is out by definition until its reset): judged below.
      (recent.sendAt !== undefined || !cannotRun(recent.to)) &&
      // Or keeping the preferred model's weekly, which this turn's model
      // would spend when the retry is sent: judged below, where the rule
      // applies.
      !reservedFor(recent.to, model, recent.sendAt ?? now)
    ) {
      // Another thread of the project, still running on the old account
      // (whatever its attempt: a leftover can be a retry too): the project
      // has already moved, so its turn only needs to run again, or to wait
      // for the same reset. Once per thread: a second failure in the window
      // means the new account fails as well, and is judged below.
      recent.graced.add(event.threadId);
      if (typeof started === "string" && isRefusal(event))
        markRefused(started, now, event);
      const told = followsAdvice(recent, model, now, event, started, projectId);
      const reason = `Retrying on account ${recent.to}${told === null ? "" : `. ${told}`}`;
      bb.log.info(
        `thread ${event.threadId}: ${reason} (switched ${now - recent.at} ms ago)`,
      );
      if (told !== null)
        await noteAdvice(event.threadId, projectId, recent.to, reason, turn, now, judgedIn);
      // Its queued retry says it now, or nothing is to be said.
      judgedAdvice(event.threadId, null, judgedIn, null);
      // The advice too only while the judgment's generation holds, as its
      // row (code-reviewer r5, nit 1), asked as the retry is queued, after
      // the waits on the queue (Sol B2-R6-004).
      await retryTurn(
        event,
        () =>
          judgedIn === generation(event.threadId)
            ? reason
            : `Retrying on account ${recent.to}`,
        recent.sendAt,
      );
      return;
    }
    if (typeof started === "string") {
      const sendAt =
        recent !== undefined &&
        recent.to === currentName &&
        recent.sendAt !== undefined &&
        recent.sendAt > now
          ? recent.sendAt
          : undefined;
      if (
        !at.external &&
        started !== currentName &&
        !cannotRun(currentName) &&
        !reservedFor(currentName, model, sendAt ?? now)
      ) {
        // Started on the old account before the project moved: a leftover
        // (a long tool call can outlast the grace window), not a failure of
        // the project's account. It runs again there, or waits for the same
        // reset when the project's latest move was a wait on that account.
        // Unless the project's account cannot run it either (a hand pick of
        // an account without a login, or out), or keeps the preferred
        // model's weekly for this turn's model: then it is judged below.
        // Its refusal is the old account's, wherever it runs again.
        if (isRefusal(event)) markRefused(started, now, event);
        const told =
          sendAt === undefined || recent === undefined
            ? null
            : followsAdvice(recent, model, now, event, started, projectId);
        const reason = `Retrying on account ${currentName}${told === null ? "" : `. ${told}`}`;
        bb.log.info(
          `thread ${event.threadId}: ${reason} (its turn started on ${started})`,
        );
        if (told !== null)
          await noteAdvice(event.threadId, projectId, currentName, reason, turn, now, judgedIn);
        judgedAdvice(event.threadId, null, judgedIn, null);
        await retryTurn(
          event,
          () =>
            judgedIn === generation(event.threadId)
              ? reason
              : `Retrying on account ${currentName}`,
          sendAt,
        );
        return;
      }
    }
    await refreshAll();
    const before = moveMark(projectId);
    const from = await projectAccount(projectId);
    if (from.external) {
      bb.log.info(
        `thread ${event.threadId}: no switch (${ENV_VAR} on project ${projectId} was set outside this plugin)`,
      );
      return;
    }
    // On the clock after those reads: a window that reset meanwhile has
    // reset (Codex BM-INSPECT-003).
    await judge(
      event,
      projectId,
      from,
      model,
      deps.now(),
      false,
      before,
      judgedIn,
      turn.chain,
      started,
    );
  }

  /**
   * Retries the user cancelled by hand (from bb's queued card or `bb thread
   * queue`), per thread: the thread's latest turn at the time (a turn the
   * user then retries by hand, and fails, is a new one: judged). bb's only
   * word of that removal is `message.cancelled`, which this plugin's own
   * deletions fire too (`ownDeletes` tells them apart). The rescue leaves
   * such a thread alone until a new turn of it (Codex r7, IR7-004). Kept
   * in storage: a restart must not turn a cancellation into an abandoned
   * thread.
   */
  bb.events.on("message.cancelled", async ({ entry }) => {
    // The message that waited for its account to be read is gone: the
    // next one waits on its own count (Astra SEATS-R2-005).
    seatReadWaits.delete(entry.threadId);
    const own = ownDeletes.get(entry.id);
    if (own !== undefined) {
      if (own.done) ownDeletes.delete(entry.id);
      else own.held = entry;
      return;
    }
    await leaveSeatQueue(entry.threadId);
    await cancelledByHand(entry);
  });

  /**
   * The user cancelled the thread's last message waiting for a seat: its
   * place in the queue, or the seat reserved for it, goes to the next in
   * line (Astra SEATS-R3-004). Not while another message of it is queued,
   * nor a seat whose turn runs; unread, the reservation expires on its own.
   */
  async function leaveSeatQueue(threadId: string): Promise<void> {
    const seat = seats.seatOf(threadId);
    if (seat?.state === "running") return;
    if (seat === null && seats.position(threadId) === null) return;
    const rows = await within(
      bb.sdk.threads.queuedMessages.list({ threadId }),
      DISPATCH_LIMIT_MS,
      `thread ${threadId}: its queued messages not read after a cancellation`,
    );
    if (typeof rows !== "object" || rows.value.length > 0) return;
    // A turn of it started meanwhile keeps its seat.
    if (seats.seatOf(threadId)?.state === "running") return;
    releaseSeat(threadId, "its waiting message was cancelled");
  }

  async function cancelledByHand(entry: CancelledEntry): Promise<void> {
    if (entry.payload.kind !== "retry") return;
    let turn: Awaited<ReturnType<typeof latestTurn>>;
    let archived: boolean;
    try {
      turn = await latestTurn(entry.threadId);
      archived =
        (await bb.sdk.threads.get({ threadId: entry.threadId })).archivedAt !==
        null;
    } catch (error) {
      // Without the turn, the mark cannot be keyed: the thread is judged
      // again (the user can cancel again) rather than left for dead.
      bb.log.warn(
        `thread ${entry.threadId}: its queued retry was cancelled by hand, but its latest turn could not be read (${error instanceof Error ? error.message : String(error)}); judged again on the next refresh`,
      );
      return;
    }
    // Of an earlier turn's chain (a message sent by hand since made a new
    // turn, which the rescue judges on its own), or of a thread archived
    // meanwhile (its mark would outlive it in storage): nothing to mark.
    if (
      turn === null ||
      turn.original !== entry.payload.retryOfTurnRequestId ||
      archived
    )
      return;
    cancelled.set(entry.threadId, turn.requestId);
    bb.log.info(
      `thread ${entry.threadId}: its queued retry was cancelled by hand; not judged again until a new turn of it`,
    );
    await storeCancelled(entry.threadId);
  }

  /**
   * Removes a queued row of this plugin's own; throws as bb's delete does.
   * bb's cancellation for it is this plugin's own, whenever it comes,
   * unless the removal fails: the row was gone before, so a cancellation
   * come meanwhile was the user's.
   */
  async function deleteOwn(threadId: string, id: string): Promise<void> {
    const own = { done: false, held: null as CancelledEntry | null };
    ownDeletes.set(id, own);
    try {
      await bb.sdk.threads.queuedMessages.delete({
        threadId,
        queuedMessageId: id,
      });
    } catch (error) {
      ownDeletes.delete(id);
      if (own.held !== null) await cancelledByHand(own.held);
      throw error;
    }
    if (own.held !== null) ownDeletes.delete(id);
    else own.done = true;
  }

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
   * `rescueStuck`), not on its failure. `ranOn`: the account the turn ran
   * on when it is not the project's (a leftover the project's account cannot
   * run either): the failure, its report and a refusal are that account's.
   * Null: unknown (see `startedOn`): the report is nobody's, no account is
   * marked and the measurements decide.
   */
  async function judge(
    event: PluginTurnFailedEvent,
    projectId: string,
    from: ProjectAccount,
    model: string,
    now: number,
    stuck: boolean,
    /** The project's moves and picks before `from` was read (see noteMove). */
    before: MoveMark,
    /** The thread's generation as the judgment began (see generation). */
    judgedIn: number,
    /** The turn's retry chain (see loggedTurn), read before the judgment began. */
    chain: string | null,
    ranOn?: string | null,
  ): Promise<void> {
    const turn = { requestId: event.requestId, chain };
    const fromName = from.account ?? current.defaultAccountName;
    const failedOn = ranOn === undefined ? fromName : ranOn;
    const refusal = isRefusal(event);
    if (refusal && !stuck && failedOn !== null) {
      markRefused(failedOn, now, event);
    } else if (refusal && !stuck) {
      bb.log.info(
        `thread ${event.threadId}: refused by an account unknown (where its turn started could not be read); none marked`,
      );
      // No account marked, the retry may be refused the same way: this
      // failure gets MAX_ATTEMPTS like any other, then the thread is left
      // in error for the rescue to judge (Codex IR16-002).
      if (event.attemptNumber >= MAX_ATTEMPTS) {
        bb.log.info(
          `thread ${event.threadId}: no switch (every retry spent on refusals by an account unknown; judged again on the next refresh)`,
        );
        return;
      }
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
    const input = {
      failure: event,
      currentAccount: fromName,
      failedAccount: failedOn,
      accounts: measuredAccounts(model),
      preferredModel: model,
      reserveModel: current.preferredModel,
      maximumWaitMs:
        current.maximumWaitHours > 0
          ? current.maximumWaitHours * 3_600_000
          : null,
      now,
      random: deps.random(),
      stuck,
      freeSeats,
    };
    const decision = decideSwitch(input);
    // No Fable on any account, and an account with Opus: the thread is told
    // to switch (D3), whatever the decision's reason, naming where the
    // dispatch would run its Opus turn (Sol B2-002: the same placement).
    const opusOn = opusInstead(
      decision,
      input,
      unreadAccounts(),
      placementOf(projectId, FALLBACK_MODEL, now),
    );
    const advice = opusOn === null ? null : opusInsteadText(model, opusOn);
    const carried = advice === null ? undefined : { model };
    const how = stuck ? "left in error: " : "";
    // The thread shows the advice where nothing queued carries it: a
    // decline (Sol B2-004), asked again after every refresh (Sol
    // B2-R4-001). Any other judgment takes it away. Unless a turn of it
    // started, it was archived or the automatic choice was switched off
    // while this one read (Sol B2-R2-003).
    // A basis only for a decline that can tell it (Sol B2-R5-003).
    judgedAdvice(
      event.threadId,
      decision.kind === "decline" ? advice : null,
      judgedIn,
      decision.kind === "decline" &&
        mayAdviseOpus(decision, model, current.preferredModel)
        ? {
            projectId,
            model,
            decision,
            requestId: event.requestId,
            chain,
            at: now,
          }
        : null,
    );
    if (decision.kind === "decline") {
      // The account the project sits on is no good either: a leftover
      // thread must be judged too, not retried there at once.
      recentSwitches.delete(projectId);
      bb.log.info(
        `thread ${event.threadId}: ${how}no switch (${decision.reason})${advice === null ? "" : `; ${advice}`}`,
      );
      // No retry of ours carries it (bb's provider-retry row, if any, is
      // left as it is; a rescue queues none): the history and the log say it.
      // Switched off meanwhile, noteAdvice writes nothing: the judgment's
      // generation ended (code-reviewer r4, N2).
      if (advice !== null)
        await noteAdvice(event.threadId, projectId, fromName, advice, turn, now, judgedIn);
      return;
    }
    const reason =
      decision.kind === "switch"
        ? `Switched to account ${decision.account}${decision.model === null ? "" : ` (${decision.model})`}${refusal && failedOn !== null ? `: ${failedOn} refused the turn` : ""}`
        : decision.kind === "retry"
          ? `Retrying on account ${decision.account}${decision.model === null ? "" : ` (${decision.model})`}: it has room now`
          : advice === null
            ? decision.reason
            : `${decision.reason}. ${advice}`;
    const sendAt = decision.kind === "wait" ? decision.sendAt : undefined;
    // A rescue runs between reads: switched off meanwhile, it stops before
    // moving and before retrying (Codex r6, IR6-006).
    if (stuck && !current.autoSwitch) return;
    if (decision.account !== fromName) {
      if (
        !(await applyAccount(projectId, accountOrDefault(decision.account), from))
      ) {
        // Moved by a placement before a turn while the sessions were shared:
        // that move, decided later, stands. Nothing is recorded; the turn is
        // retried at once where the project is now (it is judged again if
        // it fails there).
        bb.log.info(
          `thread ${event.threadId}: ${how}not moved to ${decision.account} (the project's account changed meanwhile); retried where the project is now`,
        );
        await retryTurn(
          event,
          "Retrying: the project's account changed meanwhile",
          undefined,
          stuck,
        );
        return;
      }
      noteMove(projectId, fromName, decision.account, model, before);
      await recordMove(
        {
          at: now,
          threadId: event.threadId,
          projectId,
          from: fromName,
          to: decision.account,
          // The move's own reason: a wait's without the advice.
          reason: decision.kind === "wait" ? decision.reason : reason,
        },
        event.threadId,
        sendAt,
        carried,
        // Its history row tells the turn once per chain (Sol B2-003: a
        // retry of a turn told already records its move alone), and only in
        // the thread's generation the judgment began in, as noteAdvice:
        // asked once the move and its store are over (Sol B2-R4-002).
        // Switched off meanwhile, a turn of the thread started or the thread
        // archived, the row records the move alone and the chain is not
        // taken for told.
        advice === null
          ? undefined
          : () =>
              judgedIn === generation(event.threadId) &&
              tellOnce(event.threadId, chain, event.requestId)
                ? reason
                : null,
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
        advice: carried,
        graced: new Set(),
      });
      if (advice !== null)
        await noteAdvice(event.threadId, projectId, fromName, reason, turn, now, judgedIn);
    } else {
      // Retried on the project's own account: it runs there from here, so
      // a failure of it within the grace of the project's latest move is
      // that account's, judged afresh, not retried at once as a leftover
      // of the account its turn started on (Codex r8, IR8-003).
      recentSwitches.get(projectId)?.graced.add(event.threadId);
      forgetStart(event.threadId);
    }
    if (stuck && !current.autoSwitch) return;
    if (decision.kind === "wait") {
      bb.log.info(
        `thread ${event.threadId}: ${how}${reason} until ${new Date(decision.sendAt).toISOString()}`,
      );
      // The advice only while the judgment's generation holds, as its rows
      // (code-reviewer r5, nit 1): otherwise the wait alone. Asked as the
      // retry is queued, after the waits on the queue (Sol B2-R6-004).
      const waited = decision.reason;
      await retryTurn(
        event,
        () => (judgedIn === generation(event.threadId) ? reason : waited),
        decision.sendAt,
        stuck,
      );
      return;
    }
    bb.log.info(`thread ${event.threadId}: ${how}${reason}`);
    await retryTurn(event, reason, undefined, stuck);
  }

  bb.events.on("turn.failed", async (event) => {
    // Where its turn started, read now and forgotten whatever comes of the
    // failure: a failure declined below ends the turn as well, with no
    // `thread.idle` (Codex IR13-001, code-reviewer r13).
    const started = startedOn.get(event.threadId);
    // Its judgment's generation, taken before any read (see generation).
    const judgedIn = generation(event.threadId);
    forgetStart(event.threadId);
    releaseSeat(event.threadId, "its turn failed");
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
        handleFailure(event, thread.projectId, started, judgedIn),
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
    // Marks made while bb reads are kept: its snapshot may predate them
    // (Codex Sol 0.2.18 r1, R0218-CODEX-002).
    const marksBefore = putBackMarks;
    const all = await bb.sdk.threads.queue.list();
    for (const [key, mark] of putBack)
      if (
        mark <= marksBefore &&
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
        else bb.log.warn(`thread ${thread.id}: not judged again: ${message}`);
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
    // Taken before any read (see generation).
    const judgedIn = generation(threadId);
    // Read again in the project's queue: archived, running again, moved or
    // retried meanwhile (Codex r6, IR6-005).
    if (!current.autoSwitch) return;
    const live = await bb.sdk.threads.get({ threadId });
    if (!waitingThread(live) || live.projectId !== thread.projectId) return;
    if ((await bb.sdk.threads.queuedMessages.list({ threadId })).length > 0)
      return;
    const turn = await latestTurn(threadId);
    if (turn === null) return;
    if (cancelled.get(threadId) === turn.requestId) {
      bb.log.debug(
        `thread ${threadId}: left in error (its retry was cancelled by hand)`,
      );
      return;
    }
    const failure = await loggedFailure(threadId, turn);
    if (failure === null) return;
    const declined = declineReason(failure, true);
    if (declined !== null) {
      bb.log.debug(`thread ${threadId}: left in error (${declined})`);
      return;
    }
    const before = moveMark(thread.projectId);
    const from = await projectAccount(thread.projectId);
    if (from.external) return;
    await judge(
      failure,
      thread.projectId,
      from,
      turn.model ?? current.preferredModel,
      deps.now(),
      true,
      before,
      judgedIn,
      // Its chain, as the log named it above.
      turn.original,
    );
  }
  /**
   * The failure of the thread's turn as bb logged it, as a failure event
   * reports it (the rescue judges it; a basis read back after a restart is
   * checked against it): null when the log holds none after the turn.
   */
  async function loggedFailure(
    threadId: string,
    turn: { seq: number; requestId: string; attempt: number },
  ): Promise<PluginTurnFailedEvent | null> {
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
    if (errorInfo === undefined) return null;
    const [reported] = await bb.sdk.threads.events.list({
      threadId,
      types: ["provider/rateLimits/updated"],
      order: "desc",
      limit: "1",
    });
    return {
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
  }
  /** What bb's failure event says of a turn rejected at the door (bb 0.45, `doorRejectionErrorInfo`). */
  function rejectedErrorInfo(
    reason: string,
  ): PluginTurnFailedEvent["errorInfo"] {
    switch (reason) {
      case "rate_limited":
        return {
          category: "rate-limit",
          providerCode: null,
          httpStatusCode: null,
        };
      case "auth_required":
        return {
          category: "unauthorized",
          providerCode: null,
          httpStatusCode: null,
        };
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
    const before = moveMark(projectId);
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
        // With the reserve: a Max account that keeps the preferred model
        // never gets an Opus retry released on it (Codex BM-R1-005).
        bestAccount([here], model, now, current.preferredModel) === fromName)
    ) {
      // It waited on the account the project was on before.
      const changed = accountChangedAt.get(projectId);
      if (
        (changed !== undefined && row.createdAt < changed) ||
        // A row put back is released only on an account MEASURED able to
        // run it: it may be waiting for this account's own reset (Codex
        // Sol 0.2.18 r2, R0218-R2-001).
        (putBack.has(wait.key) && here !== undefined && here.unknown !== true)
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
      current.preferredModel,
      freeSeats,
    );
    if (to === null) {
      // Nothing to release it on; the wait fires on its own at sendAt and
      // is placed then (code-reviewer r2, CR2-05).
      bb.log.debug(
        `thread ${threadId}: its wait stays on ${fromName}: no other account can run ${model}${reservedFor(fromName, model, now) ? " and this one keeps " + current.preferredModel : ""}`,
      );
      return;
    }
    // Moved by something else while the sessions were shared: the wait
    // stays as it is, and fires on its own.
    if (!(await applyAccount(projectId, accountOrDefault(to), from))) return;
    await markHandled(projectId);
    noteMove(projectId, fromName, to, model, before);
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
    forgetStart(threadId);
    try {
      await deleteOwn(threadId, wait.id);
    } catch (error) {
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
        if (back.delivery === "queued") markPutBack(wait.key);
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
        // the next pass if it is there (marked only when found, CR2-01).
        if (await rowQueued(threadId, wait.key)) {
          markPutBack(wait.key);
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
          await countUnseated();
        } catch (error) {
          bb.log.warn(
            `the turns not counted as they started were not counted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          await revisitWaits();
        } catch (error) {
          bb.log.warn(
            `the waiting turns were not looked at again: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // After the waits: a project they move has its turns retried there;
        // this moves only the projects left where no turn can run.
        try {
          await rescueStranded();
        } catch (error) {
          bb.log.warn(
            `the projects on an account that cannot run were not looked at: ${error instanceof Error ? error.message : String(error)}`,
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
    return listText(s, deps.now());
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
            await refreshByHand();
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
            "Show every move of a project to another account and every thread told to switch to Opus, latest first, and why",
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
        seats: cliCommand({
          summary:
            "Show the seats of every account and who waits, then each usage sample with the seats taken as it was measured",
          options: { json: JSON_OPTION },
          async run({ options }) {
            const taken = seatsState();
            pruneSeatSamples();
            if (options.json)
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({ seats: taken, samples: seatSamples }, null, 2)}\n`,
              };
            const lines: string[] = [];
            for (const [name, a] of Object.entries(taken))
              lines.push(
                `${name}\tseats ${a.running + a.reserved}/${a.capacity === 0 ? "no limit" : a.capacity} (${a.running} running, ${a.reserved} reserved)\t${a.queued.length} waiting`,
              );
            const time = (at: number | null) =>
              at === null ? "" : new Date(at).toISOString();
            lines.push(
              "",
              "time\taccount\trunning\treserved\tsession %\tweekly %\tsession resets\tweekly resets\tsession % per hour and seat",
            );
            const spend: string[] = [];
            for (const [name, samples] of Object.entries(seatSamples)) {
              // The 5-hour window's share an hour of one seat spent, between
              // samples of the same window: Δ% ÷ hours ÷ the seats running
              // on average. None across a reset.
              let used = 0;
              let seatHours = 0;
              samples.forEach((sample, i) => {
                const [at, running, reserved, session, weekly, resets, weeklyResets] = sample;
                const before = samples[i - 1];
                let rate = "—";
                if (
                  before !== undefined &&
                  resets !== null &&
                  before[5] === resets &&
                  at > before[0]
                ) {
                  const hours = ((at - before[0]) / 3_600_000) * ((running + before[1]) / 2);
                  if (hours > 0) {
                    used += session - before[3];
                    seatHours += hours;
                    rate = ((session - before[3]) / hours).toFixed(1);
                  }
                }
                lines.push(
                  `${time(at)}\t${name}\t${running}\t${reserved}\t${session}\t${weekly ?? ""}\t${time(resets)}\t${time(weeklyResets)}\t${rate}`,
                );
              });
              spend.push(
                `${name}\t${seatHours > 0 ? `${(used / seatHours).toFixed(1)} %` : "—"} of the 5-hour window per hour and seat`,
              );
            }
            lines.push("", ...spend);
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
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
                    await applyAccount(p.id, null, await projectAccount(p.id), {
                      byHand: true,
                    });
                    recentSwitches.delete(p.id);
                    excursions.delete(p.id);
                    movesOf(p.id).picks += 1;
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
              } else {
                // On the default account with no variable of its own (an
                // excursion to it deleted the variable): nothing to remove,
                // but nothing to come back from either (Codex
                // BM-INSPECT-005).
                excursions.delete(p.id);
                movesOf(p.id).picks += 1;
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

  /**
   * `read`, tried SEAT_COUNT_TRIES times SEAT_COUNT_RETRY_MS apart, each try
   * within DISPATCH_LIMIT_MS (one that never answers is a failed try: Astra
   * SEATS-R2-001); the last failure is thrown.
   */
  async function countTries<T>(what: string, read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const got = await within(
          read(),
          DISPATCH_LIMIT_MS,
          `${what} not read to count the seats`,
        );
        if (typeof got !== "object")
          throw new Error(got === "late" ? "no answer in time" : "the read failed");
        return got.value;
      } catch (error) {
        if (attempt >= SEAT_COUNT_TRIES) throw error;
        bb.log.warn(
          `${what} not read to count the seats (try ${attempt}): ${error instanceof Error ? error.message : String(error)}; trying again`,
        );
        await new Promise((resolve) => setTimeout(resolve, SEAT_COUNT_RETRY_MS));
      }
    }
  }
  /**
   * After a load the seats are empty: the threads bb says run count as
   * running, each on its project's account (a thread on an account set
   * outside this plugin has none). Turns wait for it (Astra SEATS-R02); a
   * read that fails is tried again, and one that still fails leaves its
   * threads uncounted (they count as they start again): fail open, said.
   */
  async function rebuildSeats(): Promise<void> {
    const ended = new Set<string>();
    endedWhileCounting = ended;
    try {
      if (accounts.length === 0) await countTries("the accounts", discover);
      const running: { id: string; projectId: string }[] = [];
      const PAGE = 200;
      for (let offset = 0; ; offset += PAGE) {
        const page = await countTries("the threads", () =>
          bb.sdk.threads.list({ archived: false, limit: PAGE, offset }),
        );
        running.push(
          ...page.filter(
            (t) =>
              t.providerId === CLAUDE_CODE_PROVIDER &&
              notTheUsersThread(t) === null &&
              TURN_UNDER_WAY.has(t.status),
          ),
        );
        if (page.length < PAGE) break;
      }
      const listedAt = deps.now();
      // Each project's account read once, all at once.
      const reads = new Map<string, Promise<ProjectAccount | null>>();
      for (const t of running)
        if (!reads.has(t.projectId))
          reads.set(
            t.projectId,
            countTries(`the account of project ${t.projectId}`, () =>
              projectAccount(t.projectId),
            ).catch((error: unknown) => {
              bb.log.warn(
                `the threads of project ${t.projectId} not counted after loading (they count as they start): ${error instanceof Error ? error.message : String(error)}`,
              );
              return null;
            }),
          );
      // Each thread looked at apart, all at once: one whose reads hang
      // holds up no other (Astra SEATS-R2-001).
      await Promise.all(
        running.map(async (t) => {
          const at = await reads.get(t.projectId)!;
          if (at === null) return;
          // On an account set outside this plugin: no seats. On one not
          // among the accounts found: nobody's, never the default's (Astra
          // SEATS-R3-001).
          const seat = seatFor(at);
          if (seat === null) return;
          if (seat === UNKNOWN_SEAT) {
            bb.log.debug(
              `thread ${t.id} not counted after loading: its project's account is not among the accounts found`,
            );
            return;
          }
          // A read that took long: is the turn still under way? Unknown is
          // not counted, for a seat counted running is never freed but by
          // the thread (Astra SEATS-R03).
          if (deps.now() - listedAt >= SEAT_COUNT_RETRY_MS) {
            const live = await countTries(`thread ${t.id}`, () =>
              bb.sdk.threads.get({ threadId: t.id }),
            ).catch((error: unknown) => {
              bb.log.warn(
                `thread ${t.id} not counted after loading (it counts as it starts): ${error instanceof Error ? error.message : String(error)}`,
              );
              return null;
            });
            if (live === null || !TURN_UNDER_WAY.has(live.status)) return;
          }
          // Ended while counted (Astra SEATS-R03), or announced or reserved
          // meanwhile (it counted itself).
          if (ended.has(t.id) || seats.seatOf(t.id) !== null) return;
          seats.confirm(t.id, seatKey(seat), deps.now());
        }),
      );
    } finally {
      endedWhileCounting = null;
      seatsReady = true;
      const taken = Object.entries(seats.snapshot())
        .map(([key, s]) => `${seatName(key)} ${s.running} running`)
        .join(", ");
      bb.log.info(`seats counted after loading: ${taken === "" ? "none taken" : taken}`);
      if (seatsAwaited)
        void bb.experimental_hooks
          .recheck("message.dispatch")
          .catch((error: unknown) =>
            bb.log.warn(
              `bb not asked again after the seats were counted: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
    }
  }
  seatsCounted = rebuildSeats().catch((error: unknown) =>
    bb.log.warn(
      `the running threads were not counted after loading (they count as they start): ${error instanceof Error ? error.message : String(error)}`,
    ),
  );

  bb.log.info("loaded");
}

export default function plugin(bb: BbPluginApi) {
  return createPlugin(bb, {
    credentialIo: nodeCredentialIo(),
    accountsIo: nodeAccountsIo(),
    loginIo: nodeLoginIo(),
    sessionsIo: nodeSessionsIo(),
    loginHelper: loginHelperPath(import.meta.url),
    env: process.env,
    now: Date.now,
    random: Math.random,
  });
}
