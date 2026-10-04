import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import type {
  PluginThreadEventPayloads,
  PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";

type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
import { createPlugin, ENV_VAR, HISTORY_LIMIT, type State } from "./server.js";
import type { AccountsIo } from "./src/accounts.js";
import type { CredentialIo } from "./src/credentials.js";
import type { LoginIo, LoginProcess } from "./src/login.js";
import {
  usageFetchMethod,
  usageListMethod,
} from "./src/usage-source-contract.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const HOUR = 3_600_000;
const HOME = "/Users/someone";
const ACCOUNTS = `${HOME}/.claude-accounts`;
/** Literal on purpose (= provider-retry's 15 s buffer): importing it would let it drift. */
const BUFFER = 15_000;

type Payload = Record<string, unknown>;

function payload(
  session: number,
  weekly: number,
  fable: number | null = null,
): Payload {
  const limits: unknown[] = [
    {
      kind: "session",
      percent: session,
      resets_at: new Date(NOW + 2 * HOUR).toISOString(),
    },
    {
      kind: "weekly_all",
      percent: weekly,
      resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
    },
  ];
  if (fable !== null) {
    limits.push({
      kind: "weekly_scoped",
      percent: fable,
      resets_at: new Date(NOW + 4 * HOUR).toISOString(),
      scope: { model: { display_name: "Fable" } },
    });
  }
  return {
    limits,
    five_hour: { locked_reason: null },
    seven_day: { locked_reason: null },
  };
}

function claudeJson(email: string, uuid: string) {
  return JSON.stringify({
    oauthAccount: { accountUuid: uuid, emailAddress: email },
  });
}

function hash(dir: string): string {
  // Same rule as src/credentials.ts; kept inline so the test does not import the code under test's helper.
  return createHash("sha256")
    .update(dir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
}

/** Three accounts: `main` (the default, ~/.claude.json), `spare` and `work`; usage answered per token. */
function fakes(
  usageByAccount: Record<string, () => Response>,
  dirs: () => string[],
) {
  const files: Record<string, string> = {
    [`${HOME}/.claude.json`]: claudeJson("main@example.com", "uuid-main"),
    [`${ACCOUNTS}/spare/.claude.json`]: claudeJson(
      "spare@example.com",
      "uuid-spare",
    ),
    [`${ACCOUNTS}/work/.claude.json`]: claudeJson(
      "work@example.com",
      "uuid-work",
    ),
    // Only listed by tests whose dirs() include it.
    [`${ACCOUNTS}/default/.claude.json`]: claudeJson(
      "default@example.com",
      "uuid-default",
    ),
  };
  const services: Record<string, string> = {
    "Claude Code-credentials": "main",
    [`Claude Code-credentials-${hash(`${ACCOUNTS}/spare`)}`]: "spare",
    [`Claude Code-credentials-${hash(`${ACCOUNTS}/work`)}`]: "work",
    [`Claude Code-credentials-${hash(`${ACCOUNTS}/default`)}`]: "default",
    [`Claude Code-credentials-${hash(`${ACCOUNTS}/team`)}`]: "team",
  };
  const usageCalls: string[] = [];
  const credentialIo: CredentialIo = {
    platform: "darwin",
    username: "someone",
    home: HOME,
    async exec(args) {
      const name = services[args[args.indexOf("-s") + 1]!];
      if (args[0] !== "find-generic-password" || name === undefined)
        return { code: 44, stdout: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: `tok-${name}`,
            refreshToken: "r",
            // Far ahead: no test here exercises the token refresh (credentials.test.ts does).
            expiresAt: NOW + 30 * 24 * HOUR,
          },
        }),
      };
    },
    async readFile() {
      throw new Error("ENOENT");
    },
    async writeFile() {},
    fetch: async (_url, init) => {
      const name = new Headers(init?.headers)
        .get("authorization")!
        .replace("Bearer tok-", "");
      usageCalls.push(name);
      // Async like the real thing: lets concurrent handlers interleave.
      await new Promise((r) => setTimeout(r, 1));
      return usageByAccount[name]!();
    },
  };
  const accountsIo: AccountsIo = {
    home: HOME,
    async readFile(path) {
      if (files[path] === undefined) throw new Error("ENOENT");
      return files[path]!;
    },
    async listDirs(path) {
      return path === ACCOUNTS ? dirs() : [];
    },
  };
  return { credentialIo, accountsIo, usageCalls, files };
}

/** A fake `claude auth login`: the test ends it with `exit`. */
interface FakeLogin {
  env: Record<string, string>;
  written: string[];
  killed: boolean;
  exit: (code: number | null) => void;
}

function fakeLoginIo(
  entries: () => { name: string; directory: boolean }[],
): {
  loginIo: LoginIo;
  logins: FakeLogin[];
  made: string[];
  links: [string, string][];
} {
  const logins: FakeLogin[] = [];
  const made: string[] = [];
  const links: [string, string][] = [];
  const loginIo: LoginIo = {
    spawn({ env }) {
      let resolveExit!: (r: { code: number | null }) => void;
      const exited = new Promise<{ code: number | null }>((resolve) => {
        resolveExit = resolve;
      });
      const entry: FakeLogin = {
        env,
        written: [],
        killed: false,
        exit: (code) => resolveExit({ code }),
      };
      logins.push(entry);
      const process: LoginProcess = {
        write: (text) => entry.written.push(text),
        kill: () => {
          entry.killed = true;
          resolveExit({ code: null });
        },
        onOutput: () => {},
        exited,
      };
      return process;
    },
    async mkdir(dir) {
      made.push(dir);
      return true;
    },
    async entries(dir) {
      return dir === ACCOUNTS ? entries() : [];
    },
    // Only `projects` exists in the default account's directory.
    async link(target, path) {
      if (!target.endsWith("/projects")) return false;
      links.push([target, path]);
      return true;
    },
  };
  return { loginIo, logins, made, links };
}

/** A row of bb's raw thread log; `data` as bb stores it. */
interface LoggedEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  [field: string]: unknown;
}

/** attemptNumber of each failed request seen, so the fake retry can stamp bb's `attempt`. */
const attemptOf = new Map<string, number>();

function failure(
  overrides: Partial<PluginTurnFailedEvent> = {},
): PluginTurnFailedEvent {
  attemptOf.set(overrides.requestId ?? "creq_1", overrides.attemptNumber ?? 1);
  return makeTurnFailedEvent({
    threadId: "thread-1",
    requestId: "creq_1",
    errorInfo: {
      category: "rate-limit",
      providerCode: "usage_limit_reached",
      httpStatusCode: 429,
    },
    rateLimits: {
      providerId: "claude-code",
      status: "blocked",
      kind: "subscription-window",
      windows: [
        {
          providerKey: "primary",
          label: "Current session",
          status: "blocked",
          resetsAtMs: NOW + 2 * HOUR,
        },
      ],
      reachedReason: "rate_limit_reached",
      overageStatus: null,
      overageReason: null,
    },
    ...overrides,
  });
}

interface EnvCall {
  projectId: string;
  name: string;
  value?: string;
  note?: string;
}

/** A project's machine variables as bb lists them (values are never returned). */
type EnvVar = { name: string; note: string | null; secret: true; value: null };

/** The part of a queued row this plugin looks at. */
interface QueuedRow {
  id: string;
  threadId: string;
  payload:
    | { kind: "inline" }
    | {
        kind: "retry";
        attempt: number;
        reason: string;
        retryOfTurnRequestId: string;
      };
  sendAt: number | null;
  /** What the row waits on, as bb says it; a plugin's hold names the plugin. */
  waitingOn?: { kind: "time" } | { kind: "plugin"; pluginId: string; reason: string } | null;
  createdAt?: number;
  /** The model the row runs with (a retry: the failed turn's). */
  model?: string;
}

interface HostOptions {
  settings?: Record<string, string | number | boolean>;
  presetEnv?: Record<string, EnvVar[]>;
  /** Rows already queued (e.g. by provider-retry) when the plugin acts. */
  queued?: QueuedRow[];
  /** What threads.retry does: default queues a row; "conflict" throws like bb's 409; "fail-once" fails the first call (a 5xx); "fail" fails every call. */
  retryBehaviour?: "queue" | "conflict" | "fail-once" | "fail" | "answer-lost" | "restore-answer-lost";
  /** threads.retry throws this, shaped like bb's BbHttpError. */
  retryError?: { message: string; code?: string; status?: number };
  /** queuedMessages.send throws this, shaped like bb's BbHttpError: `code` apart from the message. */
  sendError?: { message: string; code?: string; status?: number };
  /** deleteMachineEnvironmentVariable throws for these projects (deleted meanwhile, or a bb hiccup). */
  failDelete?: string[];
  /** queuedMessages.delete throws this (the row left the queue between list and delete); `landed`: bb removed the row first, and only its answer was lost. */
  deleteRowError?: { message: string; code?: string; status?: number; landed?: boolean };
  dirs?: () => string[];
  clock?: () => number;
  /** What threads.get answers per thread, over a visible Claude Code thread of the user. */
  threads?: Record<string, Partial<ThreadResponse>>;
  /** What threads.get answers on top of `threads`, while threads.list still lists them as `threads` says (changed meanwhile). */
  threadsLive?: Record<string, Partial<ThreadResponse>>;
  /** Rows another plugin queues once threads.list has answered (while the pass runs). */
  queueAfterList?: QueuedRow[];
  /** Runs before threads.events.list answers (a toggle flipped while the pass reads). */
  beforeEvents?: () => Promise<void>;
  /** bb's raw log per thread, as threads.events.list answers it. */
  threadEvents?: Record<string, LoggedEvent[]>;
  /** threads.events.list throws this (a bb hiccup). */
  threadEventsError?: string;
  /** Plugin storage answers every read with this error while the plugin loads. */
  kvReadError?: string;
  /** Values already in plugin storage when the plugin loads. */
  kvPreset?: Record<string, unknown>;
  /** When each project was created; default: proj-1 and proj-2 a day before NOW, any other just after. */
  projectCreatedAt?: Record<string, number>;
  /** setMachineEnvironmentVariable throws for these projects. */
  failSet?: string[];
  /** Runs as each setMachineEnvironmentVariable starts, before it lands. */
  beforeSet?: () => Promise<unknown>;
  /** machineEnvironment throws for these projects (a bb hiccup), or never answers. */
  failEnvRead?: string[];
  hangEnvRead?: string[];
  /** The plugin process's environment, as the login inherits it. */
  env?: Record<string, string>;
  /** What the accounts directory holds, links and files included; default: dirs() as directories. */
  accountEntries?: () => { name: string; directory: boolean }[];
}

/** When the last accounts-changed was announced (its payload's at). */
function lastChangeAt(h: { harness: { realtimeSignals: readonly { channel: string; payload: unknown }[] } }): number {
  const changes = h.harness.realtimeSignals.filter((s) => s.channel === "accounts-changed");
  return (changes.at(-1)?.payload as { at: number } | undefined)?.at ?? 0;
}

async function host(
  usage: Record<string, () => Response>,
  options: HostOptions = {},
) {
  const envSet: EnvCall[] = [];
  const envDeleted: EnvCall[] = [];
  /** Every machineEnvironment read, by project. */
  const envReads: string[] = [];
  const env = new Map<string, EnvVar[]>(
    Object.entries(options.presetEnv ?? {}),
  );
  const envList = (projectId: string) => ({
    builtInGit: { status: "disabled" as const, statusMessage: "" },
    inheritedVariables: [],
    variables: env.get(projectId) ?? [],
  });
  const retries: Array<{
    threadId: string;
    turnRequestId?: string;
    sendAt?: number;
    reason?: string;
  }> = [];
  const sent: string[] = [];
  const deleted: string[] = [];
  const queued: QueuedRow[] = [...(options.queued ?? [])];
  let nextId = 1;
  let retryFailures = 0;
  const { credentialIo, accountsIo, usageCalls, files } = fakes(
    usage,
    options.dirs ?? (() => ["spare", "work"]),
  );
  const { loginIo, logins, made, links } = fakeLoginIo(
    options.accountEntries ??
      (() =>
        (options.dirs ?? (() => ["spare", "work"]))().map((name) => ({
          name,
          directory: true,
        }))),
  );
  const fake = createFakePluginHost({
    pluginId: "claude-switcher",
    settings: {
      accountsDir: ACCOUNTS,
      defaultAccountName: "main",
      ...options.settings,
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          thread({
            id: threadId,
            projectId: threadId === "thr-2" ? "proj-2" : "proj-1",
            ...options.threads?.[threadId],
            ...options.threadsLive?.[threadId],
          }),
        // Like bb: every thread, as threads.get answers for it.
        list: async () => {
          if (options.queueAfterList !== undefined) {
            queued.push(...options.queueAfterList);
            options.queueAfterList = undefined;
          }
          return Object.keys(options.threads ?? {}).map((threadId) =>
            thread({
              id: threadId,
              projectId: threadId === "thr-2" ? "proj-2" : "proj-1",
              ...options.threads?.[threadId],
            }),
          );
        },
        events: {
          // Like bb: only the asked types, oldest first unless desc, then the limit.
          list: async (args: {
            threadId: string;
            types?: readonly string[];
            order?: "asc" | "desc";
            limit?: string;
            afterSeq?: string;
          }) => {
            if (options.threadEventsError !== undefined)
              throw new Error(options.threadEventsError);
            await options.beforeEvents?.();
            const rows = (options.threadEvents?.[args.threadId] ?? [])
              .filter(
                (row) => args.types === undefined || args.types.includes(row.type),
              )
              .filter(
                (row) => args.afterSeq === undefined || row.seq > Number(args.afterSeq),
              )
              .sort((a, b) => (args.order === "desc" ? b.seq - a.seq : a.seq - b.seq));
            return args.limit === undefined
              ? rows
              : rows.slice(0, Number(args.limit));
          },
        },
        retry: async (args: (typeof retries)[number]) => {
          if (options.retryError !== undefined) {
            const { message, ...rest } = options.retryError;
            throw Object.assign(new Error(message), rest);
          }
          // Like bb (retryFailedTurn): one queued retry per chain, keyed by its first request.
          const logged = (options.threadEvents?.[args.threadId] ?? []).find(
            (row) =>
              row.type === "client/turn/requested" &&
              row.data.requestId === args.turnRequestId,
          );
          const original =
            (logged?.data.retryOfRequestId as string | undefined) ??
            args.turnRequestId;
          if (
            queued.some(
              (row) =>
                row.threadId === args.threadId &&
                row.payload.kind === "retry" &&
                row.payload.retryOfTurnRequestId === original,
            )
          )
            throw Object.assign(
              new Error(
                `HTTP 409: Turn ${original} already has a retry waiting on thread ${args.threadId}.`,
              ),
              { code: "retry_already_queued", status: 409 },
            );
          if (options.retryBehaviour === "answer-lost") {
            // The first lands (dispatched: the thread no longer has a failed turn), its answer lost.
            if (retryFailures++ === 0) {
              retries.push(args);
              throw new Error("socket hang up");
            }
            throw Object.assign(
              new Error(
                `HTTP 409: Thread ${args.threadId} has no failed turn to retry: it is running.`,
              ),
              { code: "no_failed_turn", status: 409 },
            );
          }
          if (options.retryBehaviour === "conflict") {
            throw new Error(
              `Turn ${args.turnRequestId} already has a retry waiting on thread ${args.threadId}.`,
            );
          }
          if (options.retryBehaviour === "fail") {
            // Distinct messages, so a test can tell the first failure from the restore's.
            throw new Error(
              retryFailures++ === 0
                ? "HTTP 503: internal error"
                : "HTTP 502: bad gateway",
            );
          }
          if (options.retryBehaviour === "fail-once" && retryFailures++ === 0) {
            throw new Error("HTTP 503: internal error");
          }
          // The first fails before bb does anything; the second (the wait put back) lands, its answer lost.
          let answerLost = false;
          if (options.retryBehaviour === "restore-answer-lost" && retryFailures < 2) {
            if (retryFailures++ === 0) throw new Error("HTTP 503: internal error");
            answerLost = true;
          }
          retries.push(args);
          const id = `q${nextId++}`;
          // An immediate retry is dispatched at once; only a timed one waits in the queue.
          if (args.sendAt !== undefined)
            queued.push({
              id,
              threadId: args.threadId,
              payload: {
                kind: "retry",
                // Like bb: the failed turn's attempt in the thread's log, plus one.
                attempt:
                  (logged !== undefined
                    ? ((logged.data.retryAttempt as number | undefined) ?? 1)
                    : (attemptOf.get(args.turnRequestId ?? "") ?? 1)) + 1,
                reason: args.reason ?? "",
                retryOfTurnRequestId: args.turnRequestId ?? "",
              },
              sendAt: args.sendAt ?? null,
              waitingOn: { kind: "time" },
              createdAt: (options.clock ?? (() => NOW))(),
            });
          if (answerLost) throw new Error("socket hang up");
          return {
            ok: true,
            delivery: "queued",
            turnRequestId: args.turnRequestId ?? "creq_1",
            attempt: 2,
            queuedMessageId: id,
            waitingOn: null,
            sendAt: args.sendAt ?? null,
          };
        },
        queue: {
          // Like bb with no filter: every live row in the workspace.
          list: async () => [...queued],
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) =>
            queued.filter((row) => row.threadId === threadId),
          send: async ({ queuedMessageId }: { queuedMessageId: string }) => {
            if (options.sendError !== undefined) {
              const { message, ...rest } = options.sendError;
              throw Object.assign(new Error(message), rest);
            }
            sent.push(queuedMessageId);
            // Dispatched rows leave the queue, as in bb.
            const at = queued.findIndex((row) => row.id === queuedMessageId);
            if (at !== -1) queued.splice(at, 1);
            return { ok: true };
          },
          delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
            if (options.deleteRowError !== undefined) {
              const { message, landed, ...rest } = options.deleteRowError;
              if (landed === true) {
                deleted.push(queuedMessageId);
                const at = queued.findIndex((row) => row.id === queuedMessageId);
                if (at !== -1) queued.splice(at, 1);
              }
              throw Object.assign(new Error(message), rest);
            }
            deleted.push(queuedMessageId);
            const at = queued.findIndex((row) => row.id === queuedMessageId);
            if (at !== -1) queued.splice(at, 1);
            return { ok: true };
          },
        },
      },
      projects: {
        // Like bb: the personal project ("Don't work in a project") only on request.
        list: async (args?: { includePersonal?: boolean }) => [
          { id: "proj-1", name: "Website" },
          { id: "proj-2", name: "Other" },
          ...(args?.includePersonal === true
            ? [{ id: "personal", name: "Personal" }]
            : []),
        ],
        machineEnvironment: async ({ projectId }: { projectId: string }) => {
          envReads.push(projectId);
          if (options.failEnvRead?.includes(projectId))
            throw new Error(`HTTP 503: could not read ${projectId}`);
          if (options.hangEnvRead?.includes(projectId))
            await new Promise(() => {});
          return envList(projectId);
        },
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: projectId,
          createdAt:
            options.projectCreatedAt?.[projectId] ??
            (projectId === "proj-1" || projectId === "proj-2"
              ? NOW - 24 * HOUR
              : NOW + 1_000),
        }),
        setMachineEnvironmentVariable: async (args: EnvCall) => {
          await options.beforeSet?.();
          if (options.failSet?.includes(args.projectId)) {
            throw new Error(`HTTP 503: could not set on ${args.projectId}`);
          }
          envSet.push(args);
          env.set(args.projectId, [
            ...(env.get(args.projectId) ?? []).filter(
              (v) => v.name !== args.name,
            ),
            {
              name: args.name,
              note: args.note ?? null,
              secret: true,
              value: null,
            },
          ]);
          return envList(args.projectId);
        },
        deleteMachineEnvironmentVariable: async (args: EnvCall) => {
          if (options.failDelete?.includes(args.projectId)) {
            throw new Error(`HTTP 404: project ${args.projectId} not found`);
          }
          envDeleted.push(args);
          env.set(
            args.projectId,
            (env.get(args.projectId) ?? []).filter((v) => v.name !== args.name),
          );
          return envList(args.projectId);
        },
      },
    },
  });
  for (const [key, value] of Object.entries(options.kvPreset ?? {}))
    await fake.bb.storage.kv.set(key, value);
  const kvGet = fake.bb.storage.kv.get;
  if (options.kvReadError !== undefined) {
    fake.bb.storage.kv.get = async () => {
      throw new Error(options.kvReadError);
    };
  }
  await createPlugin(fake.bb, {
    credentialIo,
    accountsIo,
    loginIo,
    loginHelper: "/plugin/bin/open-login.sh",
    env: options.env ?? { PATH: "/usr/bin" },
    now: options.clock ?? (() => NOW),
    random: () => 0,
  });
  fake.bb.storage.kv.get = kvGet;
  return {
    ...fake,
    env,
    envSet,
    envDeleted,
    envReads,
    retries,
    sent,
    deleted,
    queued,
    usageCalls,
    files,
    logins,
    made,
    links,
  };
}

const ALL_FREE = {
  main: () => Response.json(payload(100, 40)),
  spare: () => Response.json(payload(10, 60)),
  work: () => Response.json(payload(5, 20)),
};

/** A visible Claude Code thread the user opened, as bb reports it. */
function thread(overrides: Partial<ThreadResponse> = {}): ThreadResponse {
  return makeThreadResponse({
    providerId: "claude-code",
    visibility: "visible",
    originPluginId: null,
    ...overrides,
  });
}

