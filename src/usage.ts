// Parser for GET https://api.anthropic.com/api/oauth/usage. Strict on
// purpose: a malformed number must not silently become "0 % used".
import { z } from "zod";
import type { AccountUsage, UsageWindow } from "./policy.js";

const percentSchema = z
  .number()
  .refine((n) => Number.isFinite(n) && n >= 0 && n <= 100, {
    message: "percent must be a number between 0 and 100",
  });

const resetSchema = z
  .string()
  .nullable()
  .refine((s) => s === null || /(?:Z|[+-]\d{2}:\d{2})$/u.test(s), {
    message: "resets_at must carry a timezone",
  });

const limitSchema = z.object({
  kind: z.enum(["session", "weekly_all", "weekly_scoped"]).or(z.string()),
  percent: percentSchema,
  resets_at: resetSchema.optional().default(null),
  scope: z
    .object({
      model: z.object({ display_name: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const bucketSchema = z
  .object({ locked_reason: z.string().nullable().optional() })
  .nullable()
  .optional();

const usagePayloadSchema = z.object({
  limits: z.array(limitSchema),
  five_hour: bucketSchema,
  seven_day: bucketSchema,
});

export type ParsedUsage = Omit<AccountUsage, "name">;

function toWindow(limit: z.infer<typeof limitSchema>): UsageWindow {
  const resetsAt =
    limit.resets_at === null ? null : Date.parse(limit.resets_at);
  if (resetsAt !== null && Number.isNaN(resetsAt)) {
    throw new Error(`resets_at is not a date: ${limit.resets_at}`);
  }
  return { usedPercent: limit.percent, resetsAt };
}

/** A window we know nothing about: treated as exhausted so it is never chosen. */
const UNKNOWN: UsageWindow = { usedPercent: 100, resetsAt: null };

export function parseUsage(payload: unknown): ParsedUsage {
  const parsed = usagePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `usage payload: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  let session: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;
  const models: Record<string, UsageWindow> = {};
  for (const limit of parsed.data.limits) {
    if (limit.kind === "session") session = toWindow(limit);
    else if (limit.kind === "weekly_all") weekly = toWindow(limit);
    else if (limit.kind === "weekly_scoped") {
      const model = limit.scope?.model?.display_name;
      if (model === undefined) continue;
      // The same model listed twice (or as "fable" and "Fable"): keep the
      // fullest window under the first name seen, never the emptier one.
      const key =
        Object.keys(models).find(
          (k) => k.toLowerCase() === model.toLowerCase(),
        ) ?? model;
      const window = toWindow(limit);
      const known = models[key];
      if (known === undefined || window.usedPercent > known.usedPercent)
        models[key] = window;
    }
  }
  const locked =
    (parsed.data.five_hour?.locked_reason ?? null) !== null ||
    (parsed.data.seven_day?.locked_reason ?? null) !== null;
  return {
    blocked: locked || session === null || weekly === null,
    // A reported lock is proof on its own; a missing window alone is not.
    ...(!locked && (session === null || weekly === null)
      ? { unknown: true as const }
      : {}),
    session: session ?? UNKNOWN,
    weekly: weekly ?? UNKNOWN,
    models,
  };
}
