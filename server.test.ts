import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import type {
  PluginThreadEventPayloads,
  PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";

type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
import { createPlugin, ENV_VAR, type State } from "./server.js";
import type { AccountsIo } from "./src/accounts.js";
import type { CredentialIo } from "./src/credentials.js";
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
            expiresAt: NOW + HOUR,
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
  return { credentialIo, accountsIo, usageCalls };
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
}

interface HostOptions {
  settings?: Record<string, string | number | boolean>;
  presetEnv?: Record<string, EnvVar[]>;
  /** Rows already queued (e.g. by provider-retry) when the plugin acts. */
  queued?: QueuedRow[];
  /** What threads.retry does: default queues a row; "conflict" throws like bb's 409; "fail-once" fails the first call (a 5xx); "fail" fails every call. */
  retryBehaviour?: "queue" | "conflict" | "fail-once" | "fail";
  /** queuedMessages.send throws this, shaped like bb's BbHttpError: `code` apart from the message. */
  sendError?: { message: string; code?: string; status?: number };
  /** deleteMachineEnvironmentVariable throws for these projects (deleted meanwhile, or a bb hiccup). */
  failDelete?: string[];
  /** queuedMessages.delete throws this (the row left the queue between list and delete). */
  deleteRowError?: { message: string; code?: string; status?: number };
  dirs?: () => string[];
  clock?: () => number;
  /** What threads.get answers per thread, over a visible Claude Code thread of the user. */
  threads?: Record<string, Partial<ThreadResponse>>;
  /** Plugin storage answers every read with this error while the plugin loads. */
  kvReadError?: string;
  /** Values already in plugin storage when the plugin loads. */
  kvPreset?: Record<string, unknown>;
  /** When each project was created; default: proj-1 and proj-2 a day before NOW, any other just after. */
  projectCreatedAt?: Record<string, number>;
  /** setMachineEnvironmentVariable throws for these projects. */
  failSet?: string[];
}

async function host(
  usage: Record<string, () => Response>,
  options: HostOptions = {},
) {
  const envSet: EnvCall[] = [];
  const envDeleted: EnvCall[] = [];
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
  const { credentialIo, accountsIo, usageCalls } = fakes(
    usage,
    options.dirs ?? (() => ["spare", "work"]),
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
          }),
        retry: async (args: (typeof retries)[number]) => {
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
          retries.push(args);
          const id = `q${nextId++}`;
          // An immediate retry is dispatched at once; only a timed one waits in the queue.
          if (args.sendAt !== undefined)
            queued.push({
              id,
              threadId: args.threadId,
              payload: {
                kind: "retry",
                attempt: (attemptOf.get(args.turnRequestId ?? "") ?? 1) + 1,
                reason: args.reason ?? "",
                retryOfTurnRequestId: args.turnRequestId ?? "",
              },
              sendAt: args.sendAt ?? null,
            });
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
              const { message, ...rest } = options.deleteRowError;
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
        machineEnvironment: async ({ projectId }: { projectId: string }) =>
          envList(projectId),
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
    now: options.clock ?? (() => NOW),
    random: () => 0,
  });
  fake.bb.storage.kv.get = kvGet;
  return {
    ...fake,
    env,
    envSet,
    envDeleted,
    retries,
    sent,
    deleted,
    queued,
    usageCalls,
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
      "defaultAccountName",
      "maximumWaitHours",
      "preferredModel",
      "refreshMinutes",
    ]);
    expect(h.harness.registrations.rpcMethods.sort()).toEqual(
      [
        "accounts_list",
        "accounts_refresh",
        "project_set_account",
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
});
