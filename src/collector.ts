// Per-account usage cache. One measurement per account; a failed query keeps
// the last good usage (with its old observedAt) so a rate-limited usage
// endpoint never turns into "no data" in the panel or in the switch policy.
//
// Single-flight per account: concurrent callers (the panel, a turn.failed
// handler, the background refresh) share one query, so an expired token is
// refreshed once. Two refreshes with the same refresh token would log the
// account out, because the token rotates.
import { createHash } from "node:crypto";
import type { Account } from "./accounts.js";
import {
  accessToken,
  fetchUsage,
  keychainService,
  type CredentialIo,
  type PendingCredentials,
  type TokenNotes,
} from "./credentials.js";
import { canRunModel, isUsable, type AccountUsage } from "./policy.js";
import { settle } from "./switch.js";
import { parseUsage, type ParsedUsage } from "./usage.js";

export type Problem =
  | null
  | { kind: "unauthenticated" }
  | {
      kind: "error";
      message: string;
      /**
       * The usage itself was measured on this attempt: only the refreshed
       * login could not be written back. Unset: the query failed and the
       * usage is the last good one, old.
       */
      fresh?: true;
    };

/**
 * What the LAST attempt showed of the login: "yes" once a token was read
 * (or refreshed) and the usage endpoint did not refuse it, also when the
 * query then failed (429, 5xx, an unreadable answer); "no" with no login in
 * the store, or the token refused; "unknown" when the check itself failed
 * (the store could not be read, the refresh failed): nothing is inferred
 * from the mere existence of a measurement (Astra E44-R3-01).
 */
export type LoginState = "yes" | "no" | "unknown";

export interface Measurement {
  /** When `usage` was measured, or null if never. */
  observedAt: number | null;
  usage: ParsedUsage | null;
  /** Outcome of the LAST attempt; null when it succeeded. */
  problem: Problem;
  login: LoginState;
}

/**
 * The measurement's usage was read on its own attempt (Codex ULTRA-R2-002):
 * succeeded, or measured with only a warning (the refreshed login not
 * written back). A failed query that reuses the last good usage is not one.
 */
export function freshReading(
  m: Measurement,
): m is Measurement & { observedAt: number; usage: ParsedUsage } {
  if (m.observedAt === null || m.usage === null) return false;
  return m.problem?.kind !== "error" || m.problem.fresh === true;
}

export interface CollectorDeps {
  io: CredentialIo;
  now: () => number;
  /** Hears each measurement as it lands, account by account. */
  onMeasured?: (name: string, measurement: Measurement) => void;
  /** Why an account was left without a login: once per account and cause. */
  warn?: (message: string) => void;
}

