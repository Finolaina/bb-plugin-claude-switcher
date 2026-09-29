import { describe, expect, it } from "vitest";
import type { Account } from "./accounts.js";
import type { CredentialIo } from "./credentials.js";
import { UsageCollector } from "./collector.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const ACCOUNT: Account = {
  name: "work",
  configDir: "/Users/x/.claude-accounts/work",
  email: "work@example.com",
  accountUuid: "uuid-work",
};

const PAYLOAD = {
  limits: [
    { kind: "session", percent: 20, resets_at: "2026-09-29T14:00:00+00:00" },
    { kind: "weekly_all", percent: 78, resets_at: "2026-10-03T08:00:00+00:00" },
  ],
  five_hour: { locked_reason: null },
  seven_day: { locked_reason: null },
};

interface IoOptions {
  loggedIn?: boolean;
  /** Stored expiry; NOW - 1 makes every collect refresh first. */
  expiresAt?: number;
  /** Exit code of add-generic-password. */
  addCode?: number;
}

function io(responses: Array<() => Response>, options: IoOptions = {}) {
  const store = new Map<string, string>();
  const posts: string[] = [];
  const credentialIo: CredentialIo = {
    platform: "darwin",
    username: "x",
    home: "/Users/x",
    async exec(args) {
      const service = args[args.indexOf("-s") + 1]!;
      if (args[0] === "add-generic-password") {
        if ((options.addCode ?? 0) !== 0)
          return { code: options.addCode!, stdout: "" };
        store.set(
          service,
          Buffer.from(args[args.indexOf("-X") + 1]!, "hex").toString("utf8"),
        );
        return { code: 0, stdout: "" };
      }
      if (args[0] !== "find-generic-password" || options.loggedIn === false) {
        return { code: 44, stdout: "" };
      }
      // Reads are async in reality: lets concurrent collects interleave.
      await new Promise((r) => setTimeout(r, 1));
      return {
        code: 0,
        stdout:
          store.get(service) ??
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "tok",
              refreshToken: "ref",
              expiresAt: options.expiresAt ?? NOW + 3_600_000,
            },
          }),
      };
    },
    async readFile() {
      throw new Error("ENOENT");
    },
    async writeFile() {},
    fetch: async (url, init) => {
      if (String(url).includes("/oauth/token")) {
        posts.push(JSON.parse(String(init?.body)).refresh_token);
        await new Promise((r) => setTimeout(r, 2));
        return Response.json({
          access_token: "tok-new",
          refresh_token: "ref-new",
          expires_in: 3600,
        });
      }
      return responses.shift()!();
    },
  };
  return { credentialIo, posts };
}

