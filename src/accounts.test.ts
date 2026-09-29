import { describe, expect, it } from "vitest";
import { discoverAccounts, type AccountsIo } from "./accounts.js";

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
        [`${HOME}/.claude.json`]: claudeJson(
          "main@example.com",
          "uuid-main",
        ),
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
      },
      {
        name: "spare",
        configDir: `${ACCOUNTS}/spare`,
        email: "spare@example.com",
        accountUuid: "uuid-spare",
      },
      {
        name: "work",
        configDir: `${ACCOUNTS}/work`,
        email: "work@example.com",
        accountUuid: "uuid-work",
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
      { name: "default", configDir: null, email: null, accountUuid: null },
      {
        name: "fresh",
        configDir: `${ACCOUNTS}/fresh`,
        email: null,
        accountUuid: null,
      },
    ]);
  });

  it("expands ~ in the accounts dir and tolerates a missing dir", async () => {
    const io = fakeIo({}, {});
    const accounts = await discoverAccounts(io, {
      accountsDir: "~/.claude-accounts",
      defaultAccountName: "default",
    });
    expect(accounts).toEqual([
      { name: "default", configDir: null, email: null, accountUuid: null },
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
});
