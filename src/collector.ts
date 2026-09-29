// Per-account usage cache. One measurement per account; a failed query keeps
// the last good usage (with its old observedAt) so a rate-limited usage
// endpoint never turns into "no data" in the panel or in the switch policy.
//
// Single-flight per account: concurrent callers (the panel, a turn.failed
// handler, the background refresh) share one query, so an expired token is
// refreshed once. Two refreshes with the same refresh token would log the
// account out, because the token rotates.
import type { Account } from "./accounts.js";
import {
  accessToken,
  fetchUsage,
  keychainService,
  type CredentialIo,
  type PendingCredentials,
} from "./credentials.js";
import { canRunModel, isUsable, type AccountUsage } from "./policy.js";
import { settle } from "./switch.js";
import { parseUsage, type ParsedUsage } from "./usage.js";

export type Problem =
  null | { kind: "unauthenticated" } | { kind: "error"; message: string };

export interface Measurement {
  /** When `usage` was measured, or null if never. */
  observedAt: number | null;
  usage: ParsedUsage | null;
  /** Outcome of the LAST attempt; null when it succeeded. */
  problem: Problem;
}

export interface CollectorDeps {
  io: CredentialIo;
  now: () => number;
}

export class UsageCollector {
  private readonly cache = new Map<string, Measurement>();
  private readonly inflight = new Map<string, Promise<Measurement>>();
  private readonly pending: PendingCredentials = new Map();

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
    try {
      const token = await accessToken(
        this.deps.io,
        account.configDir,
        this.deps.now(),
        this.pending,
      );
      if (token === null) {
        measurement = {
          observedAt: null,
          usage: null,
          problem: { kind: "unauthenticated" },
        };
      } else {
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
                    },
            };
            break;
          case "unauthenticated":
            measurement = {
              observedAt: null,
              usage: null,
              problem: { kind: "unauthenticated" },
            };
            break;
          case "rate-limited":
            measurement = {
              ...stale,
              problem: {
                kind: "error",
                message: "usage endpoint rate-limited this query",
              },
            };
            break;
          case "error":
            measurement = {
              ...stale,
              problem: { kind: "error", message: result.message },
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
      };
    }
    this.cache.set(account.name, measurement);
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