function ownNote(name: string) {
  return `Claude Code account "${name}" (set by the Claude Switcher plugin)`;
}

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("claude accounts plugin", () => {
  it("registers settings, the page RPC, the provider-usage source, a service and the CLI", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    expect(
      Object.keys(h.harness.registrations.settingsDescriptors).sort(),
    ).toEqual([
      "accountsDir",
      "autoSwitch",
      "claudeCommand",
      "defaultAccountName",
      "loginPrivateWindow",
      "maximumWaitHours",
      "preferredModel",
      "refreshMinutes",
      "switchAheadPercent",
    ]);
    expect(h.harness.registrations.rpcMethods.sort()).toEqual(
      [
        "accounts_list",
        "accounts_refresh",
        "project_set_account",
        "account_login_start",
        "account_login_code",
        "account_login_cancel",
        usageFetchMethod,
        usageListMethod,
      ].sort(),
    );
    expect(
      h.harness.registrations.experimental_publishedRpcMethods
        .map((m) => m.method)
        .sort(),
    ).toEqual([usageFetchMethod, usageListMethod].sort());
    expect(h.harness.registrations.services.map((s) => s.name)).toEqual([
      "usage-refresh",
    ]);
    expect(h.harness.registrations.cli?.name).toBe("claude-switcher");
  });

  it("lists every account with its windows after a refresh, and each project's account", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc(
      "accounts_refresh",
      null,
    )) as State;
    expect(
      state.accounts.map((a) => [
        a.name,
        a.email,
        a.usage?.session.usedPercent,
      ]),
    ).toEqual([
      ["main", "main@example.com", 100],
      ["spare", "spare@example.com", 10],
      ["work", "work@example.com", 5],
    ]);
    expect(state.projects).toEqual([
      { id: "proj-1", name: "Website", account: null, owned: false, external: false },
      { id: "proj-2", name: "Other", account: null, owned: false, external: false },
      // Listed so a variable the plugin sets there can be seen and released.
      { id: "personal", name: "Personal", account: null, owned: false, external: false },
    ]);
    expect(h.usageCalls).toEqual(["main", "spare", "work"]);
  });

  it("serves the provider-usage panel: list is cheap, getResource refreshes only that account", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    const list = (await h.harness.behavior.callRpc(usageListMethod, {})) as {
      resources: Array<{ id: string; accountKey: string | null }>;
    };
    expect(list.resources.map((r) => [r.id, r.accountKey])).toEqual([
      ["main", "anthropic:account:uuid-main"],
      ["spare", "anthropic:account:uuid-spare"],
      ["work", "anthropic:account:uuid-work"],
    ]);
    expect(h.usageCalls).toEqual([]);
    const measurement = (await h.harness.behavior.callRpc(usageFetchMethod, {
      resourceId: "work",
      refresh: true,
    })) as {
      observedAt: number | null;
      usage: {
        status: string;
        windows: Array<{ id: string; usedPercent: number }>;
      };
    };
    expect(h.usageCalls).toEqual(["work"]);
    expect(measurement.observedAt).toBe(NOW);
    expect(measurement.usage.status).toBe("ok");
    expect(measurement.usage.windows.map((w) => [w.id, w.usedPercent])).toEqual(
      [
        ["session", 5],
        ["weekly", 20],
      ],
    );
    await expect(
      h.harness.behavior.callRpc(usageFetchMethod, {
        resourceId: "nope",
        refresh: false,
      }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("takes bb's word when it already has a retry of the failed turn, instead of failing the handler", async () => {
    // 2026-10-04: a retry of each failed turn was on its way before this
    // plugin judged the failure; bb answered 409 and the handler failed.
    const h = await host(ALL_FREE, {
      retryError: {
        message:
          "HTTP 409: Turn creq_1 already has a retry waiting on thread thread-1.",
        code: "retry_already_queued",
        status: 409,
      },
    });
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "error"),
    ).toEqual([]);
    expect(
      h.harness.logEntries.some(
        (entry) =>
          entry.level === "info" && /already has a retry of the turn/.test(entry.message),
      ),
    ).toBe(true);
  });

  it("moves the project to the best other account and retries the turn at once", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    // `work` resets its weekly at the same time as `spare` but has the lower session use.
    expect(h.envSet).toEqual([
      {
        projectId: "proj-1",
        name: ENV_VAR,
        value: `${ACCOUNTS}/work`,
        note: expect.stringContaining("work"),
      },
    ]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        reason: "Switched to account work",
      },
    ]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.projects[0]).toEqual({
      id: "proj-1",
      name: "Website",
      account: "work",
      owned: true,
      external: false,
    });
    expect(state.lastSwitch).toMatchObject({
      from: "main",
      to: "work",
      threadId: "thread-1",
    });
    expect(
      h.harness.realtimeSignals.some((s) => s.channel === "accounts-changed"),
    ).toBe(true);
  });

  it("sends the retry provider-retry already queued instead of queueing a second one", async () => {
    const h = await host(ALL_FREE, {
      queued: [
        {
          id: "pr-1",
          threadId: "thread-1",
          payload: {
            kind: "retry",
            attempt: 2,
            reason: "Rate limited",
            retryOfTurnRequestId: "creq_1",
          },
          sendAt: NOW + 2 * HOUR,
        },
        {
          id: "other",
          threadId: "thread-1",
          payload: { kind: "inline" },
          sendAt: null,
        },
      ],
    });
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.sent).toEqual(["pr-1"]);
    expect(h.retries).toEqual([]);
  });

  it("on a retry's own failure (attempt 2+), still finds provider-retry's row, which is keyed by the ORIGINAL request", async () => {
    const h = await host(ALL_FREE, {
      retryBehaviour: "conflict",
      queued: [
        {
          id: "pr-2",
          threadId: "thread-1",
          payload: {
            kind: "retry",
            attempt: 3,
            reason: "Rate limited",
            retryOfTurnRequestId: "creq_original",
          },
          sendAt: NOW + 2 * HOUR + BUFFER,
        },
      ],
    });
    dispose = () => h.harness.dispose();
    // bb reports the failed RETRY's id, not the chain's original.
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_retry_2", attemptNumber: 2 }),
    );
    expect(errors).toEqual([]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.sent).toEqual(["pr-2"]);
  });

  it("picks the retry row of THIS turn's chain, not an older turn's row still waiting on the thread", async () => {
    const older = {
      id: "r-old",
      threadId: "thread-1",
      payload: {
        kind: "retry" as const,
        attempt: 2,
        reason: "Rate limited",
        retryOfTurnRequestId: "creq_0",
      },
      sendAt: NOW + 5 * HOUR,
    };
    const mine = {
      id: "r-mine",
      threadId: "thread-1",
      payload: {
        kind: "retry" as const,
        attempt: 2,
        reason: "Rate limited",
        retryOfTurnRequestId: "creq_1",
      },
      sendAt: NOW + 2 * HOUR,
    };
    // Switch: only this turn's row is sent; the older wait is left alone.
    const h = await host(ALL_FREE, { queued: [older, mine] });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.sent).toEqual(["r-mine"]);
    expect(h.deleted).toEqual([]);
    // Wait: only this turn's row is replaced.
    const w = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(1, 1, 100)),
      },
      { settings: { preferredModel: "Fable" }, queued: [older, mine] },
    );
    const disposeFirst = dispose;
    dispose = () => {
      disposeFirst?.();
      w.harness.dispose();
    };
    await w.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(w.deleted).toEqual(["r-mine"]);
    expect(w.queued.map((r) => r.id)).toContain("r-old");
    // On a retry's failure, the chain's row (attempt + 1) is the one, whatever its original id.
    const r = await host(ALL_FREE, {
      retryBehaviour: "conflict",
      queued: [
        older,
        { ...mine, id: "r-3", payload: { ...mine.payload, attempt: 3, retryOfTurnRequestId: "creq_root" } },
      ],
    });
    const disposeTwo = dispose;
    dispose = () => {
      disposeTwo?.();
      r.harness.dispose();
    };
    await r.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_retry_2", attemptNumber: 2 }),
    );
    expect(r.sent).toEqual(["r-3"]);
  });

  it("when bb rejects a second retry for the turn, sends the one already queued", async () => {
    const h = await host(ALL_FREE, { retryBehaviour: "conflict" });
    dispose = () => h.harness.dispose();
    // provider-retry wins the race between our list and our retry.
    h.harness.sdk.stub("threads.queuedMessages.list", async () =>
      h.queued.length === 0
        ? (h.queued.push({
            id: "late",
            threadId: "thread-1",
            payload: {
              kind: "retry",
              attempt: 2,
              reason: "",
              retryOfTurnRequestId: "creq_1",
            },
            sendAt: NOW + HOUR,
          }),
          [])
        : h.queued,
    );
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.sent).toEqual(["late"]);
  });

  it("replaces a queued retry with its own timed one when it has to wait", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(1, 1, 100)),
      },
      {
        settings: { preferredModel: "Fable" },
        queued: [
          {
            id: "pr-1",
            threadId: "thread-1",
            payload: {
              kind: "retry",
              attempt: 2,
              reason: "Rate limited",
              retryOfTurnRequestId: "creq_1",
            },
            sendAt: NOW + 2 * HOUR,
          },
        ],
      },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.deleted).toEqual(["pr-1"]);
    expect(h.sent).toEqual([]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        sendAt: NOW + 4 * HOUR + BUFFER,
        reason: "Waiting for Fable on main",
      },
    ]);
    expect(h.envSet).toEqual([]);
  });

  it("when the row to replace left the queue between list and delete, leaves it at that (bb refuses a retry of a running thread)", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(1, 1, 100)),
      },
      {
        settings: { preferredModel: "Fable" },
        queued: [
          {
            id: "pr-1",
            threadId: "thread-1",
            payload: {
              kind: "retry",
              attempt: 2,
              reason: "Rate limited",
              retryOfTurnRequestId: "creq_1",
            },
            sendAt: NOW + 2 * HOUR,
          },
        ],
        deleteRowError: {
          message: "HTTP 404: Queued message not found",
          code: "invalid_request",
          status: 404,
        },
      },
    );
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.retries).toEqual([]);
  });

  it("the same when the wait is on ANOTHER account: the project has moved, nothing is queued", async () => {
    const soon = {
      ...payload(1, 1, 100),
      limits: [
        ...(payload(1, 1).limits as unknown[]),
        {
          kind: "weekly_scoped",
          percent: 100,
          resets_at: new Date(NOW + HOUR).toISOString(),
          scope: { model: { display_name: "Fable" } },
        },
      ],
    };
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(soon),
        work: () => Response.json(payload(1, 1, 100)),
      },
      {
        settings: { preferredModel: "Fable" },
        queued: [
          {
            id: "pr-1",
            threadId: "thread-1",
            payload: {
              kind: "retry",
              attempt: 2,
              reason: "Rate limited",
              retryOfTurnRequestId: "creq_1",
            },
            sendAt: NOW + 2 * HOUR,
          },
        ],
        deleteRowError: {
          message: "HTTP 404: Queued message not found",
          code: "invalid_request",
          status: 404,
        },
      },
    );
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.retries).toEqual([]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.lastSwitch).toMatchObject({ from: "main", to: "spare" });
  });

  it("puts provider-retry's row back when its own timed retry fails after replacing it", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(1, 1, 100)),
      },
      {
        settings: { preferredModel: "Fable" },
        retryBehaviour: "fail-once",
        queued: [
          {
            id: "pr-1",
            threadId: "thread-1",
            payload: {
              kind: "retry",
              attempt: 2,
              reason: "Rate limited",
              retryOfTurnRequestId: "creq_1",
            },
            sendAt: NOW + 2 * HOUR,
          },
        ],
      },
    );
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.deleted).toEqual(["pr-1"]);
    // The turn is never left without a retry: the deleted one is queued again as it was.
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        sendAt: NOW + 2 * HOUR,
        reason: "Rate limited",
      },
    ]);
  });

  it("treats bb's 'still waiting' answer to a send as done (the row runs when the thread frees), and keeps the original error when restoring fails too", async () => {
    const row = {
      id: "pr-1",
      threadId: "thread-1",
      payload: {
        kind: "retry" as const,
        attempt: 2,
        reason: "Rate limited",
        retryOfTurnRequestId: "creq_1",
      },
      sendAt: NOW + 2 * HOUR,
    };
    // bb's real 409: ApiError(409, "queued_message_still_waiting", "This message cannot be sent yet: …")
    // reaches the plugin as BbHttpError { message: "HTTP 409: This message…", code, status }.
    const busy = await host(ALL_FREE, {
      queued: [row],
      sendError: {
        message:
          "HTTP 409: This message cannot be sent yet: the thread is already running a turn.",
        code: "queued_message_still_waiting",
        status: 409,
      },
    });
    dispose = () => busy.harness.dispose();
    const { errors } = await busy.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(busy.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    // Either signal alone is enough: the code with another text, or bb's
    // text without the code (an SDK that drops it). And bb's two answers
    // for a row that is already on its way (sent by another caller, or
    // being sent right now) are "done" too.
    for (const sendError of [
      { message: "HTTP 409: Conflict", code: "queued_message_still_waiting" },
      { message: "HTTP 409: This message cannot be sent yet: the thread is stopping." },
      { message: "HTTP 404: Queued message not found", code: "invalid_request", status: 404 },
      { message: "HTTP 409: Queued message is already being sent", code: "invalid_request", status: 409 },
    ]) {
      const alone = await host(ALL_FREE, { queued: [row], sendError });
      const disposeBefore = dispose;
      dispose = () => {
        disposeBefore?.();
        alone.harness.dispose();
      };
      const result = await alone.harness.behavior.emitThreadEvent(
        "turn.failed",
        failure(),
      );
      expect(result.errors).toEqual([]);
    }
    // Any other failure of the send is reported, not swallowed.
    const broken = await host(ALL_FREE, {
      queued: [row],
      sendError: { message: "HTTP 500: internal error", status: 500 },
    });
    const disposeBusy = dispose;
    dispose = () => {
      disposeBusy?.();
      broken.harness.dispose();
    };
    const sendFailed = await broken.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(sendFailed.errors.map(String)).toEqual([
      expect.stringMatching(/HTTP 500/),
    ]);
    const dead = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(1, 1, 100)),
      },
      { settings: { preferredModel: "Fable" }, retryBehaviour: "fail", queued: [row] },
    );
    const disposeFirst = dispose;
    dispose = () => {
      disposeFirst?.();
      dead.harness.dispose();
    };
    const second = await dead.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(second.errors).toHaveLength(1);
    // The original failure (503) and the restore's (502) both survive in the message.
    expect(String(second.errors[0])).toMatch(/503.*restor.*502/);
  });

  it("a retry bb refuses because a newer turn replaced the failed one is no failure: logged, not thrown", async () => {
    // bb's answer on 2026-10-02 (thr_2stddgrdfb): a message sent after the
    // failed turn started a newer one, whose own failure is handled apart.
    const h = await host(ALL_FREE, {
      retryError: {
        message:
          "HTTP 409: Turn creq_1 is not the failed turn on thread thread-1; its most recent turn is creq_2.",
        code: "invalid_request",
        status: 409,
      },
    });
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "warn"),
    ).toEqual([]);
    expect(h.harness.logEntries.map((entry) => entry.message)).toContain(
      "thread thread-1: turn creq_1 is no longer its latest; the newer turn goes on",
    );
    // Any other refusal of the retry, a 409 included, is still reported.
    const other = await host(ALL_FREE, {
      retryError: { message: "HTTP 409: Conflict", status: 409 },
    });
    const disposeFirst = dispose;
    dispose = () => {
      disposeFirst?.();
      other.harness.dispose();
    };
    const refused = await other.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(refused.errors.map(String)).toEqual([
      expect.stringMatching(/HTTP 409: Conflict/),
    ]);
  });

  it("a wait on the CURRENT account also counts as the project's last move: a leftover thread waits for the same reset instead of retrying at once", async () => {
    let clock = NOW;
    let workFree = true;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(100, 60)),
        work: () => Response.json(payload(workFree ? 5 : 100, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    // 1. thread-1 fails on main: moves to work.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    // 2. thread-1's retry fails on work, and now every account is blocked
    // until +2 h (work's own measurement bounds it, whatever the provider
    // reported): an exact tie, so a wait on the current account, no move.
    workFree = false;
    clock = NOW + 1_000;
    const again = failure({ requestId: "creq_1r", attemptNumber: 2 });
    again.rateLimits!.windows[0]!.resetsAtMs = NOW + HOUR;
    await h.harness.behavior.emitThreadEvent("turn.failed", again);
    expect(h.retries[1]).toMatchObject({
      threadId: "thread-1",
      reason: "Waiting for work",
      sendAt: NOW + 2 * HOUR + BUFFER,
    });
    expect(h.envSet).toHaveLength(1);
    // 3. Another thread of the project fails right after: the project is
    // waiting on work, so it waits for the same reset (not "retry now" on
    // an account known to be blocked for an hour).
    clock = NOW + 2_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_3" }),
    );
    expect(h.retries[2]).toEqual({
      threadId: "thread-3",
      turnRequestId: "creq_3",
      reason: "Retrying on account work",
      sendAt: NOW + 2 * HOUR + BUFFER,
    });
    expect(h.usageCalls).toHaveLength(6);
  });

  it("prefers an account that can still run the preferred model", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(50, 50, 30)),
      },
      { settings: { preferredModel: "Fable" } },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries[0]?.reason).toBe("Switched to account work (Fable)");
  });

  it("waiting for ANOTHER account's reset moves the project to it before queueing the retry", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(1, 1, 100)),
        work: () => Response.json(payload(1, 1, 100)),
      },
      { settings: { preferredModel: "Fable", maximumWaitHours: 0 } },
    );
    dispose = () => h.harness.dispose();
    // Fable resets at +4 h on main and spare... but work's payload says +4 h too;
    // make spare the earliest by hand.
    h.harness.sdk.stub("threads.get", async () =>
      thread({ id: "thread-1", projectId: "proj-1" }),
    );
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(
      state.accounts.every(
        (a) => a.usage?.models["Fable"]?.usedPercent === 100,
      ),
    ).toBe(true);
    // All three reset Fable at the same time: the tie goes to the first
    // account measured (main), which needs no move. Use a later failure
    // report for main so spare is earlier.
    const f = failure();
    f.rateLimits!.windows[0]!.resetsAtMs = NOW + 9 * HOUR;
    await h.harness.behavior.emitThreadEvent("turn.failed", f);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        sendAt: NOW + 4 * HOUR + BUFFER,
        reason: "Waiting for Fable on spare",
      },
    ]);
    expect(state.projects[0]?.account).toBeNull();
    const after = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(after.projects[0]?.account).toBe("spare");
  });

  it("retries a turn that started on the old account on the new one, however long after the switch it fails", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(100, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    // thread-3 starts a long turn on main (the project's account then).
    await h.harness.behavior.emitThreadEvent("thread.active", {
      thread: thread({ id: "thread-3", projectId: "proj-1" }),
    });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    // Its turn fails 5 minutes later, still on main: not work's failure.
    clock = NOW + 5 * 60_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_9" }),
    );
    expect(h.retries.map((r) => [r.threadId, r.reason, r.sendAt])).toEqual([
      ["thread-1", "Switched to account work", undefined],
      ["thread-3", "Retrying on account work", undefined],
    ]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
  });

  it("retries a straggler blind once: its retry failing at the door is judged", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.active", {
      thread: thread({ id: "thread-3", projectId: "proj-1" }),
    });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    clock = NOW + 5 * 60_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_9" }),
    );
    expect(h.retries[1]?.reason).toBe("Retrying on account work");
    // The retry fails before any thread.active announces it: work's own failure.
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_10", attemptNumber: 2 }),
    );
    expect(h.retries[2]?.reason).toBe("Switched to account spare");
  });

  it("judges a turn that started on the project's current account", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(100, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    // thread-3 starts after the switch, on work.
    await h.harness.behavior.emitThreadEvent("thread.active", {
      thread: thread({ id: "thread-3", projectId: "proj-1" }),
    });
    clock = NOW + 5 * 60_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_9" }),
    );
    expect(h.retries[1]?.reason).not.toBe("Retrying on account work");
    expect(h.usageCalls.length).toBe(6);
  });

  it("a second turn of the same project failing right after a switch is retried on the new account, not switched again", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(100, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    clock = NOW + 60_000; // last millisecond of the grace window
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_9" }),
    );
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries.map((r) => [r.threadId, r.reason, r.sendAt])).toEqual([
      ["thread-1", "Switched to account work", undefined],
      ["thread-3", "Retrying on account work", undefined],
    ]);
    // The usage was measured once for the switch; the leftover needed no query.
    expect(h.usageCalls).toEqual(["main", "spare", "work"]);
    // Past the grace window the same failure is judged on its own: main and
    // spare free at +2 h, work (the project's account) at +3 h by the
    // provider's own report, so a wait that moves the project to main.
    clock = NOW + 60_001;
    const late = failure({ threadId: "thread-4", requestId: "creq_10" });
    late.rateLimits!.windows[0]!.resetsAtMs = NOW + 3 * HOUR;
    await h.harness.behavior.emitThreadEvent("turn.failed", late);
    expect(h.usageCalls.length).toBe(6);
    expect(h.retries[2]).toMatchObject({
      threadId: "thread-4",
      reason: "Waiting for main",
      sendAt: NOW + 2 * HOUR + BUFFER,
    });
    expect(h.envDeleted).toEqual([{ projectId: "proj-1", name: ENV_VAR }]);
    // A leftover of another thread right after that wait (whatever its
    // attempt: a leftover can be a retry too) waits for the same reset on
    // the account the wait moved the project to, without measuring.
    clock = NOW + 60_002;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-5", requestId: "creq_11", attemptNumber: 2 }),
    );
    expect(h.usageCalls.length).toBe(6);
    expect(h.retries[3]).toEqual({
      threadId: "thread-5",
      turnRequestId: "creq_11",
      reason: "Retrying on account main",
      sendAt: NOW + 2 * HOUR + BUFFER,
    });
    // Each thread gets that grace once: its second failure in the window
    // means the new account fails too, so it is judged afresh (measured).
    // (Its queued retry ran and failed again, so it has left the queue.)
    h.queued.splice(
      h.queued.findIndex((r) => r.threadId === "thread-5"),
      1,
    );
    clock = NOW + 60_003;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-5", requestId: "creq_12", attemptNumber: 3 }),
    );
    expect(h.usageCalls.length).toBe(9);
    // Judged afresh: work is free again.
    expect(h.retries[4]).toEqual({
      threadId: "thread-5",
      turnRequestId: "creq_12",
      reason: "Switched to account work",
    });
    expect(h.sent).toEqual([]);
  });

  it("the switched turn failing again on the new account is judged afresh, and after the switch the failed turn's own retry is not mistaken for a leftover", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(8, 60)),
      work: () => Response.json(payload(5, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    // Same thread, same turn, second attempt: work is exhausted after all.
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ attemptNumber: 2 }),
    );
    expect(h.envSet.map((e) => e.value)).toEqual([
      `${ACCOUNTS}/work`,
      `${ACCOUNTS}/spare`,
    ]);
    expect(h.retries[1]?.reason).toBe("Switched to account spare");
  });

  it("serialises simultaneous failures of one project: one measurement, one switch", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await Promise.all([
      h.harness.behavior.emitThreadEvent("turn.failed", failure()),
      h.harness.behavior.emitThreadEvent(
        "turn.failed",
        failure({ threadId: "thread-3", requestId: "creq_9" }),
      ),
    ]);
    expect(h.usageCalls).toEqual(["main", "spare", "work"]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries.map((r) => r.reason).sort()).toEqual([
      "Retrying on account work",
      "Switched to account work",
    ]);
  });

  it("still retries the turn when recording the switch in storage fails", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    h.bb.storage.kv.set = async () => {
      throw new Error("disk full");
    };
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries.map((r) => r.reason)).toEqual(["Switched to account work"]);
  });

  it("switches back to the default account by removing the env var", async () => {
    const h = await host({
      main: () => Response.json(payload(1, 1)),
      spare: () => Response.json(payload(100, 1)),
      work: () => Response.json(payload(100, 1)),
    });
    dispose = () => h.harness.dispose();
    // Measured first: a pick of an account measured out gets no grace.
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "spare",
    });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envDeleted).toEqual([{ projectId: "proj-1", name: ENV_VAR }]);
    expect(h.retries[0]?.reason).toBe("Switched to account main");
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    // Back on the default account = no CLAUDE_CONFIG_DIR on the project.
    expect(state.projects[0]).toMatchObject({ account: null, external: false });
  });

  it("reads each project's account from its CLAUDE_CONFIG_DIR variable and never touches one it did not write", async () => {
    const h = await host(ALL_FREE, {
      presetEnv: {
        "proj-1": [
          { name: ENV_VAR, note: ownNote("spare"), secret: true, value: null },
        ],
        "proj-2": [
          { name: ENV_VAR, note: "set by hand", secret: true, value: null },
        ],
      },
    });
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.projects).toEqual([
      { id: "proj-1", name: "Website", account: "spare", owned: true, external: false },
      { id: "proj-2", name: "Other", account: null, owned: false, external: true },
      { id: "personal", name: "Personal", account: null, owned: false, external: false },
    ]);
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thr-2" }),
    );
    expect(errors).toEqual([]);
    expect(h.retries).toEqual([]);
    expect(h.envSet).toEqual([]);
    await expect(
      h.harness.behavior.callRpc("project_set_account", {
        projectId: "proj-2",
        account: null,
      }),
    ).rejects.toThrow(/set outside this plugin/);
    expect(h.envDeleted).toEqual([]);
    // Unpinning a project that has no variable deletes nothing.
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: null,
    });
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: null,
    });
    expect(h.envDeleted).toEqual([{ projectId: "proj-1", name: ENV_VAR }]);
  });

  it("recovers a project whose own variable names an account that no longer exists", async () => {
    const h = await host(ALL_FREE, {
      presetEnv: {
        "proj-1": [
          { name: ENV_VAR, note: ownNote("ghost"), secret: true, value: null },
        ],
      },
    });
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    // Ours, so not external; the account it names is gone, so none (but owned: the UI offers to clear it).
    expect(state.projects[0]).toMatchObject({
      account: null,
      owned: true,
      external: false,
    });
    // Pinning it to the default removes the stale variable...
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: null,
    });
    expect(h.envDeleted).toEqual([{ projectId: "proj-1", name: ENV_VAR }]);
    // ...and a switch would have replaced it.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
  });

  it("an account that vanished from disk is forgotten: never chosen, never a crash", async () => {
    let dirs = ["spare", "work"];
    const h = await host(ALL_FREE, { dirs: () => dirs });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    dirs = ["spare"];
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );
    expect(errors).toEqual([]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.accounts.map((a) => a.name)).toEqual(["main", "spare"]);
  });

  it("leaves other failures alone without querying any account, and honours the autoSwitch setting", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({
        errorInfo: {
          category: "overloaded",
          providerCode: null,
          httpStatusCode: 529,
        },
        rateLimits: null,
      }),
    );
    const codex = failure();
    codex.rateLimits!.providerId = "codex";
    await h.harness.behavior.emitThreadEvent("turn.failed", codex);
    expect(h.retries).toEqual([]);
    expect(h.usageCalls).toEqual([]);
    expect(h.harness.sdk.callsTo("threads.get")).toEqual([]);
    await h.harness.behavior.setSettings({ autoSwitch: false });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries).toEqual([]);
  });

  it("pins and unpins a project from the CLI and rejects unknown or ambiguous names", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    const ok = await h.harness.behavior.runCli(["use", "Website", "spare"]);
    expect(ok.exitCode).toBe(0);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    const back = await h.harness.behavior.runCli(["use", "proj-1", "default"]);
    expect(back.exitCode).toBe(0);
    expect(h.envDeleted).toEqual([{ projectId: "proj-1", name: ENV_VAR }]);
    const bad = await h.harness.behavior.runCli(["use", "proj-1", "nobody"]);
    expect(bad.exitCode).not.toBe(0);
    const list = await h.harness.behavior.runCli(["list", "--json"]);
    expect(JSON.parse(list.stdout ?? "").projects[0].account).toBeNull();
    h.harness.sdk.stub("projects.list", async () => [
      { id: "proj-1", name: "Twin" },
      { id: "proj-2", name: "Twin" },
    ]);
    const twin = await h.harness.behavior.runCli(["use", "Twin", "spare"]);
    expect(twin.exitCode).not.toBe(0);
    expect(twin.stderr ?? twin.stdout).toMatch(/proj-1, proj-2/);
  });

  it("treats a subdirectory named \"default\" as an account when the default account has another name", async () => {
    const h = await host(
      { ...ALL_FREE, default: () => Response.json(payload(1, 1)) },
      { dirs: () => ["spare", "work", "default"] },
    );
    dispose = () => h.harness.dispose();
    const ok = await h.harness.behavior.runCli(["use", "Website", "default"]);
    expect(ok.exitCode).toBe(0);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/default`]);
    expect(h.envDeleted).toEqual([]);
    // The default account is still reachable by its own name.
    const back = await h.harness.behavior.runCli(["use", "Website", "main"]);
    expect(back.exitCode).toBe(0);
    expect(h.envDeleted).toEqual([{ projectId: "proj-1", name: ENV_VAR }]);
  });

  it("`release` removes every CLAUDE_CONFIG_DIR this plugin wrote (stale ones included) and leaves external ones", async () => {
    const h = await host(ALL_FREE, {
      presetEnv: {
        "proj-1": [
          { name: ENV_VAR, note: ownNote("spare"), secret: true, value: null },
        ],
        "proj-2": [
          { name: ENV_VAR, note: "set by hand", secret: true, value: null },
        ],
      },
    });
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub("projects.list", async () => [
      { id: "proj-1", name: "Website" },
      { id: "proj-2", name: "Other" },
      { id: "proj-3", name: "Ghost" },
    ]);
    h.env.set("proj-3", [
      { name: ENV_VAR, note: ownNote("gone"), secret: true, value: null },
    ]);
    const out = await h.harness.behavior.runCli(["release"]);
    expect(out.exitCode).toBe(0);
    expect(h.envDeleted).toEqual([
      { projectId: "proj-1", name: ENV_VAR },
      { projectId: "proj-3", name: ENV_VAR },
    ]);
    expect(out.stdout).toMatch(/Website/);
    expect(out.stdout).toMatch(/Ghost/);
    expect(out.stdout).toMatch(/Other.*external/);
    // Nothing left of ours: a second run touches nothing.
    const again = await h.harness.behavior.runCli(["release"]);
    expect(again.exitCode).toBe(0);
    expect(h.envDeleted).toHaveLength(2);
  });

  it("a decline closes the project's grace: a leftover thread is judged, not retried on the account just found blocked", async () => {
    let clock = NOW;
    let workFree = true;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(100, 60)),
        work: () => Response.json(payload(workFree ? 5 : 100, 20)),
      },
      { clock: () => clock, settings: { maximumWaitHours: 1 } },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    // Its retry fails on work with everything blocked for 2 h: beyond the
    // maximum wait, so declined.
    workFree = false;
    clock = NOW + 10_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_1r", attemptNumber: 2 }),
    );
    expect(h.retries).toHaveLength(1);
    expect(h.usageCalls).toHaveLength(6);
    // A leftover thread right after is judged on its own (measured) and
    // declined too, instead of being retried at once on work.
    clock = NOW + 11_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-3", requestId: "creq_3" }),
    );
    expect(h.retries).toHaveLength(1);
    expect(h.usageCalls).toHaveLength(9);
  });

  it("stops trusting a blocked measurement the usage endpoint no longer confirms after 2 × refreshMinutes: declines instead of guessing a reset passed", async () => {
    let clock = NOW;
    let endpointDown = false;
    const answer = () =>
      endpointDown
        ? new Response("", { status: 429 })
        : Response.json(payload(100, 40));
    const h = await host(
      { main: answer, spare: answer, work: answer },
      { clock: () => clock, settings: { refreshMinutes: 1, maximumWaitHours: 0 } },
    );
    dispose = () => h.harness.dispose();
    // Everything blocked until +2 h: a wait on the current account.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual(["Waiting for main"]);
    // The endpoint stops answering. One minute later the measurement is
    // still younger than 2 × 1 min: trusted, so the same wait.
    endpointDown = true;
    clock = NOW + 60_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_1b", attemptNumber: 2 }),
    );
    expect(h.retries.map((r) => r.reason)).toEqual([
      "Waiting for main",
      "Waiting for main",
    ]);
    // Half an hour later: far older than the limit, but its reset (+2 h)
    // is still ahead, so the wait is known, not guessed: the same wait.
    clock = NOW + 30 * 60_000;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_1c", attemptNumber: 3 }),
    );
    expect(h.retries.map((r) => r.reason)).toEqual([
      "Waiting for main",
      "Waiting for main",
      "Waiting for main",
    ]);
    // Past the measured reset, still unanswered: only the clock would say
    // it is free, so no switch and no retry.
    clock = NOW + 2 * HOUR + 1;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_1d", attemptNumber: 4 }),
    );
    expect(h.retries).toHaveLength(3);
    expect(h.envSet).toEqual([]);
  });

  it("the same, for the preferred model's window: an unconfirmed old Fable lock is not freed by the clock", async () => {
    let clock = NOW;
    let endpointDown = false;
    const answer = (fable: number) => () =>
      endpointDown
        ? new Response("", { status: 429 })
        : Response.json(payload(30, 40, fable));
    const h = await host(
      { main: answer(100), spare: answer(100), work: answer(100) },
      {
        clock: () => clock,
        settings: { preferredModel: "Fable", refreshMinutes: 1, maximumWaitHours: 0 },
      },
    );
    dispose = () => h.harness.dispose();
    // Fable exhausted everywhere until +4 h: a wait.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual(["Waiting for Fable on main"]);
    // Past that reset with the endpoint down since: nothing confirmed, so
    // no switch and no retry (the clock alone does not free a model).
    endpointDown = true;
    clock = NOW + 4 * HOUR + 1;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_1b", attemptNumber: 2 }),
    );
    expect(h.retries).toHaveLength(1);
    expect(h.envSet).toEqual([]);
  });

  it("`release` reports a project it could not release and still releases the rest", async () => {
    const h = await host(ALL_FREE, {
      presetEnv: {
        "proj-1": [
          { name: ENV_VAR, note: ownNote("spare"), secret: true, value: null },
        ],
        "proj-2": [
          { name: ENV_VAR, note: ownNote("work"), secret: true, value: null },
        ],
      },
      failDelete: ["proj-1"],
    });
    dispose = () => h.harness.dispose();
    const out = await h.harness.behavior.runCli(["release"]);
    expect(out.exitCode).toBe(1);
    expect(h.envDeleted).toEqual([{ projectId: "proj-2", name: ENV_VAR }]);
    expect(out.stdout).toMatch(/Other\treleased \(was work\)/);
    expect(out.stdout).toMatch(/Website\tNOT released.*404/);
  });

  it("refreshes in the background and stops when the service is aborted", async () => {
    const h = await host(ALL_FREE, { settings: { refreshMinutes: 1 } });
    dispose = () => h.harness.dispose();
    const run = h.harness.behavior.runService("usage-refresh");
    await vi.waitFor(() => {
      expect(h.usageCalls).toEqual(["main", "spare", "work"]);
    });
    run.controller.abort();
    await run.done;
  });
});

describe("placing a project before a new thread's first turn", () => {
  /** `main` (the default) is out of Fable; `work` has the lowest session use. */
  const MAIN_OUT_OF_FABLE = {
    main: () => Response.json(payload(10, 40, 100)),
    spare: () => Response.json(payload(10, 60, 20)),
    work: () => Response.json(payload(5, 20, 30)),
  };
  const FABLE = { settings: { preferredModel: "Fable" } };

  function created(overrides: Partial<ThreadResponse>) {
    return { thread: thread(overrides) };
  }

  it("puts a project created after install on the best account at its first thread, measuring first when nothing is measured", async () => {
    const h = await host(MAIN_OUT_OF_FABLE, FABLE);
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thr-new", projectId: "proj-3" }),
    );
    expect(errors).toEqual([]);
    expect(h.usageCalls).toEqual(["main", "spare", "work"]);
    expect(h.envSet).toEqual([
      {
        projectId: "proj-3",
        name: ENV_VAR,
        value: `${ACCOUNTS}/work`,
        note: ownNote("work"),
      },
    ]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.lastSwitch).toMatchObject({
      threadId: "thr-new",
      projectId: "proj-3",
      from: "main",
      to: "work",
      reason: "New project placed on account work (Fable)",
    });
    // Seen once: its next thread leaves it alone while its account works.
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-3",
      account: "spare",
    });
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thr-new-2", projectId: "proj-3" }),
    );
    expect(h.envSet.map((e) => e.value)).toEqual([
      `${ACCOUNTS}/work`,
      `${ACCOUNTS}/spare`,
    ]);
  });

  it("leaves a new project on the default account when that is the best one, without writing anything", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(1, 10, 0)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thr-new", projectId: "proj-3" }),
    );
    expect(h.envSet).toEqual([]);
    expect(h.envDeleted).toEqual([]);
  });

  it("never moves a project that existed at install while its account can run, even when another ranks better", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(90, 40, 99)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(0, 20, 0)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thread-1", projectId: "proj-1" }),
    );
    expect(h.envSet).toEqual([]);
  });

  it("moves an existing project off an account already measured out of the preferred model, so the first turn does not fail", async () => {
    const h = await host(MAIN_OUT_OF_FABLE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const measured = h.usageCalls.length;
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thr-a", projectId: "proj-1" }),
    );
    // Decided on the measurement already there: no query in the way of the turn.
    expect(h.usageCalls.length).toBe(measured);
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.lastSwitch).toMatchObject({
      threadId: "thr-a",
      from: "main",
      to: "work",
      reason: "Moved to account work before the turn: main cannot run Fable",
    });
    // A turn of another thread still running on `main` fails: it follows the move.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual(["Retrying on account work"]);
    expect(h.envSet).toHaveLength(1);
  });

  it("moves no project for being new when the list of known projects cannot be read, and still moves one off a blocked account", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(1, 10, 0)),
        spare: () => Response.json(payload(0, 60, 20)),
        work: () => Response.json(payload(0, 20, 30)),
      },
      { ...FABLE, kvReadError: "database is locked" },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thr-new", projectId: "proj-3" }),
    );
    expect(h.envSet).toEqual([]);
    const blocked = await host(MAIN_OUT_OF_FABLE, {
      ...FABLE,
      kvReadError: "database is locked",
    });
    await blocked.harness.behavior.emitThreadEvent(
      "thread.created",
      created({ id: "thr-new", projectId: "proj-3" }),
    );
    expect(blocked.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    blocked.harness.dispose();
  });

  it("leaves hidden threads, other providers, external variables and autoSwitch off alone", async () => {
    const cases: Array<[Partial<ThreadResponse>, HostOptions]> = [
      [{ visibility: "hidden" }, FABLE],
      [{ visibility: "hidden", originPluginId: "bb-recap" }, FABLE],
      [{ providerId: "codex" }, FABLE],
      [{}, { settings: { preferredModel: "Fable", autoSwitch: false } }],
      [
        {},
        {
          ...FABLE,
          presetEnv: {
            "proj-3": [{ name: ENV_VAR, note: "mine", secret: true, value: null }],
          },
        },
      ],
    ];
    for (const [overrides, options] of cases) {
      const h = await host(MAIN_OUT_OF_FABLE, options);
      const { errors } = await h.harness.behavior.emitThreadEvent(
        "thread.created",
        created({ id: "thr-x", projectId: "proj-3", ...overrides }),
      );
      expect(errors).toEqual([]);
      expect(h.envSet).toEqual([]);
      h.harness.dispose();
    }
  });
});

describe("failures this plugin must not act on", () => {
  it("ignores a failed turn of a hidden thread, whoever opened it", async () => {
    for (const threads of [
      { "thread-1": { visibility: "hidden" as const } },
      { "thread-1": { visibility: "hidden" as const, originPluginId: "bb-recap" } },
    ]) {
      const h = await host(ALL_FREE, { threads });
      const { errors } = await h.harness.behavior.emitThreadEvent(
        "turn.failed",
        failure(),
      );
      expect(errors).toEqual([]);
      expect(h.envSet).toEqual([]);
      expect(h.retries).toEqual([]);
      expect(h.usageCalls).toEqual([]);
      h.harness.dispose();
    }
  });
});

describe("changing the accounts directory", () => {
  it("lets `use` pick an account of the new directory at once, without a refresh first", async () => {
    const h = await host(ALL_FREE, {
      settings: { accountsDir: "/Users/someone/elsewhere" },
    });
    dispose = () => h.harness.dispose();
    const before = await h.harness.behavior.runCli(["list"]);
    expect(before.stdout).not.toMatch(/spare/);
    await h.harness.behavior.setSettings({ accountsDir: ACCOUNTS });
    const out = await h.harness.behavior.runCli(["use", "Website", "spare"]);
    expect(out.exitCode).toBe(0);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
  });
});

describe("placement: the cases the first review found", () => {
  const OUT = {
    main: () => Response.json(payload(10, 40, 100)),
    spare: () => Response.json(payload(10, 60, 20)),
    work: () => Response.json(payload(5, 20, 30)),
  };
  const FABLE = { settings: { preferredModel: "Fable" } };
  const created = (id: string, projectId: string, extra: Partial<ThreadResponse> = {}) => ({
    thread: thread({ id, projectId, ...extra }),
  });

  it("retries the placing thread's own first failure on the new account once, instead of judging the new account as the one that failed", async () => {
    const h = await host(OUT, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-1"));
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    // Its first turn had already started on `main` and fails there.
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thr-a" }),
    );
    expect(h.retries).toEqual([
      { threadId: "thr-a", turnRequestId: "creq_1", reason: "Retrying on account work" },
    ]);
    expect(h.envSet).toHaveLength(1);
  });

  it("does not take a usage answer with a missing window as proof that a project's account is out", async () => {
    const h = await host(
      {
        main: () =>
          Response.json({
            limits: [
              {
                kind: "weekly_all",
                percent: 10,
                resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
              },
            ],
            five_hour: { locked_reason: null },
            seven_day: { locked_reason: null },
          }),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-1"));
    expect(h.envSet).toEqual([]);
  });

  it("after the accounts directory changes, never places on an account of the old directory", async () => {
    const h = await host(OUT, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.setSettings({ accountsDir: "/Users/someone/elsewhere" });
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-new", "proj-3"),
    );
    expect(errors).toEqual([]);
    expect(h.envSet).toEqual([]);
  });

  it("keeps a new project new when it could not be placed, and places it at its next thread", async () => {
    // `main` still works, so only being new can move proj-3.
    const failSet = ["proj-3"];
    const failing = await host(
      {
        main: () => Response.json(payload(1, 10, 0)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(0, 20, 30)),
      },
      { ...FABLE, failSet },
    );
    const first = await failing.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-1", "proj-3"),
    );
    expect(first.errors).toHaveLength(1);
    expect(failing.envSet).toEqual([]);
    failSet.length = 0;
    await failing.harness.behavior.emitThreadEvent("thread.created", created("thr-2", "proj-3"));
    expect(failing.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    failing.harness.dispose();

    let down = true;
    const h = await host(
      {
        main: () => (down ? new Response("down", { status: 503 }) : Response.json(payload(1, 10, 0))),
        spare: () => (down ? new Response("down", { status: 503 }) : Response.json(payload(10, 60, 20))),
        work: () => (down ? new Response("down", { status: 503 }) : Response.json(payload(0, 20, 30))),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-1", "proj-3"));
    expect(h.envSet).toEqual([]);
    down = false;
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-2", "proj-3"));
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
  });

  it("never moves a new project the user already pinned by hand, the default account included", async () => {
    const h = await host(OUT, {
      settings: { preferredModel: "" },
      projectCreatedAt: { "proj-1": NOW + 1_000 },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: null,
    });
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-1"));
    expect(h.envSet).toEqual([]);
    const cli = await host(OUT, {
      settings: { preferredModel: "" },
      projectCreatedAt: { "proj-1": NOW + 1_000 },
    });
    await cli.harness.behavior.runCli(["use", "Website", "default"]);
    await cli.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-1"));
    expect(cli.envSet).toEqual([]);
    cli.harness.dispose();
  });

  it("does not treat a project that got a thread while automatic switching was off as new once it is on", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(1, 10, 0)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(0, 20, 30)),
      },
      { settings: { preferredModel: "Fable", autoSwitch: false } },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-1", "proj-3"));
    await h.harness.behavior.setSettings({ autoSwitch: true });
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-2", "proj-3"));
    expect(h.envSet).toEqual([]);
  });

  it("the views' lists share one read of the projects' accounts; a switch made here, a failed read or 30 s mean a new one", async () => {
    let clock = NOW;
    const h = await host(ALL_FREE, { clock: () => clock });
    dispose = () => h.harness.dispose();
    const list = () =>
      h.harness.behavior.callRpc("accounts_list", null) as Promise<State>;
    const proj1 = (state: State) => state.projects.find((p) => p.id === "proj-1");
    await list();
    const reads = () => [...h.envReads].sort();
    h.envReads.length = 0;
    // Every open header refetches on the same event: one read per project.
    clock = NOW + 30_000;
    await Promise.all([list(), list()]);
    expect(reads()).toEqual(["personal", "proj-1", "proj-2"]);
    clock = NOW + 59_999;
    await list();
    expect(h.envReads).toHaveLength(3);
    clock = NOW + 60_000;
    await list();
    expect(h.envReads).toHaveLength(6);
    // A switch made here (a turn of proj-1 out on main) shows in the next list at once.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.projectId)).toEqual(["proj-1"]);
    expect(proj1(await list())).toMatchObject({ account: "work", owned: true });
    // Asked for by hand, the answer is fresh, whatever the views share.
    const changed = (await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "spare",
    })) as State;
    expect(proj1(changed)).toMatchObject({ account: "spare", owned: true });
    // A failed read is not kept: the next list, at the same time, reads again.
    clock = NOW + 120_000;
    let fail = true;
    h.harness.sdk.stub("projects.machineEnvironment", async () => {
      if (fail) throw new Error("HTTP 503: bb is busy");
      return { builtInGit: { status: "disabled" as const, statusMessage: "" }, inheritedVariables: [], variables: [] };
    });
    await expect(list()).rejects.toThrow(/503/);
    fail = false;
    expect(proj1(await list())).toMatchObject({ account: null, owned: false });
  });

  it("a view asking for a project the shared read lacks gets a fresh read, which the next lists share", async () => {
    let clock = NOW;
    const h = await host(ALL_FREE, { clock: () => clock });
    dispose = () => h.harness.dispose();
    const list = (input: { project: string } | null = null) =>
      h.harness.behavior.callRpc("accounts_list", input) as Promise<State>;
    const ids = (state: State) => state.projects.map((p) => p.id);
    await list();
    // A project made a moment later, picked in the new-thread composer.
    h.harness.sdk.stub("projects.list", async () => [
      { id: "proj-1", name: "Website" },
      { id: "proj-2", name: "Other" },
      { id: "proj-3", name: "New" },
      { id: "personal", name: "Personal" },
    ]);
    clock = NOW + 5_000;
    h.envReads.length = 0;
    expect(ids(await list())).not.toContain("proj-3");
    // Asked for a project the read has: still shared.
    expect(ids(await list({ project: "proj-1" }))).not.toContain("proj-3");
    expect(h.envReads).toEqual([]);
    // Asked for the one it lacks: read again.
    expect(ids(await list({ project: "proj-3" }))).toContain("proj-3");
    expect(h.envReads).toHaveLength(4);
    // The next lists share that read.
    expect(ids(await list())).toContain("proj-3");
    expect(h.envReads).toHaveLength(4);
    // Two views asking at once for a project the read lacks share one read.
    h.harness.sdk.stub("projects.list", async () => [
      { id: "proj-1", name: "Website" },
      { id: "proj-2", name: "Other" },
      { id: "proj-3", name: "New" },
      { id: "proj-4", name: "Newer" },
      { id: "personal", name: "Personal" },
    ]);
    h.envReads.length = 0;
    const both = await Promise.all([
      list({ project: "proj-4" }),
      list({ project: "proj-4" }),
    ]);
    expect(both.map(ids)).toEqual([
      ["proj-1", "proj-2", "proj-3", "proj-4", "personal"],
      ["proj-1", "proj-2", "proj-3", "proj-4", "personal"],
    ]);
    expect(h.envReads).toHaveLength(5);
    // A project bb does not list is read for once per shared read, not on
    // every ask.
    h.envReads.length = 0;
    expect(ids(await list({ project: "ghost" }))).not.toContain("ghost");
    expect(h.envReads).toHaveLength(5);
    expect(ids(await list({ project: "ghost" }))).not.toContain("ghost");
    expect(h.envReads).toHaveLength(5);
  });

  it("a list after the accounts change names each project's account by the new set, not by the shared read", async () => {
    let dirs = ["work"];
    const h = await host(ALL_FREE, {
      dirs: () => dirs,
      presetEnv: {
        "proj-1": [
          { name: ENV_VAR, note: ownNote("spare"), secret: true, value: null },
        ],
      },
    });
    dispose = () => h.harness.dispose();
    const list = () =>
      h.harness.behavior.callRpc("accounts_list", null) as Promise<State>;
    const proj1 = (state: State) => state.projects.find((p) => p.id === "proj-1");
    // spare is not found yet: its project shows no known account.
    expect(proj1(await list())).toMatchObject({ account: null, owned: true });
    // Its directory appears (a login); the periodic refresh finds it.
    dirs = ["work", "spare"];
    const run = h.harness.behavior.runService("usage-refresh");
    await vi.waitFor(() => {
      expect(h.usageCalls).toContain("spare");
    });
    run.controller.abort();
    await run.done;
    expect(proj1(await list())).toMatchObject({ account: "spare", owned: true });
  });

  it("a list after a switch made here shows it, even while an older read is still under way", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    const list = () =>
      h.harness.behavior.callRpc("accounts_list", null) as Promise<State>;
    const proj1 = (state: State) => state.projects.find((p) => p.id === "proj-1");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    // Like bb: a read answers with what was there when it started.
    h.harness.sdk.stub(
      "projects.machineEnvironment",
      async ({ projectId }: { projectId: string }) => {
        const snapshot = {
          builtInGit: { status: "disabled" as const, statusMessage: "" },
          inheritedVariables: [],
          variables: [...(h.env.get(projectId) ?? [])],
        };
        if (holding) await held;
        return snapshot;
      },
    );
    const older = list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    holding = false;
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.projectId)).toEqual(["proj-1"]);
    expect(proj1(await list())).toMatchObject({ account: "work", owned: true });
    release();
    // The older read answers its own caller, and is not what is shared after.
    expect(proj1(await older)).toMatchObject({ account: null, owned: false });
    expect(proj1(await list())).toMatchObject({ account: "work", owned: true });
  });

  it("a list after a switch made here shows it, even when a view listed while the switch was being written", async () => {
    let duringWrite: () => Promise<unknown> = async () => {};
    const h = await host(ALL_FREE, { beforeSet: () => duringWrite() });
    dispose = () => h.harness.dispose();
    const list = () =>
      h.harness.behavior.callRpc("accounts_list", null) as Promise<State>;
    const proj1 = (state: State) => state.projects.find((p) => p.id === "proj-1");
    let listedDuring: State | undefined;
    duringWrite = async () => {
      listedDuring = await list();
    };
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.projectId)).toEqual(["proj-1"]);
    // The view that listed mid-write saw the old account; the next list shows the switch.
    expect(listedDuring && proj1(listedDuring)).toMatchObject({ account: null, owned: false });
    expect(proj1(await list())).toMatchObject({ account: "work", owned: true });
  });

  it("treats every project created before the plugin was first installed as known, and survives garbage in storage", async () => {
    const h = await host(OUT, {
      ...FABLE,
      kvPreset: { "installed-at": NOW - HOUR, "handled-projects": { "proj-4": true } },
      projectCreatedAt: { "proj-3": NOW - 2 * HOUR, "proj-4": NOW - 1 },
    });
    dispose = () => h.harness.dispose();
    // Created before install and its account works: stays.
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "spare",
    });
    const before = h.envSet.length;
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-3", "proj-3", {}));
    // proj-3 is on main (out of Fable): moved as a blocked known project, not as new.
    expect(h.envSet.slice(before).map((e) => e.projectId)).toEqual(["proj-3"]);
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.lastSwitch?.reason).toMatch(/before the turn/);
    // Created after install (NOW - HOUR): new.
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-4", "proj-4"));
    const after = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(after.lastSwitch?.reason).toBe("New project placed on account work (Fable)");
  });

  it("treats a project already on an account this plugin set as placed, even if the storage forgot it", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(1, 10, 0)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(0, 20, 30)),
      },
      {
        ...FABLE,
        presetEnv: {
          "proj-3": [{ name: ENV_VAR, note: ownNote("spare"), secret: true, value: null }],
        },
      },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-new", "proj-3"));
    expect(h.envSet).toEqual([]);
  });

  it("does not overwrite an account the user picked while the plugin was deciding", async () => {
    const h = await host(OUT, FABLE);
    dispose = () => h.harness.dispose();
    let reads = 0;
    h.harness.sdk.stub("projects.machineEnvironment", async () => ({
      builtInGit: { status: "disabled" as const, statusMessage: "" },
      inheritedVariables: [],
      variables:
        reads++ === 0
          ? []
          : [{ name: ENV_VAR, note: ownNote("spare"), secret: true as const, value: null }],
    }));
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-new", "proj-3"));
    expect(h.envSet).toEqual([]);
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.lastSwitch).toBeNull();
  });

  it("says why it moved a project when no preferred model is set", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      {},
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-1"));
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.lastSwitch?.reason).toBe(
      "Moved to account work before the turn: main is out of usage",
    );
  });

  it("still acts when bb leaves out a thread's origin, and on a failed turn whatever provider id the thread row carries", async () => {
    const h = await host(OUT, {
      ...FABLE,
      threads: { "thread-1": { providerId: "claude-code-v2", originPluginId: undefined } },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-3", { originPluginId: undefined }));
    expect(h.envSet.map((e) => e.projectId)).toEqual(["proj-3"]);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.projectId)).toEqual(["proj-3", "proj-1"]);
  });
});

describe("accounts added on disk", () => {
  it("lets `use` and the picker pick an account directory created after the last discovery, without a refresh", async () => {
    const dirs = ["spare"];
    const h = await host(ALL_FREE, { dirs: () => dirs });
    dispose = () => h.harness.dispose();
    const before = await h.harness.behavior.runCli(["list"]);
    expect(before.stdout).not.toMatch(/work/);
    dirs.push("work");
    expect((await h.harness.behavior.runCli(["use", "Website", "work"])).exitCode).toBe(0);
    dirs.push("default");
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-2",
      account: "default",
    });
    expect(h.envSet.map((e) => e.value)).toEqual([
      `${ACCOUNTS}/work`,
      `${ACCOUNTS}/default`,
    ]);
  });
});

describe("placement: the cases the second review found", () => {
  const FABLE = { settings: { preferredModel: "Fable" } };
  const created = (id: string, projectId: string) => ({
    thread: thread({ id, projectId }),
  });

  it("measures the accounts it has not measured yet before deciding where a new project goes", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(10, 40, 100)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    // Only `main` measured (the startup refresh is still going).
    await h.harness.behavior.callRpc(usageListMethod, {});
    await h.harness.behavior.callRpc(usageFetchMethod, {
      resourceId: "main",
      refresh: true,
    });
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-new", "proj-3"));
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
  });

  it("moves a project once when its thread's creation and first failure arrive together", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(10, 40, 100)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      { ...FABLE, threads: { "thr-a": { projectId: "proj-3" } } },
    );
    dispose = () => h.harness.dispose();
    await Promise.all([
      h.harness.behavior.emitThreadEvent("thread.created", created("thr-a", "proj-3")),
      h.harness.behavior.emitThreadEvent("turn.failed", failure({ threadId: "thr-a" })),
    ]);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries).toEqual([
      { threadId: "thr-a", turnRequestId: "creq_1", reason: "Retrying on account work" },
    ]);
  });

  it("leaves a new project it kept where it is at its next thread, even when another account has become better", async () => {
    let mainSession = 1;
    const h = await host(
      {
        main: () => Response.json(payload(mainSession, 10, 0)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-1", "proj-3"));
    expect(h.envSet).toEqual([]);
    // `main` is busier now, but it still works: the project stays.
    mainSession = 50;
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.emitThreadEvent("thread.created", created("thr-2", "proj-3"));
    expect(h.envSet).toEqual([]);
  });
});

describe("placement: the cases the third review found", () => {
  const OUT = {
    main: () => Response.json(payload(10, 40, 100)),
    spare: () => Response.json(payload(10, 60, 20)),
    work: () => Response.json(payload(5, 20, 30)),
  };
  const FABLE = { settings: { preferredModel: "Fable" } };

  it("treats a visible thread another plugin's composer opened as the user's: placed, and switched on a limit", async () => {
    const h = await host(OUT, {
      ...FABLE,
      threads: { "thr-p": { projectId: "proj-1", originPluginId: "some-composer" } },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", {
      thread: thread({ id: "thr-p", projectId: "proj-3", originPluginId: "some-composer" }),
    });
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-3", `${ACCOUNTS}/work`],
    ]);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure({ threadId: "thr-p" }));
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-3", `${ACCOUNTS}/work`],
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
  });

  it("lets a pick of the default account made while the project is being placed win", async () => {
    const h = await host(OUT, FABLE);
    dispose = () => h.harness.dispose();
    // Nothing measured yet: placement measures first, and the pick lands meanwhile.
    await Promise.all([
      h.harness.behavior.emitThreadEvent("thread.created", {
        thread: thread({ id: "thr-new", projectId: "proj-3" }),
      }),
      h.harness.behavior.callRpc("project_set_account", {
        projectId: "proj-3",
        account: null,
      }),
    ]);
    // The pick waits for the placement in the project's queue and lands
    // last: whatever the placement wrote, the pick removes it.
    expect(h.envSet.map((e) => e.projectId)).toEqual(["proj-3"]);
    expect(h.envDeleted).toEqual([{ projectId: "proj-3", name: ENV_VAR }]);
  });

  it("still moves a project it already kept once its account is measured out", async () => {
    let mainFable = 0;
    const h = await host(
      {
        main: () => Response.json(payload(1, 10, mainFable)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.created", {
      thread: thread({ id: "thr-1", projectId: "proj-1" }),
    });
    expect(h.envSet).toEqual([]);
    mainFable = 100;
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.emitThreadEvent("thread.created", {
      thread: thread({ id: "thr-2", projectId: "proj-1" }),
    });
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
  });
});

describe("the account shown in each thread's header", () => {
  it("names the best account for the preferred model, or none before anything is measured", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(10, 40, 100)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      { settings: { preferredModel: "Fable" } },
    );
    dispose = () => h.harness.dispose();
    const before = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(before.bestAccount).toBeNull();
    const after = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(after.bestAccount).toBe("work");
  });

  it("names no best account when none can run the preferred model", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(10, 40, 100)),
        spare: () => Response.json(payload(10, 60, 100)),
        work: () => Response.json(payload(100, 20, 30)),
      },
      { settings: { preferredModel: "Fable" } },
    );
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(state.bestAccount).toBeNull();
  });

  it("keeps a hand pick of a working account when a turn left on the old account fails", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => Response.json(payload(5, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    // A turn of the project was already running on main: it fails a moment later.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries.map((r) => [r.reason, r.sendAt])).toEqual([
      ["Retrying on account work", undefined],
    ]);
    // Once per thread: its next failure is judged on work.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure({ requestId: "creq_2" }));
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`, `${ACCOUNTS}/spare`]);
  });

  it("gives the same grace to a pick made with the CLI's use", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => Response.json(payload(5, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.runCli(["use", "proj-1", "work"]);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("keeps a hand pick of an account whose answer lacked its windows when a turn left on the old account fails", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      // An answer without windows: nothing known about work yet.
      work: () =>
        Response.json({
          limits: [],
          five_hour: { locked_reason: null },
          seven_day: { locked_reason: null },
        }),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("keeps a hand pick of an account that runs, though not the preferred model", async () => {
    const h = await host(
      {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 100)),
      },
      { settings: { preferredModel: "Fable" } },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("gives no grace to a hand pick of an account without a login, so the leftover is judged", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => new Response(null, { status: 401 }),
    });
    dispose = () => h.harness.dispose();
    const refreshed = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(refreshed.accounts.find((a) => a.name === "work")?.problem).toEqual({
      kind: "unauthenticated",
    });
    // As in bb, the leftover's turn announced itself when it started on main.
    await h.harness.behavior.emitThreadEvent("thread.active", {
      thread: thread({ id: "thread-1", projectId: "proj-1" }),
    });
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries[0]?.reason).toBe("Switched to account spare");
  });

  it("gives no grace to a hand pick of an account that is out, so its failure is judged", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(100, 60)),
      work: () => Response.json(payload(5, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // As in bb, the leftover's turn announced itself when it started on main.
    await h.harness.behavior.emitThreadEvent("thread.active", {
      thread: thread({ id: "thread-1", projectId: "proj-1" }),
    });
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "spare" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries[0]?.reason).toBe("Switched to account work");
  });

  it("tells the header when an answer lacked a window, so it is not shown as out", async () => {
    const h = await host(
      {
        main: () =>
          Response.json({
            limits: [
              {
                kind: "weekly_all",
                percent: 10,
                resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
              },
            ],
            five_hour: { locked_reason: null },
            seven_day: { locked_reason: null },
          }),
        spare: () => Response.json(payload(10, 60, 20)),
        work: () => Response.json(payload(5, 20, 30)),
      },
      { settings: { preferredModel: "Fable" } },
    );
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    const usage = (name: string) => state.accounts.find((a) => a.name === name)?.usage;
    expect(usage("main")).toMatchObject({ blocked: true, unknown: true });
    expect(usage("work")?.unknown).toBeUndefined();
  });

  it("looks again at an account measured without a login before judging a pick of it", async () => {
    let workLoggedIn = false;
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => (workLoggedIn ? Response.json(payload(5, 20)) : new Response(null, { status: 401 })),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // The user runs claude login for work, then picks it before the next refresh.
    workLoggedIn = true;
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("keeps a hand pick of an account nobody has measured yet", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => Response.json(payload(5, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("keeps a hand pick of an account whose last query failed but whose numbers are fresh", async () => {
    let limited = false;
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => (limited ? new Response("", { status: 429 }) : Response.json(payload(5, 20))),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    limited = true;
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(state.accounts.find((a) => a.name === "work")?.problem?.kind).toBe("error");
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("drops the grace an earlier switch left when the user picks an account that is out", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => Response.json(payload(100, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual(["Switched to account spare"]);
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure({ threadId: "thread-3", requestId: "creq_9" }));
    expect(h.retries[1]?.reason).toBe("Switched to account spare");
  });

  it("keeps a hand pick of an account whose reset has passed since it was measured", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(100, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 2 * HOUR + 60_000;
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries[0]?.reason).toBe("Retrying on account work");
  });

  it("drops the grace of a switch when the CLI's release hands the project back", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual(["Switched to account work"]);
    await h.harness.behavior.runCli(["release"]);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure({ threadId: "thread-3", requestId: "creq_9" }));
    expect(h.retries[1]?.reason).toBe("Switched to account work");
  });

  it("names no best account from measurements the endpoint no longer confirms", async () => {
    let clock = NOW;
    let down = false;
    const answer = () => (down ? new Response("", { status: 500 }) : Response.json(payload(100, 40)));
    const h = await host(
      { main: answer, spare: answer, work: answer },
      { clock: () => clock, settings: { refreshMinutes: 1 } },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    down = true;
    clock = NOW + 3 * HOUR;
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(state.bestAccount).toBeNull();
  });

  it("judges a leftover inside the grace when the picked account has since been measured out", async () => {
    let mainOut = false;
    const h = await host(
      {
        main: () => Response.json(payload(mainOut ? 100 : 10, 40)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      {
        presetEnv: {
          "proj-2": [{ name: ENV_VAR, note: ownNote("spare"), secret: true, value: null }],
        },
      },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // main looks free when the user picks it for proj-2.
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-2", account: "main" });
    // proj-1, also on main, exhausts it: its failure measures every account again.
    mainOut = true;
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => [r.threadId, r.reason])).toEqual([["thread-1", "Switched to account work"]]);
    // A leftover of proj-2 fails inside the pick's window: main is known out now.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure({ threadId: "thr-2", requestId: "creq_2" }));
    expect(h.retries[1]).toMatchObject({ threadId: "thr-2", reason: "Switched to account work" });
  });

  it("judges a leftover inside the grace when the picked account turned out to have no login", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => new Response(null, { status: 401 }),
    });
    dispose = () => h.harness.dispose();
    // Nothing measured yet: the pick of work holds.
    await h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" });
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(state.accounts.find((a) => a.name === "work")?.problem).toEqual({ kind: "unauthenticated" });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries[0]?.reason).toBe("Switched to account spare");
  });

  it("announces a change again once a pick has measured an account that had no login", async () => {
    let loggedIn = false;
    let clock = NOW;
    let measuredAt = 0;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(10, 60)),
        work: () => {
          if (!loggedIn) return new Response(null, { status: 401 });
          measuredAt = clock;
          return Response.json(payload(5, 20));
        },
      },
      { clock: () => (clock += 1) },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // claude login run outside the plugin, then work picked by hand.
    loggedIn = true;
    const changes = () =>
      h.harness.realtimeSignals.filter((s) => s.channel === "accounts-changed").length;
    const before = changes();
    const state = (await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "work",
    })) as State;
    expect(state.accounts.find((a) => a.name === "work")?.problem ?? null).toBeNull();
    // The change itself, then the measure: a view's read set off by the first
    // can predate the measure, so the views read again after it.
    expect(changes() - before).toBe(2);
    expect(measuredAt).toBeGreaterThan(0);
    expect(lastChangeAt(h)).toBeGreaterThan(measuredAt);
  });

  it("announces nothing for a pick that changed nothing (an account that does not exist)", async () => {
    const h = await host({
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => Response.json(payload(5, 20)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const changes = () =>
      h.harness.realtimeSignals.filter((s) => s.channel === "accounts-changed").length;
    const before = changes();
    await expect(
      h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "nope" }),
    ).rejects.toThrow();
    // A view would read again and clear the error Settings shows for it.
    expect(changes()).toBe(before);
  });

  it("announces nothing for a pick bb refused to write, or of a variable set outside the plugin", async () => {
    const accounts = {
      main: () => Response.json(payload(100, 40)),
      spare: () => Response.json(payload(10, 60)),
      work: () => Response.json(payload(5, 20)),
    };
    for (const options of [
      { failSet: ["proj-1"] },
      { presetEnv: { "proj-1": [{ name: ENV_VAR, note: "set by hand", secret: true, value: null }] } },
    ]) {
      const h = await host(accounts, options);
      dispose = () => h.harness.dispose();
      await h.harness.behavior.callRpc("accounts_refresh", null);
      const changes = () =>
        h.harness.realtimeSignals.filter((s) => s.channel === "accounts-changed").length;
      const before = changes();
      await expect(
        h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "work" }),
      ).rejects.toThrow();
      expect(changes()).toBe(before);
      await h.harness.dispose();
      dispose = null;
    }
  });

  it("announces a pick once it is all written, after its history row", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => (clock += 1) },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const state = (await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "work",
    })) as State;
    const row = state.history.find((r) => r.reason === "Picked by hand");
    expect(row).toBeDefined();
    // A view that read on the announcement made when the account was applied
    // can predate the row; its answer would then hide the pick's own.
    expect(lastChangeAt(h)).toBeGreaterThan(row!.at);
  });

  it("names a best account once a reset has passed, without measuring again", async () => {
    let clock = NOW;
    const h = await host(
      {
        main: () => Response.json(payload(100, 40)),
        spare: () => Response.json(payload(100, 60)),
        work: () => Response.json(payload(100, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    const before = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(before.bestAccount).toBeNull();
    clock = NOW + 2 * HOUR + 60_000;
    const after = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(after.bestAccount).not.toBeNull();
  });
});

describe("the history of moves", () => {
  it("lists every move, latest first, and keeps it across a reload", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-2",
      account: "spare",
    });
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history.map((r) => [r.projectId, r.from, r.to, r.reason])).toEqual([
      ["proj-2", "main", "spare", "Picked by hand"],
      ["proj-1", "main", "work", "Switched to account work"],
    ]);
    // Persisted: a fresh plugin over the same storage lists the same.
    const stored = await h.bb.storage.kv.get("switch-history");
    const again = await host(ALL_FREE, { kvPreset: { "switch-history": stored } });
    const after = (await again.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(after.history.map((r) => r.reason)).toEqual([
      "Picked by hand",
      "Switched to account work",
    ]);
    again.harness.dispose();
  });

  it("does not record a pick of the account the project already has", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: null,
    });
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history).toEqual([]);
  });

  it("keeps the last 100 moves", async () => {
    // Stored latest first: `old 0` is the most recent.
    const old = Array.from({ length: 100 }, (_, i) => ({
      at: NOW - (i + 1) * 60_000,
      threadId: "t",
      projectId: "proj-1",
      from: "a",
      to: "b",
      reason: `old ${i}`,
    }));
    const h = await host(ALL_FREE, { kvPreset: { "switch-history": old } });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-2",
      account: "spare",
    });
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history).toHaveLength(100);
    expect(state.history[0]?.reason).toBe("Picked by hand");
    expect(state.history[1]?.reason).toBe("old 0");
    expect(state.history[99]?.reason).toBe("old 98");
  });

  it("starts the history again when the stored one is unreadable", async () => {
    const h = await host(ALL_FREE, { kvPreset: { "switch-history": "junk" } });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-2",
      account: "spare",
    });
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history.map((r) => r.reason)).toEqual(["Picked by hand"]);
  });

  it("prints the moves from the terminal, latest first, as text or JSON", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    const empty = await h.harness.behavior.runCli(["history"]);
    expect(empty).toMatchObject({ exitCode: 0, stdout: "no moves yet\n" });
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-2",
      account: "spare",
    });
    const text = await h.harness.behavior.runCli(["history"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toBe(
      `${new Date(NOW).toISOString()}\tOther\tmain → spare\tPicked by hand\n` +
        `${new Date(NOW).toISOString()}\tWebsite\tmain → work\tSwitched to account work\n`,
    );
    const json = await h.harness.behavior.runCli(["history", "--json"]);
    expect(
      (JSON.parse(json.stdout) as State["history"]).map((r) => r.to),
    ).toEqual(["spare", "work"]);
  });

  it("shows in `list` the pace of a weekly window that has one", async () => {
    let clock = NOW;
    let weekly = 40;
    const h = await host(
      {
        main: () => Response.json(payload(10, weekly, 20)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 24 * HOUR;
    weekly = 70;
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const lines = (await h.harness.behavior.runCli(["list"])).stdout.split("\n");
    expect(lines.find((l) => l.startsWith("main\t"))).toBe(
      "main\tsession 10%\tweekly 70%\tFable 20%\tweekly runs out in 1 d 0 h at this pace (30 %/day)",
    );
    // A steady window says nothing.
    expect(lines.find((l) => l.startsWith("work\t"))).toBe(
      "work\tsession 5%\tweekly 20%\t",
    );
  });
});

describe("the forecast of each window", () => {
  it("says when a window runs out at the pace measured since it started, and remembers the samples", async () => {
    let clock = NOW;
    let weekly = 40;
    const h = await host(
      {
        main: () => Response.json(payload(10, weekly, 20)),
        spare: () => Response.json(payload(10, 60)),
        work: () => Response.json(payload(5, 20)),
      },
      { clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    const first = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    // One sample: nothing to say yet.
    expect(first.forecasts.main).toEqual({ weekly: { kind: "unknown" }, Fable: { kind: "unknown" } });
    clock = NOW + 24 * HOUR;
    weekly = 70;
    const later = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(later.forecasts.main).toEqual({
      // 30 points a day, 30 left: out in a day, before the reset in two more.
      weekly: { kind: "runs-out", at: NOW + 48 * HOUR, percentPerDay: 30 },
      // Its reset (4 h after the first sample) has passed: no window to measure against.
      Fable: { kind: "unknown" },
    });
    expect(later.forecasts.work?.weekly).toEqual({ kind: "steady" });
    // The samples survive a reload of the plugin.
    const stored = await h.bb.storage.kv.get("usage-series");
    const again = await host(
      { main: () => Response.json(payload(10, 70, 20)), spare: () => Response.json(payload(10, 60)), work: () => Response.json(payload(5, 20)) },
      { clock: () => NOW + 25 * HOUR, kvPreset: { "usage-series": stored } },
    );
    const after = (await again.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(after.forecasts.main?.weekly).toMatchObject({ kind: "runs-out" });
    again.harness.dispose();
  });

  it("keeps measuring the same window when its reset comes with another fraction of a second", async () => {
    // Measured on 2026-09-30: two queries in a row gave resets 0.6 s apart.
    let clock = NOW;
    let weekly = 40;
    let jitter = 612;
    const main = () => {
      const body = payload(10, weekly) as { limits: { resets_at: string }[] };
      body.limits[1]!.resets_at = new Date(NOW + 3 * 24 * HOUR + jitter).toISOString();
      return Response.json(body);
    };
    const h = await host({ ...ALL_FREE, main }, { clock: () => clock });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 12 * HOUR;
    weekly = 55;
    jitter = -377;
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 24 * HOUR;
    weekly = 70;
    jitter = 45;
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(state.forecasts.main?.weekly).toEqual({
      kind: "runs-out",
      at: NOW + 48 * HOUR,
      percentPerDay: 30,
    });
  });

  it("starts the history with the last switch an earlier version stored", async () => {
    const last = { at: NOW - HOUR, threadId: "t", projectId: "proj-1", from: "main", to: "spare", reason: "Switched to spare" };
    const h = await host(ALL_FREE, { kvPreset: { "last-switch": last } });
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history).toEqual([last]);
    // Only while there is no history: an empty one stored by this version stays empty.
    const own = await host(ALL_FREE, { kvPreset: { "last-switch": last, "switch-history": [] } });
    const later = (await own.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(later.history).toEqual([]);
    own.harness.dispose();
  });

  it("keeps what it can read of the stored samples and of the stored history", async () => {
    const h = await host(
      { ...ALL_FREE, main: () => Response.json(payload(10, 70)) },
      {
        clock: () => NOW + 24 * HOUR,
        kvPreset: {
          "usage-series": {
            main: { weekly: { resetsAt: NOW + 3 * 24 * HOUR, points: [[NOW, 40]] } },
            spare: "not a series",
          },
          "switch-history": [
            { at: NOW, threadId: "t", projectId: "proj-1", from: "main", to: "spare", reason: "Picked by hand" },
            { at: "yesterday" },
            // Not a date: formatting it would fail the whole listing.
            { at: 1e20, threadId: "t", projectId: "proj-1", from: "main", to: "spare", reason: "Out of range" },
          ],
        },
      },
    );
    dispose = () => h.harness.dispose();
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(state.forecasts.main?.weekly).toEqual({
      kind: "runs-out",
      at: NOW + 48 * HOUR,
      percentPerDay: 30,
    });
    expect(state.history.map((r) => r.reason)).toEqual(["Picked by hand"]);
    const listing = await h.harness.behavior.runCli(["history"]);
    expect(listing.stdout).toMatch(/Picked by hand/);
  });

  it("forgets the samples of an account that is gone", async () => {
    let dirs = ["spare", "work"];
    let clock = NOW;
    const h = await host(ALL_FREE, { dirs: () => dirs, clock: () => clock });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    dirs = ["spare"];
    clock = NOW + HOUR;
    const state = (await h.harness.behavior.callRpc("accounts_refresh", null)) as State;
    expect(Object.keys(state.forecasts).sort()).toEqual(["main", "spare"]);
    const stored = (await h.bb.storage.kv.get("usage-series")) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["main", "spare"]);
  });
});

describe("moving a project ahead of the limit, after a turn", () => {
  const AHEAD = {
    main: () => Response.json(payload(10, 40, 92)),
    spare: () => Response.json(payload(10, 60, 40)),
    work: () => Response.json(payload(5, 20, 95)),
  };
  const idle = (h: Awaited<ReturnType<typeof host>>, id = "thread-1", projectId = "proj-1") =>
    h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: thread({ id, projectId }),
      lastAssistantText: null,
    });

  it("moves the project when its account is at the threshold and another has room, and records why", async () => {
    let clock = NOW;
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
      clock: () => clock,
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // The turn ran for a while: the account is measured again before judging.
    clock = NOW + 5 * 60_000;
    const before = h.usageCalls.length;
    await idle(h);
    expect(h.usageCalls.slice(before)).toEqual(["main"]);
    expect(h.envSet.map((e) => [e.projectId, e.note])).toEqual([["proj-1", ownNote("spare")]]);
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history[0]).toMatchObject({
      projectId: "proj-1",
      from: "main",
      to: "spare",
      reason: "Switched ahead of the limit to spare: main at 92% of Fable",
    });
    // A thread of the project still running on main fails right after: retried on spare.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure({ threadId: "thread-2", requestId: "creq_2" }));
    expect(h.retries.map((r) => r.reason)).toEqual(["Retrying on account spare"]);
  });

  it("finds the accounts again when their directory setting was just touched", async () => {
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // Changed and put back: the list of accounts is empty until the next look.
    await h.harness.behavior.setSettings({ accountsDir: "/Users/someone/elsewhere" });
    await h.harness.behavior.setSettings({ accountsDir: ACCOUNTS });
    await idle(h);
    expect(h.envSet.map((e) => [e.projectId, e.note])).toEqual([["proj-1", ownNote("spare")]]);
  });

  it("does not move to another directory of the same Claude account", async () => {
    // The two share one usage: the other only looks roomier until it is measured.
    let clock = NOW;
    let mainFable = 70;
    const h = await host(
      {
        main: () => Response.json(payload(10, 40, mainFable)),
        spare: () => Response.json(payload(10, 40, 70)),
        work: () => Response.json(payload(5, 20, 95)),
      },
      { settings: { switchAheadPercent: 80, preferredModel: "Fable" }, clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    h.files[`${ACCOUNTS}/spare/.claude.json`] = claudeJson("main@example.com", "uuid-main");
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 5 * 60_000;
    mainFable = 85;
    await idle(h);
    expect(h.envSet).toEqual([]);
  });

  it("does not move to an account whose last measurement is old", async () => {
    // Its query has failed for hours: what it had left then is not what it has.
    let clock = NOW;
    let mainFable = 70;
    let spareDown = false;
    const h = await host(
      {
        main: () => Response.json(payload(10, 40, mainFable)),
        spare: () => (spareDown ? new Response(null, { status: 500 }) : Response.json(payload(10, 40, 10))),
        work: () => Response.json(payload(5, 20, 95)),
      },
      { settings: { switchAheadPercent: 80, preferredModel: "Fable" }, clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    spareDown = true;
    // Two refresh periods (5 min each) and a millisecond: too old.
    clock = NOW + 10 * 60_000 - 2 * 60_000;
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 10 * 60_000 + 1;
    mainFable = 85;
    await idle(h);
    expect(h.envSet).toEqual([]);
    // At two periods exactly it still counts.
    const at = await host(
      {
        main: () => Response.json(payload(10, 40, mainFable)),
        spare: () => (spareDown ? new Response(null, { status: 500 }) : Response.json(payload(10, 40, 10))),
        work: () => Response.json(payload(5, 20, 95)),
      },
      { settings: { switchAheadPercent: 80, preferredModel: "Fable" }, clock: () => clock },
    );
    clock = NOW;
    spareDown = false;
    mainFable = 70;
    await at.harness.behavior.callRpc("accounts_refresh", null);
    spareDown = true;
    clock = NOW + 10 * 60_000;
    mainFable = 85;
    await idle(at);
    expect(at.envSet.map((e) => e.note)).toEqual([ownNote("spare")]);
    at.harness.dispose();
  });

  it("does not move when the automatic choice was turned off while the account was measured", async () => {
    let clock = NOW;
    let gated = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = () => Response.json(payload(10, 40, 92));
    const main = () => (gated ? gate.then(answer) : answer()) as Response;
    const h = await host(
      { ...AHEAD, main },
      { settings: { switchAheadPercent: 90, preferredModel: "Fable" }, clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    gated = true;
    clock = NOW + 5 * 60_000;
    const pending = idle(h);
    await new Promise((r) => setTimeout(r, 5));
    await h.harness.behavior.setSettings({ autoSwitch: false });
    release();
    await pending;
    expect(h.envSet).toEqual([]);
  });

  it("leaves a project whose account was set by hand outside the plugin", async () => {
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
      presetEnv: {
        "proj-1": [{ name: ENV_VAR, note: "set by hand", secret: true, value: null }],
      },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await idle(h);
    expect(h.envSet).toEqual([]);
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history).toEqual([]);
  });

  it("does nothing unless the threshold is set", async () => {
    const h = await host(AHEAD, { settings: { preferredModel: "Fable" } });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await idle(h);
    expect(h.envSet).toEqual([]);
  });

  it("uses a measurement under a minute old as is", async () => {
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const before = h.usageCalls.length;
    await idle(h);
    expect(h.usageCalls.slice(before)).toEqual([]);
    expect(h.envSet).toHaveLength(1);
  });

  it("measures again past a minute, not at a minute", async () => {
    let clock = NOW;
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 95, preferredModel: "Fable" },
      clock: () => clock,
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const before = h.usageCalls.length;
    clock = NOW + 60_000;
    await idle(h);
    expect(h.usageCalls.slice(before)).toEqual([]);
    clock = NOW + 60_001;
    await idle(h);
    expect(h.usageCalls.slice(before)).toEqual(["main"]);
  });

  it("does not ask again at every turn end while the measurement fails", async () => {
    let clock = NOW;
    let down = false;
    const h = await host(
      {
        ...AHEAD,
        main: () => (down ? new Response("", { status: 429 }) : Response.json(payload(10, 40, 50))),
      },
      { settings: { switchAheadPercent: 90, preferredModel: "Fable" }, clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    down = true;
    clock = NOW + 5 * 60_000;
    const before = h.usageCalls.length;
    await idle(h);
    await idle(h, "thread-2");
    clock = NOW + 5 * 60_000 + 60_000;
    await idle(h);
    // Ten turns ending in a minute are one question to a provider that is failing.
    expect(h.usageCalls.slice(before)).toEqual(["main"]);
    clock = NOW + 5 * 60_000 + 60_001;
    await idle(h);
    expect(h.usageCalls.slice(before)).toEqual(["main", "main"]);
    expect(h.envSet).toEqual([]);
  });

  it("judges the account the project is on when its turn in the queue comes", async () => {
    let clock = NOW;
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
      clock: () => clock,
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    clock = NOW + 5 * 60_000;
    // The pick by hand lands while the account is being measured.
    await Promise.all([
      idle(h),
      h.harness.behavior.callRpc("project_set_account", { projectId: "proj-1", account: "spare" }),
    ]);
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.history.map((r) => r.reason)).toEqual(["Picked by hand"]);
    expect(h.envSet.map((e) => e.note)).toEqual([ownNote("spare")]);
  });

  it("marks the project as handled and does not take the next failure of its own thread for a leftover", async () => {
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
      kvPreset: { "installed-at": NOW - HOUR },
      threads: { "thread-9": { projectId: "proj-3" } },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // proj-3 was created after the plugin was installed: new until handled.
    await idle(h, "thread-9", "proj-3");
    expect(h.envSet.map((e) => [e.projectId, e.note])).toEqual([["proj-3", ownNote("spare")]]);
    expect(await h.bb.storage.kv.get("handled-projects")).toContain("proj-3");
    // Its next turn runs on spare: a failure there is spare's, judged with a fresh measurement.
    const before = h.usageCalls.length;
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-9", requestId: "creq_9" }),
    );
    expect(h.retries.map((r) => r.reason)).not.toContain("Retrying on account spare");
    expect(h.usageCalls.slice(before).sort()).toEqual(["main", "spare", "work"]);
  });

  it("keeps the usage samples when a measurement lands while the accounts are being looked up again", async () => {
    let clock = NOW;
    let gated = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = () => Response.json(payload(10, 40, 50));
    // The fake fetch awaits what this returns: the answer can be held back.
    const main = () => (gated ? gate.then(answer) : answer()) as Response;
    const h = await host(
      { ...AHEAD, main },
      { settings: { switchAheadPercent: 90, preferredModel: "Fable" }, clock: () => clock },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const before = await h.bb.storage.kv.get("usage-series");
    expect(Object.keys(before as object).sort()).toEqual(["main", "spare", "work"]);
    gated = true;
    clock = NOW + 5 * 60_000;
    const pending = idle(h);
    await new Promise((r) => setTimeout(r, 5));
    // A change of the accounts directory empties the list until the next look.
    await h.harness.behavior.setSettings({ accountsDir: "/Users/someone/elsewhere" });
    release();
    await pending;
    const after = (await h.bb.storage.kv.get("usage-series")) as object;
    expect(Object.keys(after).sort()).toEqual(["main", "spare", "work"]);
  });

  it("leaves the project when no other account has room, when automatic choice is off, and when the variable is external", async () => {
    const tight = {
      main: () => Response.json(payload(10, 40, 92)),
      spare: () => Response.json(payload(10, 60, 91)),
      work: () => Response.json(payload(5, 20, 95)),
    };
    const h = await host(tight, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await idle(h);
    expect(h.envSet).toEqual([]);

    const off = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable", autoSwitch: false },
    });
    await off.harness.behavior.callRpc("accounts_refresh", null);
    await idle(off);
    expect(off.envSet).toEqual([]);
    off.harness.dispose();

    const external = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
      presetEnv: { "proj-1": [{ name: ENV_VAR, note: "mine", secret: true, value: null }] },
    });
    await external.harness.behavior.callRpc("accounts_refresh", null);
    await idle(external);
    expect(external.envSet).toEqual([]);
    external.harness.dispose();
  });

  it("ignores threads of other providers and hidden threads", async () => {
    const h = await host(AHEAD, {
      settings: { switchAheadPercent: 90, preferredModel: "Fable" },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: thread({ id: "t", projectId: "proj-1", providerId: "codex" }),
      lastAssistantText: null,
    });
    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: thread({ id: "t", projectId: "proj-1", visibility: "hidden", originPluginId: "x" }),
      lastAssistantText: null,
    });
    expect(h.envSet).toEqual([]);
  });
});

