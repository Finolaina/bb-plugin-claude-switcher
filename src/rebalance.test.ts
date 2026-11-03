import { describe, expect, it } from "vitest";
import {
  planRebalance,
  rebalanceTargets,
  type RebalanceProject,
} from "./rebalance.js";

// The Ultra accounts as `bb claude-switcher list` and `health` had them on
// 2026-11-03 13:07 (docs/plazas-2026-11-03/antes-*.txt): projects pinned,
// and the fuller of weekly and Fable.
const TODAY = [
  { name: "aitor", load: 51, projects: 27 },
  { name: "ganaresenas", load: 53, projects: 11 },
  { name: "joytorm", load: 21, projects: 9 },
  { name: "siloeads", load: 77, projects: 25 },
];
const accounts = TODAY.map(({ name, load }) => ({ name, load }));
function projectsOf(fixed: Record<string, number> = {}): RebalanceProject[] {
  return TODAY.flatMap(({ name, projects }) =>
    Array.from({ length: projects }, (_, i) => ({
      id: `${name}-${String(i).padStart(2, "0")}`,
      account: name,
      movable: i >= (fixed[name] ?? 0),
      lastActive: i,
    })),
  );
}
function after(projects: RebalanceProject[], spread = 10) {
  const moves = planRebalance(accounts, projects, spread);
  const count = new Map(accounts.map((a) => [a.name, 0]));
  const moved = new Map(moves.map((m) => [m.projectId, m.to]));
  for (const p of projects) {
    const at = moved.get(p.id) ?? p.account;
    count.set(at, count.get(at)! + 1);
  }
  return { moves, count };
}
const spreadOf = (count: Map<string, number>) =>
  Math.max(...count.values()) - Math.min(...count.values());

describe("rebalance", () => {
  it("today's accounts end within 10 projects of each other, more where the weekly has more room", () => {
    const { count, moves } = after(projectsOf());
    expect(spreadOf(count)).toBeLessThanOrEqual(10);
    expect([...count.values()].reduce((a, b) => a + b, 0)).toBe(72);
    // joytorm (21 %) ends with the most, siloeads (77 %) with the fewest.
    const sorted = [...count].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    expect(sorted[0]).toBe("joytorm");
    expect(sorted.at(-1)).toBe("siloeads");
    // Only the accounts above their share give projects.
    expect(new Set(moves.map((m) => m.from))).toEqual(
      new Set(["aitor", "siloeads"]),
    );
  });

  it("a project that is not movable never moves, and counts where it is", () => {
    const projects = projectsOf({ siloeads: 20 });
    const { moves, count } = after(projects);
    const fixed = new Set(projects.filter((p) => !p.movable).map((p) => p.id));
    expect(moves.filter((m) => fixed.has(m.projectId))).toEqual([]);
    expect(count.get("siloeads")).toBeGreaterThanOrEqual(20);
  });

  it("projects at work raise their account's floor: the rest spread over the others (Codex PLAZAS-003)", () => {
    const even = ["a", "b", "c"].map((name) => ({ name, load: 50 }));
    const projects = [
      ...Array.from({ length: 36 }, (_, i) => ({ id: `a${i}`, account: "a", movable: false, lastActive: 0 })),
      ...Array.from({ length: 54 }, (_, i) => ({ id: `b${i}`, account: "b", movable: true, lastActive: 0 })),
    ];
    const moves = planRebalance(even, projects, 10);
    const count = { a: 36, b: 54, c: 0 } as Record<string, number>;
    for (const m of moves) {
      count[m.from]! -= 1;
      count[m.to]! += 1;
    }
    expect(count).toEqual({ a: 36, b: 27, c: 27 });
  });

  it("with unequal loads too, the fixed projects raise the others' floor (Codex PLAZAS-R2-002)", () => {
    const t = rebalanceTargets(
      [
        { name: "a", load: 50 },
        { name: "b", load: 0 },
        { name: "c", load: 90 },
      ],
      90,
      10,
      new Map([["a", 36]]),
    );
    const v = [...t.values()];
    expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(10);
    expect(t.get("a")).toBe(36);
    expect(t.get("b")!).toBeGreaterThanOrEqual(t.get("c")!);
  });

  it("with more fixed projects than the spread allows, the others still even out", () => {
    const t = rebalanceTargets(
      ["a", "b", "c"].map((name) => ({ name, load: 50 })),
      40,
      10,
      new Map([["a", 36]]),
    );
    expect(Object.fromEntries(t)).toEqual({ a: 36, b: 2, c: 2 });
  });

  it("the least recently active projects move first", () => {
    const { moves } = after(projectsOf());
    const fromSiloeads = moves
      .filter((m) => m.from === "siloeads")
      .map((m) => m.projectId);
    expect(fromSiloeads).toEqual(
      fromSiloeads.map((_, i) => `siloeads-${String(i).padStart(2, "0")}`),
    );
  });

  it("already balanced: no move", () => {
    const even = accounts.map((a) => ({ ...a, load: 50 }));
    const projects = even.flatMap((a) =>
      [0, 1, 2].map((i) => ({
        id: `${a.name}${i}`,
        account: a.name,
        movable: true,
        lastActive: 0,
      })),
    );
    expect(planRebalance(even, projects, 10)).toEqual([]);
  });

  it("a project on an account not listed (a Team seat, one with no login) is left out", () => {
    const projects = [
      ...projectsOf(),
      { id: "team", account: "team1", movable: true, lastActive: 0 },
    ];
    expect(after(projects).moves.some((m) => m.projectId === "team")).toBe(
      false,
    );
  });

  it("the targets add up to the projects and keep the spread, also at its edge", () => {
    for (const total of [0, 1, 7, 72, 200])
      for (const spread of [0, 1, 2, 10]) {
        const t = rebalanceTargets(accounts, total, spread);
        const values = [...t.values()];
        expect(values.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(
          Math.max(spread, 1),
        );
      }
  });
});
