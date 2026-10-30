// Discovery of Claude Code accounts on this machine.
//
// One account = one Claude Code config directory. The default one is
// ~/.claude (CLAUDE_CONFIG_DIR unset); every other one is a subdirectory of
// the configured accounts dir that contains a `.claude.json`, which is the
// file the CLI writes on first start and where it keeps `oauthAccount`.
import { z } from "zod";
import type { AccountUsage } from "./policy.js";

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
  /**
   * The subscription behind the login (`oauthAccount.organizationType`):
   * `claude_max` is max, `claude_team` is team, anything else or nothing is
   * unknown. Unset where an account is made up rather than discovered.
   */
  kind?: AccountKind;
  /** `oauthAccount.organizationRateLimitTier` ("default_claude_max_20x"...), when the login has one. */
  tier?: string;
  /** `oauthAccount.planDisplayName` ("Ultra", "Max"...), when the login has one. */
  planName?: string;
}

export type AccountKind = "max" | "team" | "unknown";

/** The subscription as the plan names it (SPEC 2026-10-30 §1); `kind` stays what organizationType says. */
export type Plan = "ultra" | "max" | "team" | "unknown";

export interface PlanInfo {
  plan: Plan;
  /** The same text on every screen: «Ultra · sin tope de 5 h», «Team»... */
  label: string;
  /** The label where room is short (the CLI's list). */
  short: string;
  /** Whether the account has the 5-hour window; null while its usage says nothing (unmeasured, incomplete). */
  fiveHour: boolean | null;
}

/**
 * The plan behind a login, from its profile and its latest usage
 * (Optimizador informes/2026-10-30/ultra/SPEC.md §1). Anthropic renamed Max
 * 20x to Ultra and frees it of the 5-hour window account by account
 * (2026-10-30): an account without a session is Ultra (only Ultra loses
 * it) and never a Team seat. A Team seat is Team by its profile, or without
 * one by its windows (a session and no general weekly at all).
 */
export function planOf(
  login: Pick<Account, "kind" | "tier" | "planName">,
  usage: Pick<AccountUsage, "session" | "weekly" | "unknown"> | null,
): PlanInfo {
  const fiveHour =
    usage === null || usage.unknown === true
      ? null
      : usage.session.absent !== true;
  const info = (plan: Plan, label: string, short = label): PlanInfo => ({
    plan,
    label,
    short,
    fiveHour,
  });
  const tier = login.tier ?? "";
  const ultra =
    fiveHour === false ||
    login.planName === "Ultra" ||
    tier.includes("max_20x");
  if (fiveHour !== false) {
    if (login.kind === "team") return info("team", "Team");
    if (
      login.kind !== "max" &&
      fiveHour === true &&
      usage?.weekly.absent === true
    )
      return info("team", "Team");
  }
  if (ultra)
    return fiveHour === false
      ? info("ultra", "Ultra · sin tope de 5 h")
      : fiveHour === true
        ? info("ultra", "Ultra · 5 h hasta que Anthropic la verifique", "Ultra · con 5 h")
        : info("ultra", "Ultra");
  if (login.planName === "Max" || tier.includes("max_5x"))
    return info("max", "Max");
  return info("unknown", login.kind === "max" ? "Max o Ultra" : "sin datos de plan");
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
      organizationType: z.string().optional(),
      organizationRateLimitTier: z.string().optional(),
      planDisplayName: z.string().optional(),
    })
    .optional(),
});

type Login = Pick<Account, "email" | "accountUuid" | "kind" | "tier" | "planName">;

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
    // Empty is none: two directories without an id are not one account.
    accountUuid: oauth?.accountUuid || null,
    kind:
      oauth?.organizationType === "claude_max"
        ? "max"
        : oauth?.organizationType === "claude_team"
          ? "team"
          : "unknown",
    // Only when the login says: an account made up or without them has none.
    ...(oauth?.organizationRateLimitTier ? { tier: oauth.organizationRateLimitTier } : {}),
    ...(oauth?.planDisplayName ? { planName: oauth.planDisplayName } : {}),
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
  const none: Login = { email: null, accountUuid: null, kind: "unknown" };
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
