import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askForProject,
  newestFirst,
  composerProject,
  composerReader,
  picksOnSelect,
  forecastLine,
  headerStatus,
  noLoginFound,
  projectName,
  retryDelayMs,
  sharedWith,
  windowForecast,
} from "./ui.js";

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

describe("sharedWith", () => {
  const main = { name: "main", accountUuid: "u-1" };
  const team = { name: "team", accountUuid: "u-1" };
  const work = { name: "work", accountUuid: "u-2" };
  const bare = { name: "bare", accountUuid: null };
  const other = { name: "other", accountUuid: null };
  it("names another account with the same Claude account", () => {
    expect(sharedWith(team, [main, team, work])).toBe("main");
    expect(sharedWith(main, [main, team, work])).toBe("team");
    expect(sharedWith(work, [main, team, work])).toBeNull();
  });
  it("takes accounts without a known Claude account as different ones", () => {
    expect(sharedWith(bare, [bare, other, main])).toBeNull();
  });
});

describe("projectName", () => {
  const projects = [{ id: "proj-1", name: "Website" }];
  it("names the project of a move, or says it is gone", () => {
    expect(projectName(projects, "proj-1")).toBe("Website");
    expect(projectName(projects, "proj-9")).toBe("a project that is gone");
  });
});

describe("headerStatus", () => {
  const NOW = 1_000_000;
  const win = (usedPercent: number, resetsAt: number | null = null) => ({
    usedPercent,
    resetsAt,
  });
  const usage = (
    session: number,
    weekly: number,
    fable: number,
    blocked = false,
  ) => ({
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
      account: "main",
      tone: "out",
      best: "work",
      canSwitch: true,
      external: false,
    });
    expect(headerStatus(base, "p-work", NOW)).toEqual({
      account: "work",
      tone: "ok",
      best: "work",
      canSwitch: false,
      external: false,
    });
    expect(headerStatus(base, "p-busy", NOW)).toMatchObject({
      account: "busy",
      tone: "tight",
    });
    expect(headerStatus(base, "p-fresh", NOW)).toMatchObject({
      account: "fresh",
      tone: "unknown",
    });
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
      accounts: [
        { name: "main", usage: null, problem: { kind: "unauthenticated" } },
      ],
    };
    expect(headerStatus(loggedOut, "p-default", NOW)?.tone).toBe("nologin");
  });

  it("keeps showing the numbers the plugin acts on when the last query failed", () => {
    const failed = (u: Usage) => ({
      ...base,
      accounts: [{ name: "main", usage: u, problem: { kind: "error" } }],
    });
    expect(
      headerStatus(failed(usage(100, 10, 10)), "p-default", NOW)?.tone,
    ).toBe("out");
    expect(
      headerStatus(failed(usage(10, 10, 10)), "p-default", NOW)?.tone,
    ).toBe("ok");
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
      account: null,
      tone: "unknown",
      best: "work",
      canSwitch: false,
      external: true,
    });
    expect(headerStatus(base, "p-gone", NOW)).toMatchObject({
      account: null,
      canSwitch: true,
      external: false,
    });
    // Nothing measured yet: a project on a vanished account is still the plugin's to change.
    expect(
      headerStatus({ ...base, bestAccount: null }, "p-gone", NOW),
    ).toMatchObject({
      account: null,
      canSwitch: false,
      external: false,
    });
    expect(
      headerStatus({ ...base, bestAccount: null }, "p-default", NOW),
    ).toMatchObject({
      canSwitch: false,
    });
    expect(headerStatus(base, "p-missing", NOW)).toBeNull();
  });
});

describe("forecastLine", () => {
  const NOW = Date.parse("2026-09-30T10:00:00.000Z");
  const DAY = 24 * 3_600_000;

  it("says when the window runs out, in a day count or a date, with the pace", () => {
    expect(
      forecastLine(
        { kind: "runs-out", at: NOW + 3 * 3_600_000, percentPerDay: 30 },
        NOW,
      ),
    ).toBe(`runs out in 3 h at this pace (30 %/day)`);
    expect(
      forecastLine(
        {
          kind: "runs-out",
          at: NOW + 2 * DAY + 5 * 3_600_000,
          percentPerDay: 12.5,
        },
        NOW,
      ),
    ).toBe(`runs out in 2 d 5 h at this pace (12.5 %/day)`);
    expect(
      forecastLine({ kind: "runs-out", at: NOW - 1, percentPerDay: 99 }, NOW),
    ).toBe(`runs out now at this pace (99 %/day)`);
    // Under half a minute is now, not "in 0 min".
    expect(
      forecastLine(
        { kind: "runs-out", at: NOW + 29_000, percentPerDay: 99 },
        NOW,
      ),
    ).toBe(`runs out now at this pace (99 %/day)`);
    expect(
      forecastLine(
        { kind: "runs-out", at: NOW + 31_000, percentPerDay: 99 },
        NOW,
      ),
    ).toBe(`runs out in 1 min at this pace (99 %/day)`);
  });

  it("says the window lasts until its reset, and nothing for a steady or unknown one", () => {
    expect(
      forecastLine({ kind: "lasts", until: NOW + DAY, percentPerDay: 4 }, NOW),
    ).toBe("lasts until the reset at this pace (4 %/day)");
    expect(forecastLine({ kind: "steady" }, NOW)).toBeNull();
    expect(forecastLine({ kind: "unknown" }, NOW)).toBeNull();
  });
});