describe("adding an account by logging in from bb", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const withTeam = {
    ...ALL_FREE,
    team: () => Response.json(payload(0, 5, 0)),
  };

  it("runs the login in a new account directory and lists the account once it is done", async () => {
    let dirs = ["spare", "work"];
    const h = await host(withTeam, { dirs: () => dirs, env: { PATH: "/usr/bin", HOME: HOME } });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const started = (await h.harness.behavior.callRpc("account_login_start", { name: "team" })) as State;
    expect(h.made).toEqual([`${ACCOUNTS}/team`]);
    // The new directory shares the default account's transcripts.
    expect(h.links).toEqual([
      [`${HOME}/.claude/projects`, `${ACCOUNTS}/team/projects`],
    ]);
    expect(h.logins[0]?.env).toEqual({
      PATH: "/usr/bin",
      HOME: HOME,
      CLAUDE_CONFIG_DIR: `${ACCOUNTS}/team`,
      BROWSER: "/plugin/bin/open-login.sh",
      CLAUDE_SWITCHER_PRIVATE: "1",
    });
    expect(started.login).toMatchObject({ name: "team", phase: "running" });
    // Claude Code created the directory's .claude.json and wrote the login.
    dirs = ["spare", "team", "work"];
    h.files[`${ACCOUNTS}/team/.claude.json`] = claudeJson("team@example.com", "uuid-team");
    h.logins[0]!.exit(0);
    await tick();
    await tick();
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.login).toMatchObject({ name: "team", phase: "done" });
    expect(state.accounts.map((a) => [a.name, a.usage?.weekly.usedPercent ?? null])).toEqual([
      ["main", 40],
      ["spare", 60],
      ["team", 5],
      ["work", 20],
    ]);
    expect(h.harness.realtimeSignals.filter((s) => s.channel === "accounts-changed").length).toBeGreaterThan(1);
  });

  it("says so when the login ended but left no account, or no login", async () => {
    let dirs = ["spare", "work"];
    let teamIn = false;
    const team = () =>
      teamIn ? Response.json(payload(0, 5, 0)) : new Response(null, { status: 401 });
    const h = await host({ ...ALL_FREE, team }, { dirs: () => dirs });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // Claude Code exits 0, and nothing is in the directory.
    await h.harness.behavior.callRpc("account_login_start", { name: "empty" });
    h.logins[0]!.exit(0);
    await tick();
    await tick();
    let state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.login).toMatchObject({ name: "empty", phase: "done" });
    expect(state.login?.message).toMatch(/no account was found/);
    // A new start forgets the note.
    await h.harness.behavior.callRpc("account_login_cancel", null);
    // The directory is an account now, with nothing in the login store.
    dirs = ["nologin", "spare", "work"];
    h.files[`${ACCOUNTS}/nologin/.claude.json`] = claudeJson("n@example.com", "uuid-n");
    state = (await h.harness.behavior.callRpc("account_login_start", { name: "nologin" })) as State;
    expect(state.login?.message).toBeNull();
    h.logins[1]!.exit(0);
    await tick();
    await tick();
    state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.login).toMatchObject({ name: "nologin", phase: "done" });
    expect(state.login?.message).toMatch(/still has no login/);
    // A login that leaves what it should carries no note of the ones before.
    await h.harness.behavior.callRpc("account_login_cancel", null);
    h.files[`${ACCOUNTS}/team/.claude.json`] = claudeJson("team@example.com", "uuid-team");
    dirs = ["nologin", "spare", "team", "work"];
    await h.harness.behavior.callRpc("accounts_refresh", null);
    teamIn = true;
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    h.logins[2]!.exit(0);
    await tick();
    await tick();
    state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.login).toMatchObject({ name: "team", phase: "done", message: null });
  });

  it("says so when the account could not be checked after its login", async () => {
    let broken = false;
    const h = await host(ALL_FREE, {
      dirs: () => {
        if (broken) throw new Error("EACCES: the accounts directory");
        return ["spare", "work"];
      },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    broken = true;
    h.logins[0]!.exit(0);
    await tick();
    await tick();
    broken = false;
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.login).toMatchObject({ name: "team", phase: "done" });
    expect(state.login?.message).toMatch(/could not be checked.*EACCES/);
  });

  it("says so when the new account is the Claude account of another one", async () => {
    let dirs = ["spare", "work"];
    const h = await host(withTeam, { dirs: () => dirs });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    // The browser was signed in to spare's Claude account and answered with it.
    dirs = ["spare", "team", "work"];
    h.files[`${ACCOUNTS}/team/.claude.json`] = claudeJson("spare@example.com", "uuid-spare");
    h.logins[0]!.exit(0);
    await tick();
    await tick();
    const state = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(state.login).toMatchObject({ name: "team", phase: "done" });
    expect(state.login?.message).toMatch(/same Claude account as spare/);
    // What the note asks for can be done: the account logs in again, to the
    // directory it has, although it has a login.
    await h.harness.behavior.callRpc("account_login_cancel", null);
    const again = (await h.harness.behavior.callRpc("account_login_start", { name: "team" })) as State;
    expect(again.login).toMatchObject({ name: "team", phase: "running" });
    expect(h.logins[1]?.env.CLAUDE_CONFIG_DIR).toBe(`${ACCOUNTS}/team`);
  });

  it("does not log the default account in again for sharing its Claude account", async () => {
    // Its directory is the CLI's own: the other directory is the one to redo.
    const h = await host(ALL_FREE, { dirs: () => ["spare", "team", "work"] });
    dispose = () => h.harness.dispose();
    h.files[`${ACCOUNTS}/team/.claude.json`] = claudeJson("main@example.com", "uuid-main");
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "main" })).rejects.toThrow(
      /main is already logged in/,
    );
    expect(h.logins).toEqual([]);
  });

  it("stops a login that is running when the plugin is unloaded", async () => {
    const h = await host(ALL_FREE);
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    expect(h.logins[0]?.killed).toBe(false);
    await h.harness.dispose();
    expect(h.logins[0]?.killed).toBe(true);
  });

  it("refuses a code longer than any code", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    await expect(
      h.harness.behavior.callRpc("account_login_code", { code: "x".repeat(4097) }),
    ).rejects.toThrow();
    expect(h.logins[0]?.written).toEqual([]);
    await h.harness.behavior.callRpc("account_login_code", { code: "x".repeat(4096) });
    expect(h.logins[0]?.written).toHaveLength(1);
  });

  it("logs the default account in without CLAUDE_CONFIG_DIR and without a private window when so set", async () => {
    const noMain = { ...ALL_FREE, main: () => new Response(null, { status: 401 }) };
    const h = await host(noMain, {
      settings: { loginPrivateWindow: false },
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/somewhere/else" },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.callRpc("account_login_start", { name: "main" });
    expect(h.made).toEqual([]);
    expect(h.logins[0]?.env).toEqual({
      PATH: "/usr/bin",
      BROWSER: "/plugin/bin/open-login.sh",
      CLAUDE_SWITCHER_PRIVATE: "0",
    });
  });

  it("refuses a name that is not a plain directory name, the `default` alias, or an account already logged in", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    for (const name of ["", "../x", "a/b", ".hidden", "with space", "x".repeat(65)])
      await expect(h.harness.behavior.callRpc("account_login_start", { name })).rejects.toThrow(
        /starts with a letter or a digit/,
      );
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "default" })).rejects.toThrow(
      /names the default account/,
    );
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "spare" })).rejects.toThrow(
      /already logged in/,
    );
    expect(h.logins).toEqual([]);
  });

  it("refuses a name that differs only in case from an account or a directory that is there", async () => {
    // On a case-insensitive disk `Spare` IS the directory of `spare`.
    const h = await host(ALL_FREE, {
      accountEntries: () => [
        { name: "spare", directory: true },
        { name: "work", directory: true },
        { name: "old", directory: true },
      ],
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "Spare" })).rejects.toThrow(
      /an account named spare already exists/,
    );
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "MAIN" })).rejects.toThrow(
      /an account named main already exists/,
    );
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "Old" })).rejects.toThrow(
      /a directory named old already exists/,
    );
    expect(h.made).toEqual([]);
    expect(h.logins).toEqual([]);
    // The same name, as a directory without a login yet, is fine.
    await h.harness.behavior.callRpc("account_login_start", { name: "old" });
    expect(h.logins[0]?.env.CLAUDE_CONFIG_DIR).toBe(`${ACCOUNTS}/old`);
  });

  it("logs in a listed account whatever its name", async () => {
    const h = await host(ALL_FREE, {
      dirs: () => ["spare", "work", "Work Account"],
    });
    dispose = () => h.harness.dispose();
    h.files[`${ACCOUNTS}/Work Account/.claude.json`] = claudeJson("wa@example.com", "uuid-wa");
    const state = (await h.harness.behavior.callRpc("account_login_start", {
      name: "Work Account",
    })) as State;
    expect(state.login).toMatchObject({ name: "Work Account", phase: "running" });
    expect(h.logins[0]?.env.CLAUDE_CONFIG_DIR).toBe(`${ACCOUNTS}/Work Account`);
  });

  it("refuses a name that is a link or a file in the accounts directory", async () => {
    const h = await host(ALL_FREE, {
      accountEntries: () => [
        { name: "spare", directory: true },
        { name: "work", directory: true },
        { name: "elsewhere", directory: false },
      ],
    });
    dispose = () => h.harness.dispose();
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "elsewhere" })).rejects.toThrow(
      /is not a directory/,
    );
    expect(h.made).toEqual([]);
    expect(h.logins).toEqual([]);
  });

  it("refuses a new directory when the accounts directory is inside the default account's", async () => {
    // `projects`, `plugins`... exist there and are what every account shares.
    for (const accountsDir of [`${HOME}/.claude`, "~/.claude/", `${ACCOUNTS}/../.claude/sub`, `${HOME}/.CLAUDE`]) {
      const h = await host(ALL_FREE, { settings: { accountsDir } });
      await expect(h.harness.behavior.callRpc("account_login_start", { name: "projects" })).rejects.toThrow(
        /inside the default account's directory/,
      );
      expect(h.made).toEqual([]);
      expect(h.logins).toEqual([]);
      h.harness.dispose();
    }
  });

  it("lets an account without a login log in again, measuring it first when needed", async () => {
    const noWork = { ...ALL_FREE, work: () => new Response(null, { status: 401 }) };
    const h = await host(noWork);
    dispose = () => h.harness.dispose();
    // Never measured: measured now, found without a login, allowed.
    const state = (await h.harness.behavior.callRpc("account_login_start", { name: "work" })) as State;
    expect(state.login).toMatchObject({ name: "work", phase: "running" });
    expect(h.usageCalls).toEqual(["work"]);
    expect(h.logins[0]?.env.CLAUDE_CONFIG_DIR).toBe(`${ACCOUNTS}/work`);
  });

  it("passes a pasted code on, cancels, and reports a failed login", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    await h.harness.behavior.callRpc("account_login_code", { code: "abc" });
    expect(h.logins[0]?.written).toEqual(["abc\n"]);
    const cancelled = (await h.harness.behavior.callRpc("account_login_cancel", null)) as State;
    expect(h.logins[0]?.killed).toBe(true);
    expect(cancelled.login).toMatchObject({ phase: "cancelled" });
    const cleared = (await h.harness.behavior.callRpc("account_login_cancel", null)) as State;
    expect(cleared.login).toBeNull();

    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    h.logins[1]!.exit(1);
    await tick();
    const failed = (await h.harness.behavior.callRpc("accounts_list", null)) as State;
    expect(failed.login).toMatchObject({ phase: "failed", message: expect.stringMatching(/exit code 1/) });
  });

  it("runs one login at a time", async () => {
    const h = await host(ALL_FREE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("account_login_start", { name: "team" });
    await expect(h.harness.behavior.callRpc("account_login_start", { name: "side" })).rejects.toThrow(
      /still running/,
    );
  });
});

