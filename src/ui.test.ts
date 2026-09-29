import { describe, expect, it } from "vitest";
import { headerStatus, noLoginFound, projectLabel } from "./ui.js";

const ok = { problem: null };
const unauth = { problem: { kind: "unauthenticated" as const } };
const failed = { problem: { kind: "error" as const, message: "boom" } };

describe("noLoginFound", () => {
  it("is true only when every listed account lacks a login", () => {
    expect(noLoginFound([unauth])).toBe(true);
    expect(noLoginFound([unauth, unauth])).toBe(true);
    expect(noLoginFound([unauth, ok])).toBe(false);
    expect(noLoginFound([ok])).toBe(false);
    // A query that failed is still a login.
    expect(noLoginFound([unauth, failed])).toBe(false);
    // The default account is always listed, so this never happens; if it
    // did, there is nothing to log in to either.
    expect(noLoginFound([])).toBe(true);
  });
});

describe("projectLabel", () => {
  const projects = [{ id: "proj-1", name: "Website" }];
  it("names the project of the last switch, or says nothing when it is gone", () => {
    expect(projectLabel(projects, "proj-1")).toBe(" (Website)");
    expect(projectLabel(projects, "proj-9")).toBe("");
  });
});

describe("headerStatus", () => {
  const NOW = 1_000_000;
  const win = (usedPercent: number, resetsAt: number | null = null) => ({ usedPercent, resetsAt });
  const usage = (session: number, weekly: number, fable: number, blocked = false) => ({
    blocked,
    session: win(session),
    weekly: win(weekly),
    models: { Fable: win(fable) },
  });
  type Usage = Omit<ReturnType<typeof usage>, "models"> & {
    models: Record<string, ReturnType<typeof win>>;
    unknown?: boolean;
  };
  const account = (name: string, u: Usage | null) => ({ name, usage: u });
  const base = {
    defaultAccountName: "main",
    preferredModel: "Fable",
    bestAccount: "work" as string | null,
    accounts: [
      account("main", usage(10, 40, 100)),
      account("work", usage(5, 20, 30)),
      account("busy", usage(85, 20, 30)),
      account("fresh", null),
    ],
    projects: [
      { id: "p-default", account: null, owned: false, external: false },
      { id: "p-work", account: "work", owned: true, external: false },
      { id: "p-busy", account: "busy", owned: true, external: false },
      { id: "p-fresh", account: "fresh", owned: true, external: false },
      { id: "p-ext", account: null, owned: false, external: true },
      { id: "p-gone", account: null, owned: true, external: false },
    ],
  };

  it("names the project's account and how it stands for the preferred model", () => {
    expect(headerStatus(base, "p-default", NOW)).toEqual({
      account: "main", tone: "out", best: "work", canSwitch: true, external: false,
    });
    expect(headerStatus(base, "p-work", NOW)).toEqual({
      account: "work", tone: "ok", best: "work", canSwitch: false, external: false,
    });
    expect(headerStatus(base, "p-busy", NOW)).toMatchObject({ account: "busy", tone: "tight" });
    expect(headerStatus(base, "p-fresh", NOW)).toMatchObject({ account: "fresh", tone: "unknown" });
  });

  const only = (u: Usage, preferredModel = "Fable") => ({
    ...base,
    preferredModel,
    accounts: [account("main", u)],
  });
  const tone = (u: Usage, preferredModel?: string) =>
    headerStatus(only(u, preferredModel), "p-default", NOW)?.tone;

  it("turns amber at exactly 80 % and red at exactly 100 %", () => {
    expect(tone(usage(79, 0, 0))).toBe("ok");
    expect(tone(usage(80, 0, 0))).toBe("tight");
    expect(tone(usage(0, 99.9, 0))).toBe("tight");
    expect(tone(usage(0, 0, 100))).toBe("out");
  });

  it("reads the preferred model's window whatever its case", () => {
    expect(tone(usage(0, 0, 100), "fable")).toBe("out");
    expect(tone(usage(0, 0, 100), "Opus")).toBe("ok");
  });

  it("shows a lock as out, and a measurement with a missing window as not measured", () => {
    expect(tone(usage(0, 0, 0, true))).toBe("out");
    expect(tone({ ...usage(0, 100, 0, true), unknown: true })).toBe("unknown");
  });

  it("says so when the project's account has no login", () => {
    const loggedOut = {
      ...base,
      accounts: [{ name: "main", usage: null, problem: { kind: "unauthenticated" } }],
    };
    expect(headerStatus(loggedOut, "p-default", NOW)?.tone).toBe("nologin");
  });

  it("keeps showing the numbers the plugin acts on when the last query failed", () => {
    const failed = (u: Usage) => ({
      ...base,
      accounts: [{ name: "main", usage: u, problem: { kind: "error" } }],
    });
    expect(headerStatus(failed(usage(100, 10, 10)), "p-default", NOW)?.tone).toBe("out");
    expect(headerStatus(failed(usage(10, 10, 10)), "p-default", NOW)?.tone).toBe("ok");
  });

  it("offers no switch when an older server sends no best account", () => {
    const { bestAccount: _, ...older } = base;
    expect(headerStatus(older as typeof base, "p-default", NOW)).toMatchObject({
      best: null,
      canSwitch: false,
    });
  });

  it("ignores a model window with no name when no model is preferred, like the plugin", () => {
    const blank = { ...usage(10, 10, 0), models: { "": win(100) } };
    expect(tone(blank, "")).toBe("ok");
  });

  it("counts a window whose reset has passed as free, like the switch does", () => {
    const reset = {
      ...usage(0, 0, 0),
      session: win(100, NOW - 60_000),
      models: { Fable: win(100, NOW) },
    };
    expect(tone(reset)).toBe("ok");
    expect(tone({ ...reset, session: win(100, NOW + 60_000) })).toBe("out");
  });

  it("offers no switch where the plugin may not act, and says when there is nothing better", () => {
    expect(headerStatus(base, "p-ext", NOW)).toEqual({
      account: null, tone: "unknown", best: "work", canSwitch: false, external: true,
    });
    expect(headerStatus(base, "p-gone", NOW)).toMatchObject({
      account: null, canSwitch: true, external: false,
    });
    // Nothing measured yet: a project on a vanished account is still the plugin's to change.
    expect(headerStatus({ ...base, bestAccount: null }, "p-gone", NOW)).toMatchObject({
      account: null, canSwitch: false, external: false,
    });
    expect(headerStatus({ ...base, bestAccount: null }, "p-default", NOW)).toMatchObject({
      canSwitch: false,
    });
    expect(headerStatus(base, "p-missing", NOW)).toBeNull();
  });
});
