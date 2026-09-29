// Per-account OAuth credentials of Claude Code and the usage endpoint.
//
// Claude Code stores each CLAUDE_CONFIG_DIR's login in its own macOS keychain
// item: "Claude Code-credentials" for ~/.claude and
// "Claude Code-credentials-<sha256(NFC(dir))[:8]>" for any other directory
// (observed with Claude Code 2.1.x). Elsewhere it is a JSON file inside the
// config directory.
//
// The refresh token ROTATES on every refresh, so this module refreshes only a
// token that has already expired (an idle account), verifies the write by
// reading the item back, and keeps a rotated login it could not write in
// `pending` until it can: losing it would log the account out. A live
// `claude` session of the same account re-reads its store when it refreshes,
// so the remaining race is that it writes between our read and our write.
import { createHash } from "node:crypto";
import { z } from "zod";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Public OAuth client id of the Claude Code CLI (binary 2.1.278). */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_BETA = "oauth-2025-04-20";
export const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = ".credentials.json";
const USER_AGENT = "bb-plugin-claude-accounts/0.1 (claude-code multi-account)";
const TIMEOUT_MS = 20_000;

export interface CredentialIo {
  platform: NodeJS.Platform;
  username: string;
  /** Home directory; the default account's credentials file lives under it. */
  home: string;
  /** Runs /usr/bin/security with these arguments. */
  exec(args: string[]): Promise<{ code: number; stdout: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fetch: typeof fetch;
}

const credentialsSchema = z.looseObject({
  claudeAiOauth: z.looseObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().optional(),
    scopes: z.array(z.string()).optional(),
  }),
});
type Credentials = z.infer<typeof credentialsSchema>;

/** A refreshed login not yet written to the store, keyed by keychain service. */
export interface RotatedCredentials {
  credentials: Credentials;
  /** Refresh token the store still holds: the one consumed to obtain these. */
  basedOn: string;
}
export type PendingCredentials = Map<string, RotatedCredentials>;