describe("windowForecast", () => {
  const runsOut = { kind: "runs-out" as const, at: 1, percentPerDay: 1 };
  const lasts = { kind: "lasts" as const, until: 1, percentPerDay: 1 };
  const forecasts = { main: { weekly: lasts, Fable: runsOut } };

  it("takes the preferred model's window when the account has one, else the weekly one", () => {
    expect(windowForecast(forecasts, "main", "Fable")).toEqual([
      "Fable",
      runsOut,
    ]);
    expect(windowForecast(forecasts, "main", "fable")).toEqual([
      "Fable",
      runsOut,
    ]);
    expect(windowForecast(forecasts, "main", "Opus")).toEqual([
      "weekly",
      lasts,
    ]);
    expect(windowForecast(forecasts, "main", "")).toEqual(["weekly", lasts]);
    expect(windowForecast(forecasts, "gone", "Fable")).toBeNull();
    expect(windowForecast(undefined, "main", "Fable")).toBeNull();
  });
});

describe("retryDelayMs", () => {
  it("retries a read the screen needs soon, then backs off to once a minute", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs)).toEqual([
      2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe("composerProject", () => {
  const newThread = (projectId: string | null) =>
    ({ kind: "new-thread", projectId }) as const;

  it("is the project picked in the new-thread composer", () => {
    expect(composerProject(newThread("proj_a"), undefined)).toBe("proj_a");
  });

  it("is null until the composer has resolved its project", () => {
    expect(composerProject(newThread(null), undefined)).toBeNull();
  });

  it("is null in any composer that is not the new-thread one", () => {
    expect(composerProject({ kind: "thread", threadId: "thr_a" }, undefined)).toBeNull();
    // A side chat names its project too, and is still not a new thread.
    expect(
      composerProject(
        { kind: "side-chat", projectId: "proj_a", parentThreadId: "thr_a", tabId: "tab_a", childThreadId: null },
        undefined,
      ),
    ).toBeNull();
  });

  // bb 0.45 hosts expose the composer's pickers; 0.44 hosts do not.
  it("is null when the composer says the new thread is not a Claude Code one", () => {
    expect(
      composerProject(newThread("proj_a"), { providerId: "codex" }),
    ).toBeNull();
  });

  it("stays when the composer has picked Claude Code, has no provider yet, or no pickers", () => {
    expect(
      composerProject(newThread("proj_a"), { providerId: "claude-code" }),
    ).toBe("proj_a");
    expect(composerProject(newThread("proj_a"), {})).toBe("proj_a");
    expect(composerProject(newThread("proj_a"), null)).toBe("proj_a");
  });
});

describe("composerReader", () => {
  const scope = { kind: "new-thread", projectId: "proj_a" } as const;
  const composer = { scope: { kind: "new-thread", projectId: "proj_stale" } as const, layout: "expanded" };

  // bb 0.44: useComposer()'s scope can stay unresolved; the view is the live one.
  it("reads the scope and the layout from the view hook when the host has it", () => {
    const read = composerReader(() => ({ scope, layout: "compact" }));
    expect(read(composer)).toEqual({ scope, compact: true });
  });

  // bb 0.45 dropped useComposerView and made useComposer() itself live.
  it("reads them from the composer when the host has no view hook", () => {
    const read = composerReader(undefined);
    expect(read(composer)).toEqual({ scope: composer.scope, compact: false });
    expect(read({ ...composer, layout: "compact" })).toEqual({ scope: composer.scope, compact: true });
  });
});

describe("picksOnSelect", () => {
  it("in a thread's header, a click on the project's own account does nothing", () => {
    expect(picksOnSelect("main", "main", false)).toBe(false);
    expect(picksOnSelect("work", "main", false)).toBe(true);
  });

  // A new project left unpicked moves to the best account after its first
  // turn; picking the shown account in the composer keeps it there.
  it("in the new-thread composer, a click on the shown account picks it too", () => {
    expect(picksOnSelect("main", "main", true)).toBe(true);
    expect(picksOnSelect("work", "main", true)).toBe(true);
  });
});

describe("askForProject", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once, and nothing more when the read worked", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true);
    const failed = vi.fn();
    askForProject(read, 0, failed);
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("after a failed read, calls for another once the back-off for that many failures has passed", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    askForProject(async () => false, 1, failed);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("takes a read that throws for a failed one", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    askForProject(() => Promise.reject(new Error("HTTP 503")), 0, failed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("calls for nothing once its view is gone, before or after the read fails", async () => {
    vi.useFakeTimers();
    let fail = (_: boolean) => {};
    const failed = vi.fn();
    const stop = askForProject(
      () => new Promise<boolean>((resolve) => (fail = resolve)),
      0,
      failed,
    );
    stop();
    fail(false);
    await vi.runAllTimersAsync();
    const later = askForProject(async () => false, 0, failed);
    await vi.advanceTimersByTimeAsync(1_000);
    later();
    await vi.runAllTimersAsync();
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("newestFirst", () => {
  it("shows the answer to the newest request, whatever order the answers come in", () => {
    const answers = newestFirst<string>();
    const older = answers.start();
    const newer = answers.start();
    expect(answers.accept(newer, "B")).toBe("B");
    // The older request answers last, with what was there when it started.
    expect(answers.accept(older, "A")).toBe("B");
    const latest = answers.start();
    expect(answers.accept(latest, "C")).toBe("C");
  });

  it("takes an answer when nothing newer has answered yet", () => {
    const answers = newestFirst<string>();
    const first = answers.start();
    const second = answers.start();
    expect(answers.accept(first, "A")).toBe("A");
    expect(answers.accept(second, "B")).toBe("B");
  });
});
