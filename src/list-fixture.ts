// Ten accounts as `bb claude-switcher list` sees them: the fixture of the
// list's tests (src/ui.test.ts) and of docs/lista-antes-despues.txt. Five
// Team seats (no general weekly: `absent`), five Max accounts, one Team
// seat out of session and one Max out of its weekly.
const HOUR = 3_600_000;

type Window = { usedPercent: number; resetsAt: number | null; absent?: true };

export function tenAccounts(now: number) {
  const session = (usedPercent: number) => ({
    usedPercent,
    resetsAt: now + 2 * HOUR,
  });
  const weekly = (usedPercent: number): Window => ({
    usedPercent,
    resetsAt: now + 3 * 24 * HOUR,
  });
  const team: Window = { usedPercent: 0, resetsAt: null, absent: true };
  const fable = (usedPercent: number) => ({
    Fable: { usedPercent, resetsAt: now + 4 * HOUR },
  });
  const account = (
    name: string,
    usage: {
      session: Window;
      weekly: Window;
      models: Record<string, Window>;
      blocked?: boolean;
    } | null,
    problem:
      | { kind: "unauthenticated" }
      | { kind: "error"; message: string }
      | null = null,
  ) => ({
    name,
    email: `${name}@example.com`,
    accountUuid: `uuid-${name}`,
    configDir:
      name === "viaulab" ? null : `/home/aitor/.claude-cuentas/${name}`,
    observedAt: usage === null ? null : now - 60_000,
    problem,
    usage: usage === null ? null : { blocked: false, ...usage },
  });
  return {
    accounts: [
      account("viaulab", {
        session: session(10),
        weekly: weekly(40),
        models: fable(20),
      }),
      account("max2", {
        session: session(55),
        weekly: weekly(71),
        models: fable(64),
      }),
      account("max3", { session: session(3), weekly: weekly(12), models: {} }),
      account("max4", {
        session: session(20),
        weekly: weekly(100),
        models: fable(88),
      }),
      account("maxprivada", {
        session: session(0),
        weekly: weekly(5),
        models: fable(1),
      }),
      account("team1", {
        session: session(30),
        weekly: team,
        models: fable(50),
      }),
      account("team2", { session: session(5), weekly: team, models: fable(9) }),
      account("team3", {
        session: session(100),
        weekly: team,
        models: fable(70),
      }),
      account("team4", null, { kind: "unauthenticated" }),
      account("team5", {
        session: session(45),
        weekly: team,
        models: fable(99.6),
      }),
    ],
    projects: [
      {
        id: "p1",
        name: "Infra",
        account: "team3",
        owned: true,
        external: false,
      },
      {
        id: "p2",
        name: "Website",
        account: null,
        owned: false,
        external: false,
      },
      {
        id: "p3",
        name: "Bots",
        account: "team3",
        owned: true,
        external: false,
      },
      {
        id: "p4",
        name: "Agenda",
        account: "max2",
        owned: true,
        external: false,
      },
      { id: "p5", name: "Legacy", account: null, owned: false, external: true },
      { id: "p6", name: "Ghost", account: null, owned: true, external: false },
      { id: "p7", name: "Ads", account: "team3", owned: true, external: false },
    ],
    defaultAccountName: "viaulab",
    preferredModel: "Fable",
    forecasts: {
      viaulab: {
        weekly: {
          kind: "runs-out" as const,
          at: now + 53 * HOUR,
          percentPerDay: 30,
        },
      },
      max2: {
        weekly: {
          kind: "lasts" as const,
          until: now + 72 * HOUR,
          percentPerDay: 8,
        },
        Fable: {
          kind: "runs-out" as const,
          at: now + 9 * HOUR,
          percentPerDay: 40,
        },
      },
    },
  };
}