export function keychainService(configDir: string | null): string {
  if (configDir === null) return KEYCHAIN_SERVICE;
  const hash = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

function credentialsPath(io: CredentialIo, configDir: string | null): string {
  return `${configDir ?? `${io.home}/.claude`}/${CREDENTIALS_FILE}`;
}

function parseCredentials(raw: string | null): Credentials | null {
  if (raw === null) return null;
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(raw.trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stored login as text, or null when there is none. Throws when the store cannot be read. */
async function readRaw(
  io: CredentialIo,
  configDir: string | null,
): Promise<string | null> {
  if (io.platform === "darwin") {
    const service = keychainService(configDir);
    const result = await io.exec([
      "find-generic-password",
      "-a",
      io.username,
      "-w",
      "-s",
      service,
    ]);
    if (result.code === 0) return result.stdout;
    // 44 = errSecItemNotFound: no login for this directory.
    if (result.code === 44) return null;
    throw new Error(`security exited ${result.code} reading "${service}"`);
  }
  try {
    return await io.readFile(credentialsPath(io, configDir));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

async function write(
  io: CredentialIo,
  configDir: string | null,
  credentials: Credentials,
): Promise<void> {
  const json = JSON.stringify(credentials);
  const service = keychainService(configDir);
  if (io.platform === "darwin") {
    // `-X <hex>` is how the CLI itself writes: `-w '<json>'` mangles backslashes.
    const result = await io.exec([
      "add-generic-password",
      "-U",
      "-a",
      io.username,
      "-s",
      service,
      "-X",
      Buffer.from(json, "utf8").toString("hex"),
    ]);
    if (result.code !== 0) {
      throw new Error(`security exited ${result.code} writing "${service}"`);
    }
  } else {
    await io.writeFile(credentialsPath(io, configDir), json);
  }
  const reread = parseCredentials(await readRaw(io, configDir));
  if (
    reread === null ||
    reread.claudeAiOauth.accessToken !==
      credentials.claudeAiOauth.accessToken ||
    reread.claudeAiOauth.refreshToken !== credentials.claudeAiOauth.refreshToken
  ) {
    throw new Error(
      `could not verify the refreshed credentials of "${service}"`,
    );
  }
}

const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});

/**
 * Rotated login, or null when the provider rejected the refresh token (the
 * login is gone: 400 invalid_grant or 401). Any other status throws, so a
 * transient outage or throttle is never mistaken for a logout.
 */
async function refresh(
  io: CredentialIo,
  credentials: Credentials,
  now: number,
): Promise<Credentials | null> {
  const oauth = credentials.claudeAiOauth;
  const response = await io.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: (oauth.scopes ?? []).join(" "),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 400 || response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}`);
  }
  const parsed = refreshResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new Error("token endpoint returned an unreadable body");
  }
  return {
    ...credentials,
    claudeAiOauth: {
      ...oauth,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? oauth.refreshToken,
      // No expires_in: keep the rotated tokens but treat the access token as
      // already expired, so the next call refreshes with the NEW refresh token.
      expiresAt:
        parsed.data.expires_in === undefined
          ? now
          : now + parsed.data.expires_in * 1_000,
    },
  };
}

/** Writes the pending login of `service`; returns the failure message when it could not. */
async function persist(
  io: CredentialIo,
  configDir: string | null,
  pending: PendingCredentials,
): Promise<string | null> {
  const service = keychainService(configDir);
  const held = pending.get(service);
  if (held === undefined) return null;
  try {
    await write(io, configDir, held.credentials);
    pending.delete(service);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface AccessToken {
  token: string;
  refreshed: boolean;
  /** Set when a rotated login is still only in memory: the reason the store rejected it. */
  unsaved: string | null;
}

/**
 * Valid access token of the account, refreshing only if it already expired.
 * Null = no login. `pending` carries rotated logins across calls (one map per
 * process); without it a refresh whose write failed would be lost.
 */
export async function accessToken(
  io: CredentialIo,
  configDir: string | null,
  now: number,
  pending: PendingCredentials = new Map(),
): Promise<AccessToken | null> {
  const service = keychainService(configDir);
  const stored = parseCredentials(await readRaw(io, configDir));
  // An unreadable store proves nothing about a held login: it stays for the
  // next call. Only a store holding a DIFFERENT login means someone else
  // rotated it since, and what we hold is dead.
  if (stored === null) return null;
  let credentials = stored;
  const held = pending.get(service);
  if (held !== undefined) {
    if (stored.claudeAiOauth.refreshToken === held.basedOn) {
      credentials = held.credentials;
    } else {
      pending.delete(service);
    }
  }
  if ((credentials.claudeAiOauth.expiresAt ?? 0) >= now) {
    const unsaved = await persist(io, configDir, pending);
    return {
      token: credentials.claudeAiOauth.accessToken,
      refreshed: credentials !== stored,
      unsaved,
    };
  }
  const refreshed = await refresh(io, credentials, now);
  if (refreshed === null) {
    pending.delete(service);
    return null;
  }
  pending.set(service, {
    credentials: refreshed,
    basedOn: stored.claudeAiOauth.refreshToken,
  });
  const unsaved = await persist(io, configDir, pending);
  return {
    token: refreshed.claudeAiOauth.accessToken,
    refreshed: true,
    unsaved,
  };
}

export type UsageFetch =
  | { status: "ok"; payload: unknown }
  | { status: "rate-limited" }
  | { status: "unauthenticated" }
  | { status: "error"; message: string };

export async function fetchUsage(
  io: CredentialIo,
  token: string,
): Promise<UsageFetch> {
  let response: Response;
  try {
    response = await io.fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 429) return { status: "rate-limited" };
  if (response.status === 401) return { status: "unauthenticated" };
  if (!response.ok) {
    return {
      status: "error",
      message: `usage endpoint returned ${response.status}`,
    };
  }
  const payload: unknown = await response.json().catch(() => null);
  return payload === null
    ? { status: "error", message: "usage endpoint returned no JSON" }
    : { status: "ok", payload };
}
