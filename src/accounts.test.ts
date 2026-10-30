import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { discoverAccounts, planOf, type AccountsIo } from "./accounts.js";
import { parseUsage } from "./usage.js";

const HOME = "/Users/someone";
const ACCOUNTS = `${HOME}/.claude-accounts`;

function claudeJson(email: string, uuid: string) {
  return JSON.stringify({
    numStartups: 3,
    oauthAccount: { accountUuid: uuid, emailAddress: email, displayName: "X" },
  });
}

function fakeIo(files: Record<string, string>, dirs: Record<string, string[]>) {
  const io: AccountsIo = {
    home: HOME,
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    async listDirs(path) {
      return dirs[path] ?? [];
    },
  };
  return io;
}

describe("discoverAccounts", () => {
  it("lists the default dir first and every accounts subdir that has a .claude.json", async () => {
    const io = fakeIo(
      {
        [`${HOME}/.claude.json`]: claudeJson("main@example.com", "uuid-main"),
        [`${ACCOUNTS}/work/.claude.json`]: claudeJson(
          "work@example.com",
          "uuid-work",
        ),
        [`${ACCOUNTS}/spare/.claude.json`]: claudeJson(
          "spare@example.com",
          "uuid-spare",
        ),
      },
      { [ACCOUNTS]: ["spare", "work", "not-an-account"] },
    );
    const accounts = await discoverAccounts(io, {
      accountsDir: ACCOUNTS,
      defaultAccountName: "main",
    });
    expect(accounts).toEqual([
      {
        name: "main",
        configDir: null,
        email: "main@example.com",
        accountUuid: "uuid-main",
        kind: "unknown",
      },
      {
        name: "spare",
        configDir: `${ACCOUNTS}/spare`,
        email: "spare@example.com",
        accountUuid: "uuid-spare",
        kind: "unknown",
      },
      {
        name: "work",
        configDir: `${ACCOUNTS}/work`,
        email: "work@example.com",
        accountUuid: "uuid-work",
        kind: "unknown",
      },
    ]);
  });

  it("keeps a dir without login as an account with no email", async () => {
    const io = fakeIo(
      {
        [`${ACCOUNTS}/fresh/.claude.json`]: JSON.stringify({ numStartups: 0 }),
      },
      { [ACCOUNTS]: ["fresh"] },
    );
    const accounts = await discoverAccounts(io, {
      accountsDir: ACCOUNTS,
      defaultAccountName: "default",
    });
    expect(accounts).toEqual([
      { name: "default", configDir: null, email: null, accountUuid: null, kind: "unknown" },
      {
        name: "fresh",
        configDir: `${ACCOUNTS}/fresh`,
        email: null,
        accountUuid: null,
        kind: "unknown",
      },
    ]);
  });

  it("takes an empty account id as none: two such directories are not one account", async () => {
    const io = fakeIo(
      {
        [`${ACCOUNTS}/blank/.claude.json`]: claudeJson("blank@example.com", ""),
      },
      { [ACCOUNTS]: ["blank"] },
    );
    const accounts = await discoverAccounts(io, {
      accountsDir: ACCOUNTS,
      defaultAccountName: "default",
    });
    expect(accounts[1]).toMatchObject({ name: "blank", accountUuid: null });
  });

  it("expands ~ in the accounts dir and tolerates a missing dir", async () => {
    const io = fakeIo({}, {});
    const accounts = await discoverAccounts(io, {
      accountsDir: "~/.claude-accounts",
      defaultAccountName: "default",
    });
    expect(accounts).toEqual([
      { name: "default", configDir: null, email: null, accountUuid: null, kind: "unknown" },
    ]);
  });

  it("skips a subdir that shadows the default account name, with a warning, instead of failing every account", async () => {
    const io = fakeIo(
      {
        [`${ACCOUNTS}/default/.claude.json`]: claudeJson(
          "dup@example.com",
          "uuid-dup",
        ),
        [`${ACCOUNTS}/work/.claude.json`]: claudeJson(
          "work@example.com",
          "uuid-work",
        ),
      },
      { [ACCOUNTS]: ["default", "work"] },
    );
    const warnings: string[] = [];
    const accounts = await discoverAccounts(io, {
      accountsDir: ACCOUNTS,
      defaultAccountName: "default",
      warn: (message) => warnings.push(message),
    });
    expect(accounts.map((a) => a.name)).toEqual(["default", "work"]);
    expect(accounts[0]?.configDir).toBeNull();
    expect(warnings).toEqual([
      expect.stringMatching(/"default".*collides.*rename/),
    ]);
  });

  it("normalises the accounts dir (trailing slash, ~) and rejects a relative one", async () => {
    const io = fakeIo(
      {
        [`${ACCOUNTS}/work/.claude.json`]: claudeJson(
          "work@example.com",
          "uuid-work",
        ),
      },
      { [ACCOUNTS]: ["work"] },
    );
    const accounts = await discoverAccounts(io, {
      accountsDir: "~/.claude-accounts/",
      defaultAccountName: "default",
    });
    // No double slash: the keychain entry is keyed by this exact string.
    expect(accounts[1]?.configDir).toBe(`${ACCOUNTS}/work`);
    await expect(
      discoverAccounts(io, {
        accountsDir: "claude-accounts",
        defaultAccountName: "default",
      }),
    ).rejects.toThrow(/absolute/);
  });

  it("reads the account's kind from oauthAccount.organizationType (Max, Team, anything else unknown)", async () => {
    const withOrg = (organizationType?: string) =>
      JSON.stringify({
        oauthAccount: {
          accountUuid: `uuid-${organizationType ?? "none"}`,
          emailAddress: "x@example.com",
          ...(organizationType === undefined ? {} : { organizationType }),
        },
      });
    const io = fakeIo(
      {
        [`${HOME}/.claude.json`]: withOrg("claude_max"),
        [`${ACCOUNTS}/team1/.claude.json`]: withOrg("claude_team"),
        [`${ACCOUNTS}/odd/.claude.json`]: withOrg("claude_enterprise"),
        [`${ACCOUNTS}/bare/.claude.json`]: withOrg(),
        [`${ACCOUNTS}/broken/.claude.json`]: "{not json",
      },
      { [ACCOUNTS]: ["team1", "odd", "bare", "broken"] },
    );
    const accounts = await discoverAccounts(io, {
      accountsDir: ACCOUNTS,
      defaultAccountName: "aitor",
    });
    expect(accounts.map((a) => [a.name, a.kind])).toEqual([
      ["aitor", "max"],
      ["bare", "unknown"],
      ["broken", "unknown"],
      ["odd", "unknown"],
      ["team1", "team"],
    ]);
  });
});