describe("the model a thread's turn runs on", () => {
  /** A usage answer with a weekly window per model. */
  function usage(session: number, fable: number, opus: number) {
    return () => {
      const answer = payload(session, 40, fable);
      (answer.limits as unknown[]).push({
        kind: "weekly_scoped",
        percent: opus,
        resets_at: new Date(NOW + 4 * HOUR).toISOString(),
        scope: { model: { display_name: "Opus" } },
      });
      return Response.json(answer);
    };
  }
  /** `main` (the project's account) is out of its session; the others are out of Fable and can run Opus. */
  const OPUS_ELSEWHERE = {
    main: usage(100, 30, 0),
    spare: usage(10, 100, 20),
    work: usage(5, 100, 10),
  };
  const FABLE = { settings: { preferredModel: "Fable" } };

  /** What bb asks before a message reaches the provider, answered by the plugin. */
  function dispatch(
    h: Awaited<ReturnType<typeof host>>,
    model: string | null,
    overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {},
  ) {
    return h.harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: thread({ id: "thread-1", projectId: "proj-1" }),
        requestedExecution: { providerId: "claude-code", model },
        attempt: "start-turn",
        ...overrides,
      }),
    );
  }

  it("moves the project off an account that is out when the turn is sent with Opus and another account can run Opus, though none can run the preferred model", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    const measured = h.usageCalls.length;
    expect(await dispatch(h, "claude-opus-5-5")).toEqual({ action: "proceed" });
    // Decided on the measurements already there: no query in the way of the turn.
    expect(h.usageCalls.length).toBe(measured);
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.lastSwitch).toMatchObject({
      threadId: "thread-1",
      projectId: "proj-1",
      from: "main",
      to: "work",
      reason: "Moved to account work before the turn: main cannot run Opus",
    });
    // Its turn started on `work`: a failure is that account's, judged against Opus.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual([
      "Switched to account spare (Opus)",
    ]);
  });

  it("leaves a thread sent with Fable where it is when no account can run Fable: its failed turn still waits for Fable", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    expect(await dispatch(h, "claude-fable-5-1")).toEqual({ action: "proceed" });
    expect(h.envSet).toEqual([]);
    expect(h.envDeleted).toEqual([]);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet).toEqual([]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        sendAt: NOW + 2 * HOUR + BUFFER,
        reason: "Waiting for Fable on main",
      },
    ]);
  });

  it("counts a turn sent with Opus against the session and the week when the usage API lists no Opus window, as it does today", async () => {
    // The answer's shape on 2026-09-30: only Fable has a window of its own.
    const h = await host(
      {
        main: () => Response.json(payload(100, 20, 32)),
        spare: () => Response.json(payload(0, 82, 100)),
        work: () => Response.json(payload(2, 67, 100)),
      },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    expect(await dispatch(h, "claude-opus-5-5")).toEqual({ action: "proceed" });
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/spare`],
    ]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.lastSwitch).toMatchObject({
      from: "main",
      to: "spare",
      reason: "Moved to account spare before the turn: main cannot run Opus",
    });
  });

  it.each(["starting", "active", "stopping"] as const)(
    "does not take the model of a message queued behind a turn (thread %s) for that turn's: its failure still waits for Fable",
    async (status) => {
      const h = await host(
        {
          main: usage(10, 100, 0),
          spare: usage(10, 100, 20),
          work: usage(100, 100, 100),
        },
        FABLE,
      );
      dispose = () => h.harness.dispose();
      await h.harness.behavior.callRpc("accounts_refresh", null);
      await dispatch(h, "claude-fable-5-1");
      // bb asks when the message is queued, and again when it sends it.
      await dispatch(h, "claude-opus-5-5", {
        thread: thread({ id: "thread-1", projectId: "proj-1", status }),
      });
      await h.harness.behavior.emitThreadEvent("turn.failed", failure());
      expect(h.envSet).toEqual([]);
      expect(h.retries.map((r) => r.reason)).toEqual([
        "Waiting for Fable on main",
      ]);
    },
  );

  it("does not move the project for a message queued behind a running turn; it does when bb sends the message", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await dispatch(h, "claude-opus-5-5", {
      thread: thread({ id: "thread-1", projectId: "proj-1", status: "active" }),
    });
    expect(h.envSet).toEqual([]);
    await dispatch(h, "claude-opus-5-5");
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
  });

  /** The project's variable as the plugin last set it, read from bb. */
  function environmentOf(h: Awaited<ReturnType<typeof host>>) {
    const last = h.envSet.at(-1);
    return {
      builtInGit: { status: "disabled" as const, statusMessage: "" },
      inheritedVariables: [],
      variables:
        last === undefined
          ? []
          : [{ name: ENV_VAR, note: last.note ?? null, secret: true as const, value: null }],
    };
  }

  it("never waits for the project's queue: a message sent while the project is being decided goes on", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    h.harness.sdk.stub("projects.machineEnvironment", async () => {
      const snapshot = environmentOf(h);
      // The pick's read is slow: it holds the project's queue meanwhile.
      if (reads++ === 0) await held;
      return snapshot;
    });
    const picking = h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "spare",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    expect(
      await Promise.race([
        dispatch(h, "claude-opus-5-5"),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 50)),
      ]),
    ).toEqual({ action: "proceed" });
    expect(h.envSet.map((e) => e.note)).toEqual([ownNote("work")]);
    release();
    await picking;
    expect(h.envSet.map((e) => e.note)).toEqual([
      ownNote("work"),
      ownNote("spare"),
    ]);
  });

  it("waits for a read of bb that takes a second and places the turn", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    vi.useFakeTimers();
    try {
      h.harness.sdk.stub("projects.machineEnvironment", async () => {
        const snapshot = environmentOf(h);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return snapshot;
      });
      const answer = dispatch(h, "claude-opus-5-5");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await answer).toEqual({ action: "proceed" });
      expect(h.envSet.map((e) => e.note)).toEqual([ownNote("work")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up a placement that takes more than 3 s: the project is not moved later", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    vi.useFakeTimers();
    try {
      let reads = 0;
      h.harness.sdk.stub("projects.machineEnvironment", async () => {
        if (reads++ === 0)
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        return environmentOf(h);
      });
      const answer = dispatch(h, "claude-opus-5-5");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await answer).toEqual({ action: "proceed" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(reads).toBe(1);
      expect(h.envSet).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the message through when the project's account cannot be read, or the read never answers", async () => {
    const failing = await host(OPUS_ELSEWHERE, {
      ...FABLE,
      failEnvRead: ["proj-1"],
    });
    dispose = () => failing.harness.dispose();
    await failing.harness.behavior.callRpc("accounts_refresh", null).catch(() => {});
    expect(await dispatch(failing, "claude-opus-5-5")).toEqual({
      action: "proceed",
    });
    expect(failing.envSet).toEqual([]);
    expect(
      failing.harness.logEntries.filter((entry) => entry.level === "warn"),
    ).toMatchObject([
      {
        message:
          "thread thread-1: not placed before its turn: HTTP 503: could not read proj-1",
      },
    ]);
    failing.harness.dispose();

    const hanging = await host(OPUS_ELSEWHERE, {
      ...FABLE,
      hangEnvRead: ["proj-1"],
    });
    dispose = () => hanging.harness.dispose();
    vi.useFakeTimers();
    try {
      const answer = dispatch(hanging, "claude-opus-5-5");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await answer).toEqual({ action: "proceed" });
    } finally {
      vi.useRealTimers();
    }
    expect(hanging.envSet).toEqual([]);
  });

  it("moves nothing for a message that joins a running turn, a model bb has not resolved or that is not a Claude model id, hidden threads, other providers, external variables and autoSwitch off", async () => {
    type Case = [
      string | null,
      Parameters<typeof makeMessageDispatchHookContext>[0],
      HostOptions,
    ];
    const opus = "claude-opus-5-5";
    const cases: Case[] = [
      [opus, { attempt: "join-turn" }, FABLE],
      [null, {}, FABLE],
      ["opusplan", {}, FABLE],
      [opus, { thread: thread({ projectId: "proj-1", visibility: "hidden" }) }, FABLE],
      [opus, { thread: thread({ projectId: "proj-1", providerId: "codex" }) }, FABLE],
      [opus, {}, { settings: { preferredModel: "Fable", autoSwitch: false } }],
      [
        opus,
        {},
        {
          ...FABLE,
          presetEnv: {
            "proj-1": [{ name: ENV_VAR, note: "mine", secret: true, value: null }],
          },
        },
      ],
    ];
    for (const [model, overrides, options] of cases) {
      const h = await host(OPUS_ELSEWHERE, options);
      await h.harness.behavior.callRpc("accounts_refresh", null);
      expect(await dispatch(h, model, overrides)).toEqual({ action: "proceed" });
      expect(h.envSet).toEqual([]);
      expect(h.envDeleted).toEqual([]);
      expect(
        h.harness.logEntries.filter((entry) => entry.level === "warn"),
      ).toEqual([]);
      h.harness.dispose();
    }
  });

  it("does not place a project again as new after moving it to the default account before a turn", async () => {
    // `spare`, where the new project sits, is out; of the others only `main` (the default) has Opus left.
    const h = await host(
      { main: usage(10, 50, 0), spare: usage(100, 0, 0), work: usage(5, 0, 100) },
      {
        ...FABLE,
        presetEnv: {
          "proj-3": [
            { name: ENV_VAR, note: ownNote("spare"), secret: true, value: null },
          ],
        },
      },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await dispatch(h, "claude-opus-5-5", {
      thread: thread({ id: "thr-new", projectId: "proj-3" }),
    });
    expect(h.envDeleted.map((e) => e.projectId)).toEqual(["proj-3"]);
    // `work` ranks better for the preferred model, and `main` can run it: a known project stays.
    await h.harness.behavior.emitThreadEvent("thread.created", {
      thread: thread({ id: "thr-new-2", projectId: "proj-3" }),
    });
    expect(h.envSet).toEqual([]);
  });

  it("after the accounts directory changes, never moves a turn to an account of the old directory", async () => {
    const h = await host(OPUS_ELSEWHERE, FABLE);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.setSettings({ accountsDir: "/Users/someone/elsewhere" });
    expect(await dispatch(h, "claude-opus-5-5")).toEqual({ action: "proceed" });
    expect(h.envSet).toEqual([]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "warn"),
    ).toEqual([]);
  });

  it("judges a failed turn against the model its thread was sent with: an Opus thread switches to an account with Opus left instead of waiting for the preferred model", async () => {
    const h = await host(
      { ...OPUS_ELSEWHERE, main: usage(50, 30, 0) },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // Measured able to run: the turn starts where the project is.
    expect(await dispatch(h, "claude-opus-5-5")).toEqual({ action: "proceed" });
    expect(h.envSet).toEqual([]);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        reason: "Switched to account work (Opus)",
      },
    ]);
  });

  /**
   * A message as bb logs it: the row of a real thread read on 2026-10-02
   * (thr_dgciuctr8n, seq 3923), its text cut and its model a parameter.
   */
  function requested(seq: number, model: string | null): LoggedEvent {
    return {
      id: `evt_${seq}`,
      scope: { kind: "thread" },
      threadId: "thread-1",
      seq,
      createdAt: NOW - HOUR + seq,
      type: "client/turn/requested",
      data: {
        direction: "outbound",
        requestId: `creq_${seq}`,
        source: "tell",
        initiator: "user",
        senderThreadId: null,
        systemMessageKind: "unlabeled",
        systemMessageSubject: null,
        input: [{ type: "text", text: "o apuntaselo al optimizador", mentions: [] }],
        target: { kind: "steer", expectedTurnId: "dae8f36cd7-t3" },
        request: { method: "turn/start", params: {} },
        execution: {
          model,
          serviceTier: "default",
          reasoningLevel: "xhigh",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    };
  }

  it("judges a failed turn it never saw sent (the plugin reloaded meanwhile) against the model of the thread's latest message in bb's log: an Opus thread switches instead of waiting for the preferred model", async () => {
    const h = await host(
      { ...OPUS_ELSEWHERE, main: usage(50, 30, 0) },
      {
        ...FABLE,
        threadEvents: {
          "thread-1": [
            requested(10, "claude-fable-5-1"),
            requested(20, "claude-opus-5-5"),
            { ...requested(30, null), type: "turn/started", data: {} },
          ],
        },
      },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
    expect(h.retries.map((r) => r.reason)).toEqual([
      "Switched to account work (Opus)",
    ]);
  });

  it("falls back to the preferred model when bb's log cannot be read, is empty, or its latest message names no Claude model", async () => {
    const cases: [HostOptions, number][] = [
      [{ threadEventsError: "HTTP 503: internal error" }, 1],
      [{ threadEvents: {} }, 0],
      [{ threadEvents: { "thread-1": [requested(20, null)] } }, 0],
      [{ threadEvents: { "thread-1": [requested(20, "opusplan")] } }, 0],
    ];
    for (const [options, warnings] of cases) {
      const h = await host(
        { ...OPUS_ELSEWHERE, main: usage(50, 30, 0) },
        { ...FABLE, ...options },
      );
      await h.harness.behavior.callRpc("accounts_refresh", null);
      await h.harness.behavior.emitThreadEvent("turn.failed", failure());
      expect(h.envSet).toEqual([]);
      expect(h.retries.map((r) => r.reason)).toEqual([
        "Waiting for Fable on main",
      ]);
      expect(
        h.harness.logEntries.filter((entry) => entry.level === "warn"),
      ).toHaveLength(warnings);
      h.harness.dispose();
    }
  });

  it("asks bb's log only for a thread whose model it does not know: the model of the message it saw sent wins", async () => {
    const h = await host(
      { ...OPUS_ELSEWHERE, main: usage(50, 30, 0) },
      { ...FABLE, threadEventsError: "HTTP 503: internal error" },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await dispatch(h, "claude-opus-5-5");
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.retries.map((r) => r.reason)).toEqual([
      "Switched to account work (Opus)",
    ]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "warn"),
    ).toEqual([]);
  });

  it("forgets a thread's model when the thread is archived: the preferred model decides its next failure", async () => {
    const h = await host(
      { ...OPUS_ELSEWHERE, main: usage(50, 30, 0) },
      FABLE,
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    await dispatch(h, "claude-opus-5-5");
    await h.harness.behavior.emitThreadEvent("thread.archived", {
      thread: thread({ id: "thread-1", projectId: "proj-1" }),
    });
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet).toEqual([]);
    expect(h.retries.map((r) => r.reason)).toEqual(["Waiting for Fable on main"]);
  });
});

describe("a limit the provider enforced before bb reported it blocked", () => {
  it("moves the project and retries when the turn failed for a limit and bb's latest report only warned", async () => {
    const h = await host({
      main: () => Response.json(payload(40, 96)),
      spare: () => Response.json(payload(10, 20)),
      work: () => Response.json(payload(80, 90)),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("accounts_refresh", null);
    // As bb sent it on 2026-10-02 at 02:12 (thr_pqzfkcgihq): the provider
    // refused the turn, and the thread's latest stored report was a warning.
    const warned = failure({
      errorInfo: {
        category: "rate-limit",
        providerCode: "rate_limit_event",
        httpStatusCode: null,
      },
      rateLimits: {
        providerId: "claude-code",
        status: "warning",
        kind: "subscription-window",
        windows: [
          {
            providerKey: "seven_day",
            label: "Weekly limit",
            status: "warning",
            resetsAtMs: NOW + 26 * HOUR,
          },
        ],
        reachedReason: null,
        overageStatus: null,
        overageReason: null,
      },
    });
    await h.harness.behavior.emitThreadEvent("turn.failed", warned);
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/spare`],
    ]);
    expect(h.retries.map((r) => r.reason)).toEqual([
      "Switched to account spare",
    ]);
  });
});