describe("UsageCollector", () => {
  it("stores a fresh measurement with the time it was observed", async () => {
    let clock = NOW;
    const collector = new UsageCollector({
      io: io([() => Response.json(PAYLOAD)]).credentialIo,
      now: () => clock,
    });
    clock = NOW + 5;
    const measurement = await collector.collect(ACCOUNT);
    expect(measurement).toEqual({
      observedAt: NOW + 5,
      problem: null,
      usage: {
        blocked: false,
        session: {
          usedPercent: 20,
          resetsAt: Date.parse("2026-09-29T14:00:00Z"),
        },
        weekly: {
          usedPercent: 78,
          resetsAt: Date.parse("2026-10-03T08:00:00Z"),
        },
        models: {},
      },
    });
    expect(collector.get("work")).toBe(measurement);
  });

  it("keeps the last good usage when the usage endpoint rate-limits the query", async () => {
    const collector = new UsageCollector({
      io: io([
        () => Response.json(PAYLOAD),
        () => new Response("", { status: 429 }),
      ]).credentialIo,
      now: () => NOW,
    });
    const first = await collector.collect(ACCOUNT);
    const second = await collector.collect(ACCOUNT);
    expect(second.usage).toEqual(first.usage);
    expect(second.observedAt).toBe(NOW);
    expect(second.problem).toEqual({
      kind: "error",
      message: expect.stringMatching(/rate/i),
    });
  });

  it("stops offering a measurement to the policy once its query keeps failing and it is older than the limit", async () => {
    let clock = NOW;
    const collector = new UsageCollector({
      io: io([
        () => Response.json(PAYLOAD),
        () => new Response("", { status: 429 }),
        () => new Response("", { status: 429 }),
      ]).credentialIo,
      now: () => clock,
    });
    await collector.collect(ACCOUNT);
    clock = NOW + 5 * 60_000;
    await collector.collect(ACCOUNT);
    // Failing, but still young: the last good usage stands.
    expect(collector.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
    clock = NOW + 10 * 60_000 + 1;
    await collector.collect(ACCOUNT);
    // Failing and older than the limit, but it was FREE when measured: a
    // reset that merely passed on the clock cannot have made it worse, so
    // it stays a candidate (a wrong switch costs one attempt; a wrong wait
    // costs hours).
    expect(collector.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
    // The same, measured BLOCKED: after the limit it is unknown, never
    // chosen (still shown, with its problem, by the collector's cache),
    // because only the clock says its reset has passed.
    const blocked = new UsageCollector({
      io: io([
        () =>
          Response.json({
            ...PAYLOAD,
            limits: [
              { kind: "session", percent: 100, resets_at: "2026-09-29T10:05:00+00:00" },
              PAYLOAD.limits[1],
            ],
          }),
        () => new Response("", { status: 429 }),
        () => new Response("", { status: 429 }),
      ]).credentialIo,
      now: () => clock,
    });
    clock = NOW;
    await blocked.collect(ACCOUNT);
    clock = NOW + 6 * 60_000;
    await blocked.collect(ACCOUNT);
    expect(blocked.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
    // Exactly at the limit it is still eligible; one millisecond past, not.
    clock = NOW + 10 * 60_000;
    expect(blocked.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
    clock = NOW + 10 * 60_000 + 1;
    await blocked.collect(ACCOUNT);
    expect(blocked.usable(10 * 60_000)).toEqual([]);
    expect(blocked.get("work")?.usage).not.toBeNull();
    // A model window at 100 % counts as blocked too: the policy may prefer
    // that model, and only the clock would say its reset has passed.
    const model = new UsageCollector({
      io: io([
        () =>
          Response.json({
            ...PAYLOAD,
            limits: [
              ...PAYLOAD.limits,
              {
                kind: "weekly_scoped",
                percent: 100,
                resets_at: "2026-09-29T10:05:00+00:00",
                scope: { model: { display_name: "Fable" } },
              },
            ],
          }),
        () => new Response("", { status: 429 }),
      ]).credentialIo,
      now: () => clock,
    });
    clock = NOW;
    await model.collect(ACCOUNT);
    clock = NOW + 10 * 60_000 + 1;
    await model.collect(ACCOUNT);
    expect(model.usable(10 * 60_000, "Fable")).toEqual([]);
    // Without a preferred model that window is irrelevant to the choice.
    expect(model.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
    // A block whose reset is still AHEAD is not a guess: the clock frees
    // nothing yet, and the policy may rightly wait for that reset.
    const ahead = new UsageCollector({
      io: io([
        () =>
          Response.json({
            ...PAYLOAD,
            limits: [
              { kind: "session", percent: 100, resets_at: "2026-09-29T14:00:00+00:00" },
              PAYLOAD.limits[1],
              {
                kind: "weekly_scoped",
                percent: 100,
                resets_at: "2026-09-29T16:00:00+00:00",
                scope: { model: { display_name: "Fable" } },
              },
            ],
          }),
        () => new Response("", { status: 429 }),
      ]).credentialIo,
      now: () => clock,
    });
    clock = NOW;
    await ahead.collect(ACCOUNT);
    clock = NOW + 30 * 60_000;
    await ahead.collect(ACCOUNT);
    expect(ahead.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
    expect(ahead.usable(10 * 60_000, "Fable").map((a) => a.name)).toEqual(["work"]);
    // Once the session reset passes with the endpoint still down, the
    // clock alone would free it: dropped.
    clock = Date.parse("2026-09-29T14:00:00.001Z");
    expect(ahead.usable(10 * 60_000)).toEqual([]);
    // For Fable it is still known blocked until 16:00: a wait, not a guess.
    expect(ahead.usable(10 * 60_000, "Fable").map((a) => a.name)).toEqual(["work"]);
    // No limit means the old rule.
    expect(collector.usable().map((a) => a.name)).toEqual(["work"]);
    // Age alone is no problem: a measurement whose last query succeeded
    // stays usable however old (the refresh loop keeps it fresh anyway).
    const fine = new UsageCollector({
      io: io([() => Response.json(PAYLOAD)]).credentialIo,
      now: () => clock,
    });
    clock = NOW;
    await fine.collect(ACCOUNT);
    clock = NOW + 24 * 3_600_000;
    expect(fine.usable(10 * 60_000).map((a) => a.name)).toEqual(["work"]);
  });

  it("drops the usage when the token stops being accepted (401): no stale windows for a dead login", async () => {
    const collector = new UsageCollector({
      io: io([
        () => Response.json(PAYLOAD),
        () => new Response("", { status: 401 }),
      ]).credentialIo,
      now: () => NOW,
    });
    await collector.collect(ACCOUNT);
    expect(await collector.collect(ACCOUNT)).toEqual({
      observedAt: null,
      problem: { kind: "unauthenticated" },
      usage: null,
    });
    expect(collector.usable()).toEqual([]);
  });

  it("reports no login as unauthenticated with no usage", async () => {
    const collector = new UsageCollector({
      io: io([], { loggedIn: false }).credentialIo,
      now: () => NOW,
    });
    expect(await collector.collect(ACCOUNT)).toEqual({
      observedAt: null,
      problem: { kind: "unauthenticated" },
      usage: null,
    });
  });

  it("turns a malformed payload into an error, never into zero usage", async () => {
    const collector = new UsageCollector({
      io: io([
        () => Response.json({ limits: [{ kind: "session", percent: "20" }] }),
      ]).credentialIo,
      now: () => NOW,
    });
    const measurement = await collector.collect(ACCOUNT);
    expect(measurement.usage).toBeNull();
    expect(measurement.problem).toEqual({
      kind: "error",
      message: expect.stringMatching(/percent/),
    });
  });

  it("shares one query between concurrent collects of the same account: one refresh, one usage call", async () => {
    let usageCalls = 0;
    const { credentialIo, posts } = io(
      [
        () => {
          usageCalls += 1;
          return Response.json(PAYLOAD);
        },
        () => {
          usageCalls += 1;
          return Response.json(PAYLOAD);
        },
      ],
      { expiresAt: NOW - 1 },
    );
    const collector = new UsageCollector({ io: credentialIo, now: () => NOW });
    const results = await Promise.all([
      collector.collect(ACCOUNT),
      collector.collect(ACCOUNT),
      collector.collect(ACCOUNT),
    ]);
    expect(posts).toEqual(["ref"]);
    expect(usageCalls).toBe(1);
    expect(results[1]).toBe(results[0]);
    // A later collect is a new query, with the token written back (no refresh).
    await collector.collect(ACCOUNT);
    expect(usageCalls).toBe(2);
    expect(posts).toEqual(["ref"]);
  });

  it("reports a rotated login it could not write back, next to the usage it still measured", async () => {
    const { credentialIo } = io([() => Response.json(PAYLOAD)], {
      expiresAt: NOW - 1,
      addCode: 1,
    });
    const collector = new UsageCollector({ io: credentialIo, now: () => NOW });
    const measurement = await collector.collect(ACCOUNT);
    expect(measurement.usage).not.toBeNull();
    expect(measurement.problem).toEqual({
      kind: "error",
      message: expect.stringMatching(/not written back/),
    });
  });

  it("keeps the last good usage when the token endpoint is down (5xx is not a logout)", async () => {
    const { credentialIo } = io([() => Response.json(PAYLOAD)], {});
    const collector = new UsageCollector({ io: credentialIo, now: () => NOW });
    const good = await collector.collect(ACCOUNT);
    const down: CredentialIo = {
      ...credentialIo,
      async exec(args) {
        const r = await credentialIo.exec(args);
        return {
          ...r,
          stdout: r.stdout.replace(String(NOW + 3_600_000), String(NOW - 1)),
        };
      },
      fetch: async () => new Response("", { status: 503 }),
    };
    const later = new UsageCollector({ io: down, now: () => NOW });
    later["cache"].set("work", good);
    const measurement = await later.collect(ACCOUNT);
    expect(measurement.usage).toEqual(good.usage);
    expect(measurement.problem).toEqual({
      kind: "error",
      message: expect.stringMatching(/503/),
    });
  });

  it("collects every account in turn, one pass at a time, and exposes them for the policy", async () => {
    const other: Account = {
      ...ACCOUNT,
      name: "spare",
      accountUuid: "uuid-spare",
    };
    let usageCalls = 0;
    const collector = new UsageCollector({
      io: io([
        () => {
          usageCalls += 1;
          return Response.json(PAYLOAD);
        },
        () => {
          usageCalls += 1;
          return new Response("", { status: 401 });
        },
      ]).credentialIo,
      now: () => NOW,
    });
    await Promise.all([
      collector.collectAll([ACCOUNT, other]),
      collector.collectAll([ACCOUNT, other]),
    ]);
    expect(usageCalls).toBe(2);
    expect(collector.get("spare")?.problem).toEqual({
      kind: "unauthenticated",
    });
    expect(collector.usable().map((a) => a.name)).toEqual(["work"]);
  });

  it("forgets accounts that disappeared, so they are never chosen", async () => {
    const collector = new UsageCollector({
      io: io([() => Response.json(PAYLOAD)]).credentialIo,
      now: () => NOW,
    });
    await collector.collect(ACCOUNT);
    collector.prune([{ ...ACCOUNT, name: "spare", configDir: "/Users/x/spare" }]);
    expect(collector.get("work")).toBeUndefined();
    expect(collector.usable()).toEqual([]);
  });

  it("prune also drops the pending rotated login of a vanished account", async () => {
    // The store rejects the write, so the rotated login stays pending in memory.
    const { credentialIo, posts } = io(
      [() => Response.json(PAYLOAD), () => Response.json(PAYLOAD)],
      { expiresAt: NOW - 1, addCode: 1 },
    );
    const collector = new UsageCollector({ io: credentialIo, now: () => NOW });
    expect((await collector.collect(ACCOUNT)).problem?.kind).toBe("error");
    collector.prune([]);
    // Back on disk with the store's (old) login: refreshed from THAT one, not from the pending memory.
    await collector.collect(ACCOUNT);
    expect(posts).toEqual(["ref", "ref"]);
  });
});
