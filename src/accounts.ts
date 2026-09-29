// Discovery of Claude Code accounts on this machine.
//
// One account = one Claude Code config directory. The default one is
// ~/.claude (CLAUDE_CONFIG_DIR unset); every other one is a subdirectory of
// the configured accounts dir that contains a `.claude.json`, which is the
// file the CLI writes on first start and where it keeps `oauthAccount`.
import { z } from "zod";

export interface AccountsIo {
  home: string;
  readFile(path: string): Promise<string>;
  /** Names of the immediate subdirectories, or [] when the dir does not exist. */
  listDirs(path: string): Promise<string[]>;
}

export interface Account {
  name: string;
  /** null = the default directory (~/.claude), i.e. CLAUDE_CONFIG_DIR unset. */
  configDir: string | null;
  email: string | null;
  accountUuid: string | null;
}

export interface DiscoverOptions {
  accountsDir: string;
  defaultAccountName: string;
  /** Receives a message per directory skipped (a name that collides with the default account). */
  warn?: (message: string) => void;
}

const claudeJsonSchema = z.looseObject({
  oauthAccount: z
    .looseObject({
      accountUuid: z.string().optional(),
      emailAddress: z.string().optional(),
    })
    .optional(),
});

type Login = Pick<Account, "email" | "accountUuid">;

export function expandHome(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
}

/** Without trailing slashes: the keychain entry of an account is keyed by the exact config dir string. */
function normalizeDir(path: string): string {
  let dir = path;
  while (dir.length > 1 && dir.endsWith("/")) dir = dir.slice(0, -1);
  return dir;
}

/** Login found in the given `.claude.json`; null when the file is missing (not a Claude Code dir). */
async function login(io: AccountsIo, file: string): Promise<Login | null> {
  let raw: string;
  try {
    raw = await io.readFile(file);
  } catch {
    return null;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // An unreadable file still marks the dir as an account, just without login.
  }
  const parsed = claudeJsonSchema.safeParse(json);
  const oauth = parsed.success ? parsed.data.oauthAccount : undefined;
  return {
    email: oauth?.emailAddress ?? null,
    accountUuid: oauth?.accountUuid ?? null,
  };
}

/**
 * Default account first, then the accounts dir's subdirs with a `.claude.json`, sorted by name.
 * Without CLAUDE_CONFIG_DIR the CLI keeps its `.claude.json` at `~/.claude.json` (next to
 * `~/.claude`, not inside it); with it, at `<dir>/.claude.json`.
 */
export async function discoverAccounts(
  io: AccountsIo,
  options: DiscoverOptions,
): Promise<Account[]> {
  const accountsDir = normalizeDir(
    expandHome(options.accountsDir.trim(), io.home),
  );
  if (!accountsDir.startsWith("/")) {
    throw new Error(
      `accountsDir "${options.accountsDir}" must be an absolute path (or start with ~/)`,
    );
  }
  const none: Login = { email: null, accountUuid: null };
  const accounts: Account[] = [
    {
      name: options.defaultAccountName,
      configDir: null,
      ...((await login(io, `${io.home}/.claude.json`)) ?? none),
    },
  ];
  for (const name of (await io.listDirs(accountsDir)).sort()) {
    const dir = `${accountsDir}/${name}`;
    const found = await login(io, `${dir}/.claude.json`);
    if (found === null) continue;
    if (name === options.defaultAccountName) {
      options.warn?.(
        `account dir "${name}" collides with the default account name; rename one of them (skipped)`,
      );
      continue;
    }
    accounts.push({ name, configDir: dir, ...found });
  }
  return accounts;
}