describe("an account that refuses the turn", () => {
  /** `main` (the default) measures best, as the account that refused every turn on 2026-09-30 did. */
  const MAIN_BEST = {
    main: () => Response.json(payload(1, 40)),
    spare: () => Response.json(payload(10, 60)),
    work: () => Response.json(payload(5, 20)),
  };
  /** As bb reported it: no rate-limit report comes with it. */
  function refused(
    overrides: Partial<PluginTurnFailedEvent> = {},
  ): PluginTurnFailedEvent {
    return failure({
      errorInfo: {
        category: "unauthorized",
        providerCode: null,
        httpStatusCode: 403,
      },
      rateLimits: null,
      ...overrides,
    });
  }
  const created = (id: string, projectId: string) => ({
    thread: thread({ id, projectId }),
  });

  it("moves the project off the account that refused its turn and retries it at once", async () => {
    const h = await host(MAIN_BEST);
    dispose = () => h.harness.dispose();
    const { errors } = await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      refused(),
    );
    expect(errors).toEqual([]);
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
    ]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_1",
        reason: "Switched to account work: main refused the turn",
      },
    ]);
  });

  it("chooses the refusing account for nothing during six hours, and again from then on", async () => {
    let now = NOW;
    const h = await host(MAIN_BEST, { clock: () => now });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", refused());
    // A new project goes to the best account but main.
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-new", "proj-3"),
    );
    // A known project still on main leaves it at its next thread.
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-2", "proj-2"),
    );
    // A limit on work goes to spare, not back to main.
    await h.harness.behavior.emitThreadEvent("turn.failed", failure());
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
      ["proj-3", `${ACCOUNTS}/work`],
      ["proj-2", `${ACCOUNTS}/work`],
      ["proj-1", `${ACCOUNTS}/spare`],
    ]);
    now = NOW + 6 * HOUR - 1;
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-4", "proj-4"),
    );
    expect(h.envSet.at(-1)).toMatchObject({ projectId: "proj-4" });
    now = NOW + 6 * HOUR;
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-5", "proj-5"),
    );
    // main is the best account again: the new project stays on it.
    expect(h.envSet.map((e) => e.projectId)).not.toContain("proj-5");
  });

  it("retries the first turn of a thread it placed on the new account, when the old account refused it", async () => {
    // The real case of 2026-09-30: bb started the turn on the old account
    // while the plugin was placing the project.
    const h = await host(
      { ...MAIN_BEST, main: () => Response.json(payload(10, 40)) },
      { threads: { "thr-a": { projectId: "proj-3" } } },
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-a", "proj-3"),
    );
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      refused({ threadId: "thr-a" }),
    );
    expect(h.retries).toEqual([
      {
        threadId: "thr-a",
        turnRequestId: "creq_1",
        reason: "Retrying on account work",
      },
    ]);
    expect(h.envSet).toHaveLength(1);
  });

  it("takes a refusing account whose answer lacked a window as out, not as unknown", async () => {
    const h = await host({
      ...MAIN_BEST,
      main: () =>
        Response.json({
          limits: [
            {
              kind: "weekly_all",
              percent: 10,
              resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
            },
          ],
          five_hour: { locked_reason: null },
          seven_day: { locked_reason: null },
        }),
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", refused());
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-2", "proj-2"),
    );
    expect(h.envSet.map((e) => [e.projectId, e.value])).toEqual([
      ["proj-1", `${ACCOUNTS}/work`],
      ["proj-2", `${ACCOUNTS}/work`],
    ]);
  });

  it("says the account refused when it moves a project off it before a turn", async () => {
    const h = await host(MAIN_BEST);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", refused());
    const lastReason = async () =>
      (
        (await h.harness.behavior.callRpc("accounts_list", null)) as State
      ).lastSwitch?.reason;
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-2", "proj-2"),
    );
    expect(await lastReason()).toBe(
      "Moved to account work before the turn: main refused a turn",
    );
    // Put back on main by hand, and sent with a model: the same reason.
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-2",
      account: "main",
    });
    await h.harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: thread({ id: "thr-2", projectId: "proj-2" }),
        requestedExecution: { providerId: "claude-code", model: "claude-opus-5-5" },
        attempt: "start-turn",
      }),
    );
    expect(h.envSet.at(-1)).toMatchObject({ projectId: "proj-2", value: `${ACCOUNTS}/work` });
    expect(await lastReason()).toBe(
      "Moved to account work before the turn: main refused a turn",
    );
  });

  it("sets no account aside for a refusal it does not act on: automatic switching off, or a variable set outside the plugin", async () => {
    const h = await host(MAIN_BEST, {
      settings: { autoSwitch: false },
      presetEnv: {
        "proj-2": [{ name: ENV_VAR, note: null, secret: true, value: null }],
      },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", refused());
    await h.harness.behavior.setSettings({ autoSwitch: true });
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      refused({ threadId: "thr-2" }),
    );
    expect(h.retries).toEqual([]);
    // main is still the best account: a new project stays on it.
    await h.harness.behavior.emitThreadEvent(
      "thread.created",
      created("thr-new", "proj-3"),
    );
    expect(h.envSet).toEqual([]);
  });

  it("leaves alone a refusal in a thread of another provider: nothing else says whose it was", async () => {
    const h = await host(MAIN_BEST, {
      threads: { "thread-1": { providerId: "codex" } },
    });
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("turn.failed", refused());
    expect(h.retries).toEqual([]);
    expect(h.usageCalls).toEqual([]);
    expect(h.envSet).toEqual([]);
  });
});

