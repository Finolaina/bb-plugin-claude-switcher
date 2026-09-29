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
  const win = (usedPercent: number) => ({ usedPercent, resetsAt: null });
  const usage = (session: number, weekly: number, fable: number, blocked = false) => ({
    blocked,
    session: win(session),
    weekly: win(weekly),
    models: { Fable: win(fable) },
  });
  const account = (name: string, u: ReturnType<typeof usage> | null) => ({ name, usage: u });
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
    expect(headerStatus(base, "p-default")).toEqual({
      account: "main", tone: "out", best: "work", canSwitch: true,
    });
    expect(headerStatus(base, "p-work")).toEqual({
      account: "work", tone: "ok", best: "work", canSwitch: false,
    });
    expect(headerStatus(base, "p-busy")).toMatchObject({ account: "busy", tone: "tight" });
    expect(headerStatus(base, "p-fresh")).toMatchObject({ account: "fresh", tone: "unknown" });
  });

  it("offers no switch where the plugin may not act, and says when there is nothing better", () => {
    expect(headerStatus(base, "p-ext")).toEqual({
      account: null, tone: "unknown", best: "work", canSwitch: false,
    });
    expect(headerStatus(base, "p-gone")).toMatchObject({ account: null, canSwitch: true });
    expect(headerStatus({ ...base, bestAccount: null }, "p-default")).toMatchObject({
      canSwitch: false,
    });
    expect(headerStatus(base, "p-missing")).toBeNull();
  });
});
