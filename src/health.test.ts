import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planOf } from "./accounts.js";
import {
  healthReport,
  healthText,
  isoInZone,
  type HealthAccount,
} from "./health.js";
import { parseUsage } from "./usage.js";

const NOW = Date.parse("2026-10-30T20:55:58.000Z");

function usage(name: string) {
  return {
    name,
    ...parseUsage(
      JSON.parse(
        readFileSync(
          new URL(`./fixtures/ultra/${name}.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  };
}

function account(
  overrides: Partial<HealthAccount> & Pick<HealthAccount, "name" | "usage">,
): HealthAccount {
  return {
    plan: planOf(
      { kind: "max", tier: "default_claude_max_20x" },
      overrides.usage,
    ),
    problem: null,
    pace: null,
    seats: { capacity: 4, running: 1, reserved: 0 },
    usable: true,
    ...overrides,
  };
}

describe("isoInZone", () => {
  it("writes ISO 8601 with Madrid's offset, winter and summer", () => {
    expect(isoInZone(Date.parse("2026-11-01T17:00:00.146Z"))).toBe(
      "2026-11-01T18:00:00+01:00",
    );
    expect(isoInZone(Date.parse("2026-07-01T07:00:00Z"))).toBe(
      "2026-07-01T09:00:00+02:00",
    );
  });
});

describe("healthReport (bb claude-switcher health --json, version 1)", () => {
  it("gives an Ultra account without the 5-hour window as the SPEC's example (canary 1)", () => {
    const report = healthReport({
      measured: NOW,
      dayStartHour: 9,
      accounts: [
        account({
          name: "aitor",
          usage: usage("ultra-sin-5h"),
          pace: {
            budget: 1.23,
            spent: 0.4,
            dayPercent: 32.5,
            background: true,
          },
        }),
      ],
    });
    expect(report).toEqual({
      version: 1,
      medido: "2026-10-30T21:55:58+01:00",
      inicioDia: 9,
      cuentas: [
        {
          nombre: "aitor",
          plan: "ultra",
          planTexto: "Ultra · sin tope de 5 h",
          cincoHoras: false,
          sesion: null,
          semana: { pct: 98, vuelve: "2026-11-01T18:00:00+01:00" },
          modelos: { Fable: { pct: 100, vuelve: "2026-11-01T18:00:00+01:00" } },
          ritmo: { presupuesto: 1.2, gastado: 0.4, pctDia: 33, fondo: true },
          plazas: { usadas: 1, total: 4, externas: [] },
          usable: true,
          problema: null,
        },
      ],
    });
  });

  it("gives a Team seat no weekly nor pace, and only the models the API reports (canary 2)", () => {
    const [team] = healthReport({
      measured: NOW,
      dayStartHour: 9,
      accounts: [
        account({
          name: "team1",
          usage: usage("team"),
          plan: planOf({ kind: "unknown" }, usage("team")),
          seats: { capacity: 2, running: 0, reserved: 1 },
        }),
      ],
    }).cuentas;
    expect(team).toMatchObject({
      plan: "team",
      planTexto: "Team",
      cincoHoras: true,
      sesion: { pct: 0, vuelve: null },
      semana: null,
      ritmo: null,
      plazas: { usadas: 1, total: 2 },
    });
    expect(Object.keys(team!.modelos)).toEqual(["Fable"]);
  });

  it("says an Ultra account still on the 5-hour window and its session (canary 3)", () => {
    const [ultra] = healthReport({
      measured: NOW,
      dayStartHour: 9,
      accounts: [account({ name: "work", usage: usage("ultra-con-5h-b") })],
    }).cuentas;
    expect(ultra).toMatchObject({
      plan: "ultra",
      planTexto: "Ultra · 5 h hasta que Anthropic la verifique",
      cincoHoras: true,
      sesion: { pct: 2, vuelve: "2026-10-30T22:10:00+01:00" },
    });
  });

  it("says why an account is not usable, and gives no plan a Spanish «desconocido»", () => {
    const report = healthReport({
      measured: NOW,
      dayStartHour: 9,
      accounts: [
        account({
          name: "nologin",
          usage: null,
          plan: planOf({ kind: "unknown" }, null),
          problem: { kind: "unauthenticated" },
          usable: false,
          seats: undefined,
        }),
        account({
          name: "failing",
          usage: null,
          problem: { kind: "error", message: "HTTP 429" },
          usable: false,
        }),
        account({ name: "never", usage: null, usable: false }),
      ],
    });
    expect(
      report.cuentas.map((c) => [c.nombre, c.plan, c.problema, c.plazas]),
    ).toEqual([
      ["nologin", "desconocido", "sin login", null],
      [
        "failing",
        "ultra",
        "consulta fallida: HTTP 429",
        { usadas: 1, total: 4, externas: [] },
      ],
      ["never", "ultra", "sin medir", { usadas: 1, total: 4, externas: [] }],
    ]);
    const { five_hour: _, ...incomplete } = JSON.parse(
      readFileSync(
        new URL("./fixtures/ultra/ultra-sin-5h.json", import.meta.url),
        "utf8",
      ),
    );
    const partial = { name: "x", ...parseUsage(incomplete) };
    const [x] = healthReport({
      measured: NOW,
      dayStartHour: 9,
      accounts: [
        account({
          name: "x",
          usage: partial,
          plan: planOf({ kind: "unknown" }, partial),
          usable: false,
        }),
      ],
    }).cuentas;
    // Canary 5: incomplete, not Ultra.
    expect(x).toMatchObject({
      plan: "desconocido",
      cincoHoras: null,
      problema: "datos incompletos de la API de uso",
    });
  });

  it("says no limit of seats as a null total", () => {
    const [a] = healthReport({
      measured: NOW,
      dayStartHour: 9,
      accounts: [
        account({
          name: "a",
          usage: usage("ultra-sin-5h"),
          seats: { capacity: 0, running: 2, reserved: 0 },
        }),
      ],
    }).cuentas;
    expect(a!.plazas).toEqual({ usadas: 2, total: null, externas: [] });
  });
});

describe("healthText", () => {
  it("gives one line per account with its plan, windows, pace and seats", () => {
    const text = healthText(
      healthReport({
        measured: NOW,
        dayStartHour: 9,
        accounts: [
          account({
            name: "aitor",
            usage: usage("ultra-sin-5h"),
            pace: {
              budget: 1.23,
              spent: 0.4,
              dayPercent: 32.5,
              background: true,
            },
          }),
          account({
            name: "team1",
            usage: usage("team"),
            plan: planOf({ kind: "team" }, usage("team")),
            seats: { capacity: 2, running: 0, reserved: 0 },
          }),
        ],
      }),
    );
    expect(text).toBe(
      [
        "medido 2026-10-30T21:55:58+01:00 · el día empieza a las 9:00",
        "aitor  Ultra · sin tope de 5 h · sem 98% · Fable 100% · ritmo 33% (fondo sí) · plazas 1/4 · usable",
        "team1  Team · ses 0% · Fable 76% · plazas 0/2 · usable",
        "",
      ].join("\n"),
    );
  });
});
