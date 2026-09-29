// Shapes this plugin's accounts and measurements the way bb's provider-usage
// panel expects them (usage-source-contract.ts).
import type { Account } from "./accounts.js";
import type { Measurement } from "./collector.js";
import type { UsageWindow } from "./policy.js";
import type { z } from "zod";
import {
  type UsageMeasurement,
  type usageResourceSchema,
} from "./usage-source-contract.js";

type PanelWindow = Extract<
  UsageMeasurement["usage"],
  { status: "ok" }
>["windows"][number];
type PanelResource = z.infer<typeof usageResourceSchema>;

export function accountKey(account: Account): string | null {
  return account.accountUuid === null
    ? null
    : `anthropic:account:${account.accountUuid}`;
}

export function toResource(account: Account): PanelResource {
  return {
    id: account.name,
    accountKey: accountKey(account),
    providerId: "claude-code",
    label:
      account.email === null
        ? account.name
        : `${account.name} · ${account.email}`,
    scope: { kind: "shared" },
  };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function window(
  kind: PanelWindow["kind"],
  id: string,
  label: string,
  w: UsageWindow,
  model: string | null,
): PanelWindow {
  return {
    kind,
    id,
    label,
    usedPercent: w.usedPercent,
    resetsAt: iso(w.resetsAt),
    model,
    cost: null,
  };
}

export function toMeasurement(
  account: Account,
  measurement: Measurement | undefined,
): UsageMeasurement {
  // The panel heads each card with the email and shows planLabel as a small
  // badge; the account name goes there so two cards are never ambiguous.
  const fields = {
    plan: null,
    accountEmail: account.email,
    planLabel: account.name,
  };
  const key = accountKey(account);
  if (measurement?.usage) {
    const { session, weekly, models } = measurement.usage;
    const windows: PanelWindow[] = [
      window("five-hour", "session", "Current session", session, null),
      window("weekly", "weekly", "Weekly limit", weekly, null),
      ...Object.entries(models).map(([model, w]) =>
        window("weekly", `weekly:${model}`, `Weekly · ${model}`, w, model),
      ),
    ];
    return {
      accountKey: key,
      observedAt: measurement.observedAt,
      usage: { status: "ok", ...fields, windows },
    };
  }
  if (measurement?.problem?.kind === "unauthenticated") {
    return {
      accountKey: key,
      observedAt: null,
      usage: { status: "unauthenticated", ...fields },
    };
  }
  return {
    accountKey: key,
    observedAt: measurement?.observedAt ?? null,
    usage: {
      status: "error",
      ...fields,
      message:
        measurement?.problem?.kind === "error"
          ? measurement.problem.message
          : "Usage has not been observed for this account yet.",
    },
  };
}