describe("the plan behind a login (SPEC 2026-10-30 §1)", () => {
  it("reads organizationRateLimitTier and planDisplayName from oauthAccount", async () => {
    const io = fakeIo(
      {
        [`${HOME}/.claude.json`]: JSON.stringify({
          oauthAccount: {
            accountUuid: "uuid-main",
            emailAddress: "main@example.com",
            organizationType: "claude_max",
            organizationRateLimitTier: "default_claude_max_20x",
            planDisplayName: "Ultra",
          },
        }),
      },
      {},
    );
    const [main] = await discoverAccounts(io, {
      accountsDir: ACCOUNTS,
      defaultAccountName: "main",
    });
    expect(main).toMatchObject({
      kind: "max",
      tier: "default_claude_max_20x",
      planName: "Ultra",
    });
  });

  const usage = (name: string) =>
    parseUsage(
      JSON.parse(
        readFileSync(new URL(`./fixtures/ultra/${name}.json`, import.meta.url), "utf8"),
      ),
    );
  const max20x = { kind: "max", tier: "default_claude_max_20x" } as const;

  it("an Ultra account without the 5-hour window is Ultra, never Team, with or without a profile (canary 1)", () => {
    for (const login of [max20x, { kind: "unknown" } as const, { kind: "team" } as const])
      expect(planOf(login, usage("ultra-sin-5h"))).toEqual({
        plan: "ultra",
        label: "Ultra · sin tope de 5 h",
        short: "Ultra · sin tope de 5 h",
        fiveHour: false,
      });
  });

  it("a Team seat is Team, by its profile and without one (canary 2)", () => {
    const team = { plan: "team", label: "Team", short: "Team", fiveHour: true };
    expect(planOf({ kind: "team", tier: "default_raven" }, usage("team"))).toEqual(team);
    expect(planOf({ kind: "unknown" }, usage("team"))).toEqual(team);
  });

  it("a max_20x login still on the 5-hour window is Ultra until Anthropic verifies it (canary 3)", () => {
    for (const name of ["ultra-con-5h", "ultra-con-5h-b"])
      expect(planOf(max20x, usage(name))).toEqual({
        plan: "ultra",
        label: "Ultra · 5 h hasta que Anthropic la verifique",
        short: "Ultra · con 5 h",
        fiveHour: true,
      });
    expect(planOf({ kind: "max", planName: "Ultra" }, usage("ultra-con-5h")).plan).toBe("ultra");
  });

  it("a Max 5x is Max; a Max login without tier nor plan name is «Max o Ultra»; nothing is «sin datos de plan»", () => {
    expect(planOf({ kind: "max", tier: "default_claude_max_5x" }, usage("ultra-con-5h"))).toMatchObject({ plan: "max", label: "Max" });
    expect(planOf({ kind: "max", planName: "Max" }, null)).toMatchObject({ plan: "max", fiveHour: null });
    expect(planOf({ kind: "max" }, usage("ultra-con-5h"))).toMatchObject({ plan: "unknown", label: "Max o Ultra" });
    expect(planOf({ kind: "unknown" }, null)).toEqual({
      plan: "unknown",
      label: "sin datos de plan",
      short: "sin datos de plan",
      fiveHour: null,
    });
    expect(planOf(max20x, null)).toMatchObject({ plan: "ultra", label: "Ultra", fiveHour: null });
  });

  it("an incomplete answer says nothing of the 5-hour window (canary 5)", () => {
    const { five_hour: _, ...rest } = JSON.parse(
      readFileSync(new URL("./fixtures/ultra/ultra-sin-5h.json", import.meta.url), "utf8"),
    );
    const info = planOf({ kind: "unknown" }, parseUsage(rest));
    expect(info.plan).toBe("unknown");
    expect(info.fiveHour).toBeNull();
  });
});