/** Enough of a token to tell two apart in the log, never the token. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

export class UsageCollector {
  private readonly cache = new Map<string, Measurement>();
  private readonly inflight = new Map<string, Promise<Measurement>>();
  private readonly pending: PendingCredentials = new Map();
  /** The cause last warned of per account, until it has a login again. */
  private readonly warned = new Map<string, string>();

  constructor(private readonly deps: CollectorDeps) {}

  get(name: string): Measurement | undefined {
    return this.cache.get(name);
  }

  collect(account: Account): Promise<Measurement> {
    const running = this.inflight.get(account.name);
    if (running !== undefined) return running;
    const measurement = this.measure(account).finally(() => {
      this.inflight.delete(account.name);
    });
    this.inflight.set(account.name, measurement);
    return measurement;
  }

  private async measure(account: Account): Promise<Measurement> {
    const previous = this.cache.get(account.name);
    const stale = {
      observedAt: previous?.observedAt ?? null,
      usage: previous?.usage ?? null,
    };
    let measurement: Measurement;
    let login: LoginState = "unknown";
    // Why this attempt found no login: a cause kind (once per change), and the line.
    let why: { cause: string; line: string } | null = null;
    try {
      const notes: TokenNotes = {};
      const now = this.deps.now();
      const token = await accessToken(
        this.deps.io,
        account.configDir,
        now,
        this.pending,
        notes,
      );
      if (token === null) {
        const line = notes.noLogin ?? "no login";
        why = { cause: line, line };
        measurement = {
          observedAt: null,
          usage: null,
          problem: { kind: "unauthenticated" },
          login: "no",
        };
      } else {
        login = "yes";
        const result = await fetchUsage(this.deps.io, token.token);
        switch (result.status) {
          case "ok":
            measurement = {
              observedAt: this.deps.now(),
              usage: parseUsage(result.payload),
              problem:
                token.unsaved === null
                  ? null
                  : {
                      kind: "error",
                      message: `refreshed login not written back yet: ${token.unsaved}`,
                      fresh: true,
                    },
              login,
            };
            break;
          case "unauthenticated": {
            const expiresAt = notes.expiresAt ?? null;
            why = {
              cause: "401",
              line: `usage endpoint answered 401 (token …${fingerprint(token.token)}, expires in ${expiresAt === null ? "?" : Math.round((expiresAt - now) / 60_000)} min, refreshed: ${token.refreshed ? "yes" : "no"}): ${result.body}`,
            };
            measurement = {
              observedAt: null,
              usage: null,
              problem: { kind: "unauthenticated" },
              login: "no",
            };
            break;
          }
          case "rate-limited":
            measurement = {
              ...stale,
              problem: {
                kind: "error",
                message: "usage endpoint rate-limited this query",
              },
              login,
            };
            break;
          case "error":
            measurement = {
              ...stale,
              problem: { kind: "error", message: result.message },
              login,
            };
            break;
        }
      }
    } catch (error) {
      measurement = {
        ...stale,
        problem: {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        },
        login,
      };
    }
    // Aitor 2026-10-30, Añadido 2: «mariscal not logged in» while
    // `claude auth status` said logged in, and nothing in the log said why.
    if (why === null) {
      if (measurement.login === "yes") this.warned.delete(account.name);
    } else if (this.warned.get(account.name) !== why.cause) {
      this.warned.set(account.name, why.cause);
      this.deps.warn?.(`account ${account.name}: not logged in: ${why.line}`);
    }
    this.cache.set(account.name, measurement);
    this.deps.onMeasured?.(account.name, measurement);
    return measurement;
  }

  /** Sequential on purpose: the usage endpoint rate-limits bursts (a concurrent pass joins the in-flight queries). */
  async collectAll(accounts: Account[]): Promise<void> {
    for (const account of accounts) await this.collect(account);
  }

  /** Forget accounts that no longer exist (measurement and pending login), so they are never chosen or shown. */
  prune(keep: Account[]): void {
    const names = keep.map((a) => a.name);
    for (const name of this.cache.keys()) {
      if (!names.includes(name)) this.cache.delete(name);
    }
    const services = keep.map((a) => keychainService(a.configDir));
    for (const service of this.pending.keys()) {
      if (!services.includes(service)) this.pending.delete(service);
    }
  }

  /**
   * Accounts the policy may choose. A last good usage survives a failed
   * query (429, endpoint down) so a blip does not blind the policy. One
   * exception: when that query keeps failing past `maxAgeMs`, an account
   * that only the clock would free (measured blocked, as a whole or for
   * the preferred model, with that reset now passed) is unknown and left
   * out. A block whose reset is still ahead stays: waiting for it is
   * known, not guessed. A stale FREE measurement stays too: a reset
   * cannot have made it worse, and a wrong switch costs one attempt where
   * a wrong wait costs hours.
   */
  usable(
    maxAgeMs = Number.POSITIVE_INFINITY,
    preferredModel = "",
  ): AccountUsage[] {
    const out: AccountUsage[] = [];
    const now = this.deps.now();
    for (const [name, measurement] of this.cache) {
      if (measurement.usage === null) continue;
      const usage = { name, ...measurement.usage };
      const runnable = (u: AccountUsage) =>
        isUsable(u) && canRunModel(u, preferredModel);
      if (
        measurement.problem?.kind === "error" &&
        measurement.observedAt !== null &&
        now - measurement.observedAt > maxAgeMs &&
        !runnable(usage) &&
        runnable(settle(usage, now))
      )
        continue;
      out.push(usage);
    }
    return out;
  }
}