describe("a wait another account can end sooner", () => {
  // 2026-10-04: the «bots» mother thread waited until 03:00 for its
  // account's session while another account had been free since 00:45 (it
  // could not be measured when the wait was chosen). After each refresh, a
  // project whose account is measured out for a waiting thread's model moves
  // to an account that can run it now, and the wait is replaced by a retry
  // bb dispatches at once, through every plugin's checkpoint.
  const FABLE = { preferredModel: "Fable" };
  const FABLE_ID = "claude-fable-5-1";
  const OPUS_ID = "claude-opus-5-5";
  /** main (the project's account) is out until its session resets; spare has Fable; work has none left. */
  const MAIN_OUT = {
    main: () => Response.json(payload(100, 40, 20)),
    spare: () => Response.json(payload(10, 60, 20)),
    work: () => Response.json(payload(5, 20, 100)),
  };
  /** A timed retry of the thread's failed turn `creq_<id>`, queued an hour ago. */
  function waiting(
    id: string,
    threadId: string,
    sendAt = NOW + 2 * HOUR + BUFFER,
  ): QueuedRow {
    return {
      id,
      threadId,
      payload: {
        kind: "retry",
        attempt: 2,
        reason: "Waiting for the session of main",
        retryOfTurnRequestId: `creq_${id}`,
      },
      sendAt,
      waitingOn: { kind: "time" },
      createdAt: NOW - HOUR,
      model: FABLE_ID,
    };
  }
  /** A turn as bb logs it: its request, and the retry chain it belongs to. */
  function turnRequested(
    threadId: string,
    requestId: string,
    model: string,
    retry?: { of: string; attempt: number },
  ): LoggedEvent {
    return {
      id: `evt_${requestId}`,
      scope: { kind: "thread" },
      threadId,
      seq: 1,
      createdAt: NOW - HOUR,
      type: "client/turn/requested",
      data: {
        requestId,
        ...(retry === undefined
          ? {}
          : { retryOfRequestId: retry.of, retryAttempt: retry.attempt }),
        execution: { model },
      },
    };
  }
  /** Each row's thread as bb leaves it after a failed turn: in error, its latest turn the one the row retries. */
  function waitingHost(
    usage: Record<string, () => Response>,
    rows: QueuedRow[],
    extra: HostOptions = {},
  ) {
    const threads: Record<string, Partial<ThreadResponse>> = {};
    const threadEvents: Record<string, LoggedEvent[]> = {};
    for (const row of rows) {
      threads[row.threadId] = { status: "error" };
      if (row.payload.kind === "retry")
        threadEvents[row.threadId] = [
          turnRequested(
            row.threadId,
            row.payload.retryOfTurnRequestId,
            row.model ?? FABLE_ID,
          ),
        ];
    }
    return host(usage, {
      settings: FABLE,
      queued: rows,
      ...extra,
      threads: { ...threads, ...extra.threads },
      threadEvents: { ...threadEvents, ...extra.threadEvents },
    });
  }
  /** One pass of the background refresh, to its end. */
  async function onePass(h: Awaited<ReturnType<typeof host>>) {
    const before = h.usageCalls.length;
    const run = h.harness.behavior.runService("usage-refresh");
    await vi.waitFor(() => {
      expect(h.usageCalls).toHaveLength(before + 3);
    });
    run.controller.abort();
    await run.done;
  }
  /** The retry bb dispatches at once for a released wait. */
  function retriedNow(threadId: string, turnRequestId: string) {
    return {
      threadId,
      turnRequestId,
      reason: expect.stringMatching(/spare/),
    };
  }

  it("moves the project to an account that can run the thread now and has bb retry the turn at once, never sending the row itself", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet).toEqual([
      {
        projectId: "proj-1",
        name: ENV_VAR,
        value: `${ACCOUNTS}/spare`,
        note: ownNote("spare"),
      },
    ]);
    expect(h.deleted).toEqual(["r1"]);
    expect(h.retries).toEqual([retriedNow("thread-1", "creq_r1")]);
    expect(h.sent).toEqual([]);
    expect(h.queued).toEqual([]);
    const state = (await h.harness.behavior.callRpc(
      "accounts_list",
      null,
    )) as State;
    expect(state.lastSwitch).toMatchObject({
      projectId: "proj-1",
      threadId: "thread-1",
      from: "main",
      to: "spare",
    });
    expect(state.lastSwitch?.reason).toMatch(/spare/);
    expect(await h.bb.storage.kv.get("handled-projects")).toEqual(["proj-1"]);
  });

  it("moves a project once for all its waiting threads and retries every one", async () => {
    const h = await waitingHost(MAIN_OUT, [
      waiting("r1", "thread-1"),
      waiting("r3", "thread-3"),
    ]);
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(h.deleted).toEqual(["r1", "r3"]);
    expect(h.retries).toEqual([
      retriedNow("thread-1", "creq_r1"),
      retriedNow("thread-3", "creq_r3"),
    ]);
  });

  it("retries in a later pass a wait queued before the project moved, but not one queued after", async () => {
    let failThread3 = true;
    const h = await waitingHost(MAIN_OUT, [
      waiting("r1", "thread-1"),
      waiting("r3", "thread-3"),
      { ...waiting("r5", "thread-5"), createdAt: NOW },
    ]);
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId === "thread-3" && failThread3) {
        failThread3 = false;
        throw new Error("HTTP 503: bb is busy");
      }
      return thread({ id: args.threadId, projectId: "proj-1", status: "error" });
    });
    await onePass(h);
    expect(h.deleted).toEqual(["r1"]);
    // Next pass: main is still out, the project is on spare since the move.
    await onePass(h);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(h.deleted).toEqual(["r1", "r3"]);
    expect(h.retries.map((r) => r.turnRequestId)).toEqual([
      "creq_r1",
      "creq_r3",
    ]);
    // Queued the very moment the project moved: it waits for something else.
    expect(h.queued.map((r) => r.id)).toEqual(["r5"]);
  });

  it("leaves a wait that left the queue or that another plugin took hold of after the look, and one already on its way when it is replaced", async () => {
    const answers: Array<(rows: QueuedRow[]) => QueuedRow[]> = [
      () => [],
      (rows) =>
        rows.map((r) => ({
          ...r,
          waitingOn: { kind: "plugin", pluginId: "limiter", reason: "budget" },
        })),
    ];
    for (const answer of answers) {
      const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
      h.harness.sdk.stub(
        "threads.queuedMessages.list",
        async (args: { threadId: string }) =>
          answer(h.queued.filter((r) => r.threadId === args.threadId)),
      );
      await onePass(h);
      expect(h.envSet).toEqual([]);
      expect(h.deleted).toEqual([]);
      expect(h.retries).toEqual([]);
      h.harness.dispose();
    }
    // Sent between the look and the delete: bb has it, nothing to retry.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      deleteRowError: {
        message: "HTTP 404: Queued message not found",
        status: 404,
      },
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(h.retries).toEqual([]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "warn"),
    ).toEqual([]);
  });

  it("leaves a wait whose thread was archived after the look, before its project's turn came", async () => {
    let reads = 0;
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
      thread({
        id: args.threadId,
        projectId: "proj-1",
        status: "error",
        archivedAt: ++reads > 1 ? NOW : null,
      }),
    );
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.retries).toEqual([]);
  });

  it("does not count a wait on the same account as a switch: an older wait there keeps waiting", async () => {
    // Codex r2 (R2-02): every account blocked, so a second thread waits on
    // main; then main measures as able again, and nothing moved.
    let blocked = true;
    const out = () => Response.json(payload(100, 40, 20));
    const h = await waitingHost(
      {
        main: () => (blocked ? out() : Response.json(payload(10, 40, 20))),
        spare: out,
        work: out,
      },
      [waiting("r1", "thread-1")],
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-7", requestId: "creq_7" }),
    );
    // A wait on main itself: nothing moved.
    expect(h.envSet).toEqual([]);
    expect(h.retries.map((r) => r.sendAt)).toEqual([expect.any(Number)]);
    blocked = false;
    await onePass(h);
    expect(h.deleted).toEqual([]);
    expect(h.queued.map((r) => r.id)).toContain("r1");
  });

  it("does not count picking by hand the account the project is already on as a switch", async () => {
    const h = await waitingHost(
      { ...MAIN_OUT, main: () => Response.json(payload(10, 40, 20)) },
      [waiting("r1", "thread-1")],
    );
    dispose = () => h.harness.dispose();
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: null,
    });
    await onePass(h);
    expect(h.deleted).toEqual([]);
  });

  it("looks again in a later pass at a wait queued back after bb did not take its retry", async () => {
    // Codex r2 (R2-03): the wait put back is newer than the move, but it is
    // still the one that waited on the old account.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      retryBehaviour: "fail-once",
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    const [back] = h.queued;
    expect(back?.sendAt).toBe(NOW + 2 * HOUR + BUFFER);
    await onePass(h);
    expect(h.deleted).toEqual(["r1", back?.id]);
    expect(h.retries.at(-1)).toEqual({
      threadId: "thread-1",
      turnRequestId: "creq_r1",
      reason: expect.stringMatching(/spare/),
    });
    expect(h.queued).toEqual([]);
  });

  it("puts nothing back when bb already has a retry of the turn, or the thread no longer has a failed turn", async () => {
    for (const code of ["retry_already_queued", "no_failed_turn"]) {
      const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
        retryError: { message: "HTTP 409: Conflict", code, status: 409 },
      });
      await onePass(h);
      expect(h.deleted).toEqual(["r1"]);
      expect(h.harness.sdk.callsTo("threads.retry")).toHaveLength(1);
      expect(
        h.harness.logEntries.filter((entry) => entry.level === "warn"),
      ).toEqual([]);
      h.harness.dispose();
    }
  });

  it("says loudly that a wait is lost when bb takes neither the retry nor the wait put back", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      retryBehaviour: "fail",
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.queued).toEqual([]);
    const errors = h.harness.logEntries.filter(
      (entry) => entry.level === "error",
    );
    expect(errors.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/thread-1.*by hand/),
    ]);
  });

  it("leaves an older wait alone once the project's account variable is set outside the plugin, even after a move", async () => {
    let failThread3 = true;
    const h = await waitingHost(MAIN_OUT, [
      waiting("r1", "thread-1"),
      waiting("r3", "thread-3"),
    ]);
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId === "thread-3" && failThread3) {
        failThread3 = false;
        throw new Error("HTTP 503: bb is busy");
      }
      return thread({ id: args.threadId, projectId: "proj-1", status: "error" });
    });
    await onePass(h);
    expect(h.deleted).toEqual(["r1"]);
    h.env.set("proj-1", [
      { name: ENV_VAR, note: "set by hand", secret: true, value: null },
    ]);
    await onePass(h);
    expect(h.deleted).toEqual(["r1"]);
  });

  it("warns and retries nothing when the wait cannot be removed", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      deleteRowError: { message: "HTTP 500: internal error", status: 500 },
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.retries).toEqual([]);
    expect(h.queued.map((r) => r.id)).toEqual(["r1"]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "error"),
    ).toEqual([]);
    expect(
      h.harness.logEntries
        .filter((entry) => entry.level === "warn")
        .map((entry) => entry.message),
    ).toEqual([expect.stringMatching(/thread-1.*HTTP 500/)]);
  });

  it("judges afresh a released turn that fails again within the minute: its own move gives it no grace", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    await onePass(h);
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_r1", attemptNumber: 2 }),
    );
    expect(h.retries.map((r) => r.reason)).not.toContain(
      "Retrying on account spare",
    );
  });

  it("still has bb retry the turn when the wait was removed but bb's answer was lost", async () => {
    // Codex r3 (IR-001): bb deletes the row before it answers; a lost answer
    // must not lose the wait with it.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      deleteRowError: { message: "socket hang up", landed: true },
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.deleted).toEqual(["r1"]);
    expect(h.retries).toEqual([retriedNow("thread-1", "creq_r1")]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "error"),
    ).toEqual([]);
  });

  it("does not call a wait lost when bb took the retry and only its answer was lost", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      retryBehaviour: "answer-lost",
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.retries).toEqual([retriedNow("thread-1", "creq_r1")]);
    expect(h.queued).toEqual([]);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "error"),
    ).toEqual([]);
  });

  it("looks again at a wait put back whose answer bb lost", async () => {
    // Codex r4 (IR4-001): the wait is queued again but its id never comes
    // back; it still waited on the old account.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      retryBehaviour: "restore-answer-lost",
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    const [back] = h.queued;
    expect(back?.sendAt).toBe(NOW + 2 * HOUR + BUFFER);
    expect(
      h.harness.logEntries.filter((entry) => entry.level === "error"),
    ).toEqual([]);
    await onePass(h);
    expect(h.deleted).toEqual(["r1", back?.id]);
    expect(h.retries.at(-1)).toEqual(retriedNow("thread-1", "creq_r1"));
    expect(h.queued).toEqual([]);
  });

  it("never retries a wait on an account refusing turns that could not be measured", async () => {
    // Codex r4 (IR4-002): main refused a turn while its usage could not be
    // read, and the user picked it again.
    const noMeasure = {
      main: () => new Response(null, { status: 429 }),
      spare: () => Response.json(payload(10, 60, 20)),
      work: () => Response.json(payload(5, 20, 100)),
    };
    const h = await waitingHost(noMeasure, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({
        threadId: "thread-7",
        requestId: "creq_7",
        errorInfo: {
          category: "unauthorized",
          providerCode: null,
          httpStatusCode: 403,
        },
        rateLimits: null,
      }),
    );
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "main",
    });
    await onePass(h);
    expect(h.retries.filter((r) => r.threadId === "thread-1")).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_r1",
        reason: expect.stringMatching(/^Moved to account spare,.*main refused a turn$/),
      },
    ]);
  });

  it("judges afresh a thread whose wait bb was already sending when the project moved for it", async () => {
    // Not released by the plugin: only the move's cause says its next
    // failure is the new account's.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      // Gone from the queue: bb is sending it.
      deleteRowError: {
        message: "HTTP 404: Queued message not found",
        status: 404,
        landed: true,
      },
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(h.retries).toEqual([]);
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ requestId: "creq_r1", attemptNumber: 2 }),
    );
    expect(h.retries.map((r) => r.reason)).not.toContain(
      "Retrying on account spare",
    );
  });

  it("judges afresh every thread released by a move, not only the one that caused it", async () => {
    // Codex r3 (IR-002): the second wait of the project, released in the
    // same pass, ran on the new account: a failure of it within the minute
    // is the new account's, not a leftover of the old one.
    const h = await waitingHost(MAIN_OUT, [
      waiting("r1", "thread-1"),
      waiting("r2", "thread-2"),
    ]);
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.retries.map((r) => r.threadId)).toEqual(["thread-1", "thread-2"]);
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-2", requestId: "creq_r2", attemptNumber: 2 }),
    );
    expect(h.retries.map((r) => r.reason)).not.toContain(
      "Retrying on account spare",
    );
  });

  it("never retries a wait on a hand-picked account without a login: it moves to one that can run it, or keeps waiting", async () => {
    // Codex r3 (IR-003): an account without a login is not measured, but it
    // is known unable to run anything.
    const noLogin = {
      main: () => Response.json(payload(10, 40, 20)),
      spare: () => Response.json(payload(10, 60, 20)),
      work: () => new Response(null, { status: 401 }),
    };
    const h = await waitingHost(noLogin, [waiting("r1", "thread-1")]);
    await h.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "work",
    });
    await onePass(h);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_r1",
        reason: expect.stringMatching(/^Moved to account (main|spare),.*work is not logged in$/),
      },
    ]);
    h.harness.dispose();
    const nowhere = await waitingHost(
      { ...noLogin, main: MAIN_OUT.main, spare: MAIN_OUT.main },
      [waiting("r1", "thread-1")],
    );
    dispose = () => nowhere.harness.dispose();
    await nowhere.harness.behavior.callRpc("project_set_account", {
      projectId: "proj-1",
      account: "work",
    });
    await onePass(nowhere);
    expect(nowhere.retries).toEqual([]);
    expect(nowhere.queued.map((r) => r.id)).toEqual(["r1"]);
  });

  it("names the retry it finds already queued for the failed turn", async () => {
    // Who queued it (its reason) is the trace of whoever retries ahead of
    // this plugin.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-1", requestId: "creq_r1" }),
    );
    expect(
      h.harness.logEntries.some(
        (entry) =>
          entry.level === "info" &&
          entry.message ===
            `thread thread-1: a retry of the turn is already queued ("Waiting for the session of main", for ${new Date(NOW + 2 * HOUR + BUFFER).toISOString()})`,
      ),
    ).toBe(true);
  });

  it("judges afresh a released thread whose turn had started on the old account", async () => {
    // Codex r5 (IR5-001): released on spare, its failure there is spare's,
    // not a leftover of main to retry on spare at once.
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    await h.harness.behavior.emitThreadEvent("thread.active", {
      thread: thread({ id: "thread-1", projectId: "proj-1" }),
    });
    await onePass(h);
    expect(h.retries).toEqual([retriedNow("thread-1", "creq_r1")]);
    await h.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({ threadId: "thread-1", requestId: "creq_r1", attemptNumber: 2 }),
    );
    expect(h.retries.map((r) => r.reason)).not.toContain(
      "Retrying on account spare",
    );
  });

  describe("a thread stuck in error", () => {
    // 2026-10-04: nine threads failed on a session limit at 02:04 and each
    // burnt its five attempts in three minutes (something retried them at
    // once); after the fifth, neither provider-retry nor this plugin looked
    // at them again, and they sat in error all night while two accounts had
    // room from 03:40. A thread in error with no retry queued is judged again
    // on every refresh, from bb's log alone (it survives a restart).
    /** bb's log of a thread whose turn failed on a limit: the request, the error and (unless `reported: false`) the limit report. */
    function failedLog(
      threadId: string,
      requestId: string,
      model: string,
      opts: {
        retry?: { of: string; attempt: number };
        category?: string;
        reported?: boolean;
        /** bb refused the turn at the door for this reason: no provider error in the log. */
        rejected?: string;
        /** When the turn was sent (default an hour before NOW). */
        at?: number;
      } = {},
    ): LoggedEvent[] {
      const rows: LoggedEvent[] = [
        {
          ...turnRequested(threadId, requestId, model, opts.retry),
          ...(opts.at === undefined ? {} : { createdAt: opts.at }),
        },
        opts.rejected !== undefined
          ? {
              seq: 2,
              type: "client/turn/rejected",
              data: { requestId, reason: opts.rejected },
            }
          : {
          seq: 2,
          type: "provider/error",
          data: {
            providerThreadId: "p",
            threadId,
            message: "Provider error",
            detail: "You've hit your session limit",
            errorInfo: {
              category: opts.category ?? "rate-limit",
              providerCode: "rate_limit_event",
              httpStatusCode: 429,
            },
          },
        },
      ];
      if (opts.reported !== false)
        rows.push({
          seq: 3,
          type: "provider/rateLimits/updated",
          data: {
            providerThreadId: "p",
            threadId,
            rateLimits: failure().rateLimits,
          },
        });
      return rows;
    }
    /** Every account with room for Fable (ALL_FREE has main's session spent). */
    const ROOM_EVERYWHERE = {
      main: () => Response.json(payload(10, 10, 10)),
      spare: () => Response.json(payload(10, 60, 10)),
      work: () => Response.json(payload(5, 20, 10)),
    };
    const stuck = (log: LoggedEvent[]): HostOptions => ({
      settings: FABLE,
      threads: { "thread-1": { status: "error" } },
      threadEvents: { "thread-1": log },
    });

    it("retries it on an account that can run it, from bb's log alone", async () => {
      const h = await host(MAIN_OUT, stuck(failedLog("thread-1", "creq_1", FABLE_ID)));
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
      expect(h.retries).toEqual([
        {
          threadId: "thread-1",
          turnRequestId: "creq_1",
          reason: "Switched to account spare (Fable)",
        },
      ]);
    });

    it("retries it on the project's own account when that one has room now, without moving", async () => {
      // Codex r6 (IR6-001): its log reports main blocked, but that report is
      // of the failure; measured now, main has room.
      const h = await host(ROOM_EVERYWHERE, stuck(failedLog("thread-1", "creq_1", FABLE_ID)));
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.envSet).toEqual([]);
      expect(h.retries).toEqual([
        {
          threadId: "thread-1",
          turnRequestId: "creq_1",
          reason: "Retrying on account main (Fable): it has room now",
        },
      ]);
    });

    it("runs the project's second stuck thread where the first one moved it", async () => {
      // Codex r6 (IR6-001): the first moves the project to spare; the second
      // is judged with spare as its own account, not as the one that failed.
      const h = await host(MAIN_OUT, {
        settings: FABLE,
        threads: { "thread-1": { status: "error" }, "thread-2": { status: "error" } },
        threadEvents: {
          "thread-1": failedLog("thread-1", "creq_1", FABLE_ID),
          "thread-2": failedLog("thread-2", "creq_2", FABLE_ID),
        },
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
      expect(h.retries).toEqual([
        {
          threadId: "thread-1",
          turnRequestId: "creq_1",
          reason: "Switched to account spare (Fable)",
        },
        {
          threadId: "thread-2",
          turnRequestId: "creq_2",
          reason: "Retrying on account spare (Fable): it has room now",
        },
      ]);
    });

    it("retries it on its own account when no limit was reported and the others are out", async () => {
      // Codex r6 (IR6-001): without a report the current account was left out
      // of the wait altogether, even as the only one with room.
      const only = {
        main: () => Response.json(payload(10, 10, 10)),
        spare: () => Response.json(payload(100, 60, 100)),
        work: () => Response.json(payload(100, 20, 100)),
      };
      const h = await host(
        only,
        stuck(failedLog("thread-1", "creq_1", FABLE_ID, { reported: false })),
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.envSet).toEqual([]);
      expect(h.retries.map((r) => r.reason)).toEqual([
        "Retrying on account main (Fable): it has room now",
      ]);
    });

    it("waits for its own account by what is measured now, not by the reset its old report named", async () => {
      // Codex r6 (IR6-001): all out; main's session resets in 2 h by its
      // numbers, the log's report (of some failure) said 5 h.
      const log = failedLog("thread-1", "creq_1", FABLE_ID);
      const report = log[2]!.data.rateLimits as { windows: Array<Record<string, unknown>> };
      report.windows = report.windows.map((w) => ({ ...w, resetsAtMs: NOW + 5 * HOUR }));
      const out = {
        main: () => Response.json(payload(100, 40, 10)),
        spare: () => Response.json(payload(100, 60, 100)),
        work: () => Response.json(payload(100, 20, 100)),
      };
      const h = await host(out, stuck(log));
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.envSet).toEqual([]);
      expect(h.retries.map((r) => r.reason)).toEqual(["Waiting for Fable on main"]);
      expect(h.retries[0]?.sendAt).toBeLessThan(NOW + 5 * HOUR);
    });

    it("marks the account a refusal in its log came from, so it does not bounce back there", async () => {
      // code-reviewer r6 (M1): two accounts with a dead login; without the
      // mark the thread moved between them on every refresh.
      const log: Record<string, LoggedEvent[]> = {
        "thread-1": failedLog("thread-1", "creq_1", FABLE_ID, {
          category: "unauthorized",
          reported: false,
        }),
      };
      // Only main and spare have Fable: with main marked, nowhere to bounce to.
      const h = await host(
        { ...ROOM_EVERYWHERE, work: () => Response.json(payload(5, 20, 100)) },
        { settings: FABLE, threads: { "thread-1": { status: "error" } }, threadEvents: log },
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
      expect(
        h.harness.logEntries.filter(
          (entry) => entry.level === "warn" && /account main refused a turn/.test(entry.message),
        ),
      ).toHaveLength(1);
      // Refused on spare too; main is still marked.
      log["thread-1"] = failedLog("thread-1", "creq_2", FABLE_ID, {
        category: "unauthorized",
        reported: false,
        retry: { of: "creq_1", attempt: 2 },
        at: NOW + 1,
      });
      await onePass(h);
      // Wherever it goes now (work's reset, at worst), not back to main.
      expect(h.envSet.slice(1).map((e) => e.value)).not.toContain(`${ACCOUNTS}/main`);
      expect(h.retries.slice(1).map((r) => r.reason)).not.toContain(
        "Switched to account main (Fable)",
      );
      expect(h.envSet.slice(1).map((e) => e.value)).toEqual([`${ACCOUNTS}/work`]);
    });

    it("attributes a refusal in the log to the account the project sat on when the turn was sent", async () => {
      // Codex r7 (IR7-001): after a restart, a thread refused on main before
      // the project moved to spare must not veto spare, where it has room.
      const h = await host(ROOM_EVERYWHERE, {
        ...stuck(failedLog("thread-1", "creq_1", FABLE_ID, { category: "unauthorized", reported: false })),
        presetEnv: {
          "proj-1": [{ name: ENV_VAR, note: ownNote("spare"), secret: true, value: null }],
        },
        kvPreset: {
          "switch-history": [
            {
              at: NOW - 30 * 60_000,
              threadId: "thread-9",
              projectId: "proj-1",
              from: "main",
              to: "spare",
              reason: "Switched to account spare",
            },
          ],
        },
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      const warned = h.harness.logEntries
        .filter((entry) => entry.level === "warn" && /refused a turn/.test(entry.message))
        .map((entry) => entry.message);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/^account main refused a turn/);
      expect(h.envSet).toEqual([]);
      expect(h.retries.map((r) => r.reason)).toEqual([
        "Retrying on account spare (Fable): it has room now",
      ]);
    });

    it("marks no account for a refusal older than its history of moves reaches", async () => {
      // Codex r7 (IR7-001): the history was cut short of the turn; the
      // project's account is judged on its measurements instead.
      const h = await host(ROOM_EVERYWHERE, {
        ...stuck(failedLog("thread-1", "creq_1", FABLE_ID, { category: "unauthorized", reported: false })),
        kvPreset: {
          "switch-history": Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
            at: NOW - 30 * 60_000 + i,
            threadId: "thread-9",
            projectId: "proj-2",
            from: i % 2 === 0 ? "main" : "spare",
            to: i % 2 === 0 ? "spare" : "main",
            reason: "Switched",
          })),
        },
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(
        h.harness.logEntries.filter((entry) => entry.level === "warn" && /refused a turn/.test(entry.message)),
      ).toEqual([]);
      expect(h.retries.map((r) => r.reason)).toEqual([
        "Retrying on account main (Fable): it has room now",
      ]);
    });

    it("tries the account that refused again once its mark expires, instead of marking it afresh from the same old failure", async () => {
      // code-reviewer r7: with one account, a thread refused at 02:00 was
      // re-marked on every pass after 08:00 and never retried after the
      // user logged in again.
      let clock = NOW;
      const h = await host(ROOM_EVERYWHERE, {
        ...stuck(failedLog("thread-1", "creq_1", FABLE_ID, { category: "unauthorized", reported: false })),
        dirs: () => ["main"],
        clock: () => clock,
      });
      dispose = () => h.harness.dispose();
      // One account: a pass is one usage call.
      const pass = async () => {
        const before = h.usageCalls.length;
        const run = h.harness.behavior.runService("usage-refresh");
        await vi.waitFor(() => {
          expect(h.usageCalls).toHaveLength(before + 1);
        });
        run.controller.abort();
        await run.done;
      };
      await pass();
      expect(h.retries).toEqual([]);
      clock = NOW + 6 * HOUR + 60_000;
      await pass();
      expect(h.retries.map((r) => r.reason)).toEqual([
        "Retrying on account main (Fable): it has room now",
      ]);
      expect(
        h.harness.logEntries.filter(
          (entry) => entry.level === "warn" && /account main refused a turn/.test(entry.message),
        ),
      ).toHaveLength(1);
    });

    it("judges it however many attempts failed: the cap stops a loop, not a thread left for dead", async () => {
      const h = await host(
        MAIN_OUT,
        stuck(
          failedLog("thread-1", "creq_7", FABLE_ID, {
            retry: { of: "creq_1", attempt: 7 },
          }),
        ),
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([
        {
          threadId: "thread-1",
          turnRequestId: "creq_7",
          reason: "Switched to account spare (Fable)",
        },
      ]);
    });

    it("waits for the earliest reset when no account can run it now, even with no limit report in its log", async () => {
      const out = {
        main: () => Response.json(payload(100, 40, 100)),
        spare: () => Response.json(payload(100, 60, 100)),
        work: () => Response.json(payload(100, 20, 100)),
      };
      const h = await host(
        out,
        stuck(failedLog("thread-1", "creq_1", FABLE_ID, { reported: false })),
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([
        {
          threadId: "thread-1",
          turnRequestId: "creq_1",
          reason: expect.stringMatching(/^Waiting for Fable on /),
          sendAt: expect.any(Number),
        },
      ]);
      expect(h.retries[0]?.sendAt).toBeGreaterThanOrEqual(NOW + BUFFER);
    });

    it("leaves it alone while anything is queued for it: a wait is judged, not doubled", async () => {
      const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
        threadEvents: {
          "thread-1": failedLog("thread-1", "creq_r1", FABLE_ID),
        },
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([retriedNow("thread-1", "creq_r1")]);
    });

    it("judges the failure of its latest turn, not an older limit in its log", async () => {
      // Codex r6 (IR6-004): the limit was creq_1's; creq_2, sent by hand
      // later, failed for something that left no provider error.
      const log = failedLog("thread-1", "creq_1", FABLE_ID);
      log.push({ ...turnRequested("thread-1", "creq_2", FABLE_ID), seq: 9 });
      const h = await host(MAIN_OUT, stuck(log));
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.envSet).toEqual([]);
    });

    it("rescues a turn bb refused at the door for a limit, which leaves no provider error", async () => {
      // Codex r6 (IR6-003): bb's own failure event reads the rejection.
      const h = await host(
        MAIN_OUT,
        stuck(failedLog("thread-1", "creq_1", FABLE_ID, { rejected: "rate_limited" })),
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries.map((r) => r.reason)).toEqual(["Switched to account spare (Fable)"]);
    });

    it("reads a turn refused at the door for its login as a refusal", async () => {
      const h = await host(
        ROOM_EVERYWHERE,
        stuck(failedLog("thread-1", "creq_1", FABLE_ID, { rejected: "auth_required", reported: false })),
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(
        h.harness.logEntries.some(
          (entry) => entry.level === "warn" && /account main refused a turn/.test(entry.message),
        ),
      ).toBe(true);
      expect(h.envSet.map((e) => e.value)).not.toContain(`${ACCOUNTS}/main`);
      expect(h.retries).toHaveLength(1);
    });

    it("leaves it when, by the time its project's turn comes, it is no longer in error", async () => {
      // Codex r6 (IR6-005): listed in error, running again (or archived)
      // once the pass reaches it.
      const h = await host(MAIN_OUT, {
        ...stuck(failedLog("thread-1", "creq_1", FABLE_ID)),
        threadsLive: { "thread-1": { status: "active" } },
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.envSet).toEqual([]);
    });

    it("leaves it when it has moved to another project since it was listed", async () => {
      // code-reviewer r7: the next pass lists it under its new project.
      const h = await host(MAIN_OUT, {
        ...stuck(failedLog("thread-1", "creq_1", FABLE_ID)),
        threadsLive: { "thread-1": { projectId: "proj-2" } },
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.envSet).toEqual([]);
    });

    it("leaves a retry another plugin queued while the pass ran, without sending it", async () => {
      // Codex r6 (IR6-002, IR6-005): queued after the pass took its snapshot,
      // maybe held by that plugin; an explicit send would skip its hold.
      const h = await host(MAIN_OUT, {
        ...stuck(failedLog("thread-1", "creq_1", FABLE_ID)),
        queueAfterList: [
          {
            id: "theirs",
            threadId: "thread-1",
            sendAt: null,
            payload: { kind: "retry", attempt: 2, reason: "Theirs", retryOfTurnRequestId: "creq_1" },
          },
        ],
      });
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.envSet).toEqual([]);
    });

    it("leaves a retry queued between its reads and its own, without sending it", async () => {
      // Codex r6 (IR6-002): past the queue's re-read, another plugin queues
      // (and may hold) a retry; the rescue neither sends nor replaces it.
      const options = stuck(failedLog("thread-1", "creq_1", FABLE_ID));
      let theirs: QueuedRow[] = [];
      options.beforeEvents = async () => {
        h.queued.push(...theirs);
        theirs = [];
      };
      const h = await host(MAIN_OUT, options);
      dispose = () => h.harness.dispose();
      theirs = [
        {
          id: "theirs",
          threadId: "thread-1",
          sendAt: null,
          payload: { kind: "retry", attempt: 2, reason: "Theirs", retryOfTurnRequestId: "creq_1" },
        },
      ];
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.deleted).toEqual([]);
    });

    it("stops when auto-switch is turned off while it reads", async () => {
      // Codex r6 (IR6-006).
      const options = stuck(failedLog("thread-1", "creq_1", FABLE_ID));
      let off: () => Promise<void> = async () => {};
      options.beforeEvents = () => off();
      const h = await host(MAIN_OUT, options);
      dispose = () => h.harness.dispose();
      off = async () => {
        await h.harness.behavior.setSettings({ autoSwitch: false });
      };
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.envSet).toEqual([]);
    });

    it("does not retry when auto-switch is turned off as it moves the project", async () => {
      // Codex r6 (IR6-006): off between the move and the retry.
      const options = stuck(failedLog("thread-1", "creq_1", FABLE_ID));
      let off: () => Promise<void> = async () => {};
      options.beforeSet = () => off();
      const h = await host(MAIN_OUT, options);
      dispose = () => h.harness.dispose();
      off = async () => {
        await h.harness.behavior.setSettings({ autoSwitch: false });
      };
      await onePass(h);
      expect(h.retries).toEqual([]);
    });

    it("leaves a thread whose failure was not a limit", async () => {
      const h = await host(
        MAIN_OUT,
        stuck(failedLog("thread-1", "creq_1", FABLE_ID, { category: "unknown" })),
      );
      dispose = () => h.harness.dispose();
      await onePass(h);
      expect(h.retries).toEqual([]);
      expect(h.envSet).toEqual([]);
    });
  });

  it("judges a wait by the model its retry runs with, not by the model the thread used last", async () => {
    // main is out of Fable only: it can still run Opus.
    const fableOut = {
      ...MAIN_OUT,
      main: () => Response.json(payload(10, 40, 100)),
    };
    const opus = await waitingHost(
      fableOut,
      [{ ...waiting("r1", "thread-1"), model: OPUS_ID }],
      {
        threadEvents: {
          "thread-1": [turnRequested("thread-1", "creq_r1", FABLE_ID)],
        },
      },
    );
    await onePass(opus);
    expect(opus.envSet).toEqual([]);
    expect(opus.retries).toEqual([]);
    opus.harness.dispose();
    const fable = await waitingHost(fableOut, [waiting("r1", "thread-1")], {
      settings: { preferredModel: "Opus" },
      threadEvents: {
        "thread-1": [turnRequested("thread-1", "creq_r1", OPUS_ID)],
      },
    });
    dispose = () => fable.harness.dispose();
    await onePass(fable);
    expect(fable.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(fable.retries).toEqual([retriedNow("thread-1", "creq_r1")]);
  });

  it("retries a wait of a retry that failed again by that retry's own request", async () => {
    const row: QueuedRow = {
      ...waiting("r1", "thread-1"),
      payload: {
        kind: "retry",
        attempt: 3,
        reason: "Waiting for the session of main",
        retryOfTurnRequestId: "creq_r1",
      },
    };
    const h = await waitingHost(MAIN_OUT, [row], {
      threadEvents: {
        "thread-1": [
          turnRequested("thread-1", "creq_r1b", FABLE_ID, {
            of: "creq_r1",
            attempt: 2,
          }),
        ],
      },
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.retries).toEqual([retriedNow("thread-1", "creq_r1b")]);
  });

  it("leaves a retry of an earlier turn: the user wrote meanwhile, or its chain has moved on", async () => {
    const latest = [
      // The user's message after it failed too: bb would retry that one.
      turnRequested("thread-1", "creq_new", FABLE_ID),
      // The same chain, already one attempt further.
      turnRequested("thread-1", "creq_r1c", FABLE_ID, {
        of: "creq_r1",
        attempt: 2,
      }),
    ];
    for (const event of latest) {
      const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
        threadEvents: { "thread-1": [event] },
      });
      await onePass(h);
      expect(h.envSet).toEqual([]);
      expect(h.deleted).toEqual([]);
      expect(h.retries).toEqual([]);
      h.harness.dispose();
    }
  });

  it("queues the wait again as it was when bb does not take the retry", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      retryBehaviour: "fail-once",
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.deleted).toEqual(["r1"]);
    expect(h.retries).toEqual([
      {
        threadId: "thread-1",
        turnRequestId: "creq_r1",
        reason: "Waiting for the session of main",
        sendAt: NOW + 2 * HOUR + BUFFER,
      },
    ]);
    expect(h.queued.map((r) => r.sendAt)).toEqual([NOW + 2 * HOUR + BUFFER]);
  });

  it("leaves the wait when no other account can run the thread's model: a Fable wait never moves to an account out of Fable", async () => {
    const h = await waitingHost(
      { ...MAIN_OUT, spare: () => Response.json(payload(10, 60, 100)) },
      [waiting("r1", "thread-1")],
    );
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.queued.map((r) => r.id)).toEqual(["r1"]);
  });

  it("leaves a wait whose account can run and has not moved since: it waits for something else (a backoff), not for a limit", async () => {
    const h = await waitingHost(
      { ...MAIN_OUT, main: () => Response.json(payload(10, 40, 20)) },
      [waiting("r1", "thread-1")],
    );
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it("leaves a wait whose account could not be measured or answered without its windows: nothing says it is out", async () => {
    const answers = [
      () => new Response("busy", { status: 429 }),
      () =>
        Response.json({
          limits: [],
          five_hour: { locked_reason: null },
          seven_day: { locked_reason: null },
        }),
    ];
    for (const main of answers) {
      const h = await waitingHost({ ...MAIN_OUT, main }, [
        waiting("r1", "thread-1"),
      ]);
      await onePass(h);
      expect(h.envSet).toEqual([]);
      expect(h.deleted).toEqual([]);
      h.harness.dispose();
    }
  });

  it("leaves a wait due within two minutes (about to run anyway, or a provider-retry backoff), and not one just past it", async () => {
    const edge = NOW + 2 * 60_000;
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1", edge)]);
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
    h.harness.dispose();
    const later = await waitingHost(MAIN_OUT, [
      waiting("r1", "thread-1", edge + 1),
    ]);
    dispose = () => later.harness.dispose();
    await onePass(later);
    expect(later.deleted).toEqual(["r1"]);
  });

  it("does nothing with automatic switching off, an untimed or non-retry row, a row another plugin holds, or a thread that is not the user's failed Claude Code thread", async () => {
    const row = waiting("r1", "thread-1");
    // The last field: how often the thread is read (the first rows are dropped at the look).
    const cases: Array<[QueuedRow, HostOptions, number]> = [
      [row, { settings: { ...FABLE, autoSwitch: false } }, 0],
      [{ ...row, sendAt: null }, {}, 0],
      [{ ...row, payload: { kind: "inline" } }, {}, 0],
      [
        {
          ...row,
          waitingOn: { kind: "plugin", pluginId: "limiter", reason: "budget" },
        },
        {},
        0,
      ],
      [
        row,
        { threads: { "thread-1": { status: "error", providerId: "codex" } } },
        1,
      ],
      [
        row,
        { threads: { "thread-1": { status: "error", visibility: "hidden" } } },
        1,
      ],
      // bb retries only a thread whose latest turn failed.
      [row, { threads: { "thread-1": { status: "idle" } } }, 1],
      // bb refuses to retry an archived thread: its wait would be lost.
      [row, { threads: { "thread-1": { status: "error", archivedAt: NOW } } }, 1],
      [row, { threads: { "thread-1": { status: "error", deletedAt: NOW } } }, 1],
    ];
    for (const [queued, options, reads] of cases) {
      const h = await waitingHost(MAIN_OUT, [queued], options);
      await onePass(h);
      expect(h.harness.sdk.callsTo("threads.get")).toHaveLength(reads);
      // Switched off: not even the queue is read.
      if (options.settings?.autoSwitch === false)
        expect(h.harness.sdk.callsTo("threads.queue.list")).toEqual([]);
      expect(h.envSet).toEqual([]);
      expect(h.deleted).toEqual([]);
      expect(h.retries).toEqual([]);
      h.harness.dispose();
    }
  });

  it("never touches a project whose account variable was set outside the plugin", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      presetEnv: {
        "proj-1": [
          { name: ENV_VAR, note: "set by hand", secret: true, value: null },
        ],
      },
    });
    dispose = () => h.harness.dispose();
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it("decides on the project's account as it is after reading the thread, not as it was before", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub(
      "threads.events.list",
      async () => {
        // Moved to spare meanwhile (by another turn's placement, or by hand).
        h.env.set("proj-1", [
          { name: ENV_VAR, note: ownNote("spare"), secret: true, value: null },
        ]);
        return [turnRequested("thread-1", "creq_r1", FABLE_ID)];
      },
    );
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it("stops when automatic switching is turned off during the pass: nothing moved, nothing retried", async () => {
    const h = await waitingHost(MAIN_OUT, [
      waiting("r1", "thread-1"),
      waiting("r2", "thr-2"),
    ]);
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub(
      "threads.queuedMessages.list",
      async (args: { threadId: string }) => {
        await h.harness.behavior.setSettings({ autoSwitch: false });
        return h.queued.filter((r) => r.threadId === args.threadId);
      },
    );
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.retries).toEqual([]);
    // The second wait is not even looked at.
    expect(JSON.stringify(h.harness.sdk.callsTo("threads.get"))).not.toContain(
      "thr-2",
    );
  });

  it("does not retry a wait when automatic switching is turned off while the project moves", async () => {
    let off: (() => Promise<unknown>) | null = null;
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")], {
      beforeSet: () => off?.() ?? Promise.resolve(),
    });
    dispose = () => h.harness.dispose();
    off = () => h.harness.behavior.setSettings({ autoSwitch: false });
    await onePass(h);
    expect(h.envSet.map((e) => e.value)).toEqual([`${ACCOUNTS}/spare`]);
    expect(h.deleted).toEqual([]);
    expect(h.retries).toEqual([]);
  });

  it("a failed look at the queue leaves everything as it was and the refresh goes on", async () => {
    const h = await waitingHost(MAIN_OUT, [waiting("r1", "thread-1")]);
    dispose = () => h.harness.dispose();
    h.harness.sdk.stub("threads.queue.list", async () => {
      throw new Error("HTTP 503: bb is restarting");
    });
    await onePass(h);
    expect(h.envSet).toEqual([]);
    expect(h.deleted).toEqual([]);
  });
});
