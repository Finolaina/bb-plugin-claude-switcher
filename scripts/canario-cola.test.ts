import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  REAVISO_MS,
  UMBRAL_MS,
  familia,
  judge,
  puedeCorrer,
  textoAviso,
} from "./canario-cola.mjs";

const NOW = 2_000_000_000_000;
const fila = (over = {}) => ({
  id: "q1",
  threadId: "t1",
  model: "claude-opus-5-5",
  failureReason: null,
  waitingOn: { kind: "plugin", pluginId: "claude-switcher", reason: "seat" },
  ...over,
});
const cuenta = (nombre: string, over = {}) => ({
  nombre,
  plan: "team",
  usable: true,
  plazas: { usadas: 0, total: 2 },
  modelos: {},
  ...over,
});
const lleno = { plazas: { usadas: 2, total: 2 } };
/** El estado de las 23:10 del 2026-11-03: una Team retiene, la Team sin Fable agotada llena, otra Team libre con Fable. */
const INCIDENTE = {
  cuentas: [
    cuenta("team5", { ...lleno, modelos: { Fable: { pct: 100, pctExacto: 100 } } }),
    cuenta("team2", { modelos: { Fable: { pct: 3, pctExacto: 3 } } }),
    cuenta("ultra1", { plan: "ultra", modelos: { Fable: { pct: 90, pctExacto: 90 } } }),
  ],
};
const juzga = (health: { cuentas: unknown[]; atascos?: unknown[] }, filas: unknown[] = [fila()], desde = NOW - UMBRAL_MS) =>
  judge({
    filas,
    health,
    estado: { primeraVez: { q1: desde } },
    ahora: NOW,
  });

describe("judge", () => {
  it("el incidente del 23:10 reconstruido avisa", () => {
    const { avisos } = juzga(INCIDENTE);
    expect(avisos).toEqual([
      { fila: "q1", hilo: "t1", modelo: "Opus", minutos: 10, libres: ["team2"], ocupado: false },
    ]);
  });

  it("dice si el proyecto tiene otro hilo en marcha, sin que eso decida el aviso", () => {
    const [a] = juzga({
      ...INCIDENTE,
      atascos: [{ hilo: "t1", proyectoOcupado: true }],
    }).avisos;
    expect(a?.ocupado).toBe(true);
    expect(textoAviso(a!)).toContain("su proyecto tiene otro hilo en marcha");
  });

  it("9:59 no avisa; 10:00 sí", () => {
    expect(juzga(INCIDENTE, undefined, NOW - UMBRAL_MS + 1).avisos).toEqual([]);
    expect(juzga(INCIDENTE, undefined, NOW - UMBRAL_MS).avisos).toHaveLength(1);
  });

  it("con las Team llenas y una Ultra libre no avisa: es «Esperar siempre»", () => {
    const { avisos } = juzga({
      cuentas: [cuenta("team5", lleno), cuenta("team2", lleno), INCIDENTE.cuentas[2]],
    });
    expect(avisos).toEqual([]);
  });

  it("una Team con su Opus al 100 % no es destino para Opus", () => {
    const { avisos } = juzga({
      cuentas: [cuenta("team2", { modelos: { Opus: { pct: 100, pctExacto: 100 } } })],
    });
    expect(avisos).toEqual([]);
  });

  it("usa el porcentaje exacto: 99,6 redondea a 100 y aún corre", () => {
    const { avisos } = juzga({
      cuentas: [cuenta("team2", { modelos: { Opus: { pct: 100, pctExacto: 99.6 } } })],
    });
    expect(avisos).toHaveLength(1);
  });

  it("una cuenta sin límite de plazas (total null) está libre", () => {
    const { avisos } = juzga({
      cuentas: [cuenta("team2", { plazas: { usadas: 9, total: null } })],
    });
    expect(avisos).toHaveLength(1);
  });

  it("una cuenta no usable no es destino", () => {
    expect(juzga({ cuentas: [cuenta("team2", { usable: false })] }).avisos).toEqual([]);
  });

  it("la fila de un hilo archivado no avisa", () => {
    const { avisos, retenidas } = juzga(INCIDENTE, [
      fila({ failureReason: "Thread is archived" }),
    ]);
    expect(avisos).toEqual([]);
    expect(retenidas).toBe(0);
  });

  it("las filas de otro plugin o de hilo ocupado no cuentan", () => {
    expect(
      juzga(INCIDENTE, [
        fila({ waitingOn: { kind: "thread-busy" } }),
        fila({ id: "q2", waitingOn: { kind: "plugin", pluginId: "otro" } }),
      ]).avisos,
    ).toEqual([]);
  });

  it("avisa una vez por fila y hora", () => {
    const paso = (avisado: number) =>
      judge({
        filas: [fila()],
        health: INCIDENTE,
        estado: { primeraVez: { q1: NOW - 2 * REAVISO_MS }, avisado: { q1: avisado } },
        ahora: NOW,
      }).avisos;
    expect(paso(NOW - REAVISO_MS + 1)).toEqual([]);
    expect(paso(NOW - REAVISO_MS)).toHaveLength(1);
  });

  it("recuerda la primera vez que ve cada fila y olvida las que se fueron", () => {
    const { estado, avisos } = judge({
      filas: [fila({ id: "q2" })],
      health: INCIDENTE,
      estado: { primeraVez: { q1: NOW - UMBRAL_MS }, avisado: { q1: NOW } },
      ahora: NOW,
    });
    expect(avisos).toEqual([]);
    expect(estado).toEqual({ primeraVez: { q2: NOW }, avisado: {} });
  });
});

describe("puedeCorrer", () => {
  it("Fable va a cualquier cuenta con Fable, y Haiku no respeta la reserva", () => {
    const ultra = INCIDENTE.cuentas[2]!;
    expect(puedeCorrer(ultra, "Fable")).toBe(true);
    expect(puedeCorrer(ultra, "Haiku")).toBe(true);
    expect(puedeCorrer(ultra, "Opus")).toBe(false);
    expect(puedeCorrer({ ...ultra, modelos: { Fable: { pct: 100, pctExacto: 100 } } }, "Opus")).toBe(true);
    expect(puedeCorrer(cuenta("t", { modelos: { Fable: { pct: 100, pctExacto: 100 } } }), "Fable")).toBe(false);
  });
});

describe("familia", () => {
  it.each([
    ["claude-opus-5-5", "Opus"],
    ["opus", "Opus"],
    ["opus[1m]", "Opus"],
    ["claude-fable-5-1", "Fable"],
    ["default", "Fable"],
    [null, "Fable"],
  ])("%s es %s", (model, nombre) => {
    expect(familia(model)).toBe(nombre);
  });
});

describe("el script entero, con un bb de mentira", () => {
  const SCRIPT = fileURLToPath(new URL("./canario-cola.mjs", import.meta.url));
  const correr = async (fake: string, estado?: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), "canario-"));
    if (estado !== undefined)
      await writeFile(join(dir, "canario-cola-estado.json"), JSON.stringify(estado));
    const binario = join(dir, "bb-falso");
    await writeFile(binario, `#!/bin/sh\n${fake}\n`);
    await chmod(binario, 0o755);
    try {
      const salida = await promisify(execFile)(process.execPath, [SCRIPT], {
        cwd: dir,
        env: { ...process.env, BB_CLI: binario },
      });
      return { code: 0, ...salida, dir };
    } catch (error) {
      return { ...(error as { code: number; stdout: string; stderr: string }), dir };
    }
  };

  it("sale 1 si bb falla: nunca «todo bien» sin haber mirado", async () => {
    const r = await correr("exit 3");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("lectura fallida");
  });

  it("sale 1 si la respuesta no es JSON", async () => {
    const r = await correr("echo no-json");
    expect(r.code).toBe(1);
  });

  it("sin filas sale 0 y lo dice", async () => {
    const r = await correr(`case "$1" in thread) echo '[]';; *) echo '{"cuentas":[]}';; esac`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0 retenidas");
  });

  describe("un aviso de verdad", () => {
    const filaJson = JSON.stringify([fila()]);
    const salud = JSON.stringify(INCIDENTE);
    const viejo = () => ({ primeraVez: { q1: Date.now() - UMBRAL_MS - 60_000 } });
    const bbFalso = (push: string) =>
      `case "$1" in thread) echo '${filaJson}';; claude-switcher) echo '${salud}';; plugin) echo "$@" > "$PWD/llamada"; cp "$6" "$PWD/entrada"; ${push};; esac`;

    it("llama al plugin de avisos, lo apunta y no lo repite en la hora", async () => {
      const r = await correr(bbFalso(`echo '{"ok":true,"channels":["web"]}'`), viejo());
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AVISO El switcher retiene el hilo t1 (Opus) 11 min con team2 libre");
      expect(await readFile(join(r.dir, "llamada"), "utf8")).toContain(
        "push-notifications notifications.send",
      );
      expect(JSON.parse(await readFile(join(r.dir, "entrada"), "utf8"))).toMatchObject({
        threadId: "t1",
      });
      expect(await readFile(join(r.dir, "avisos.log"), "utf8")).toContain("t1");
      const estado = JSON.parse(await readFile(join(r.dir, "canario-cola-estado.json"), "utf8"));
      expect(estado.avisado.q1).toBeGreaterThan(0);
    });

    it.each([
      ["falla", "exit 4"],
      ["no llega a nadie", `echo '{"ok":true,"channels":[]}'`],
    ])("si el aviso %s sale 1 y lo repite en la pasada siguiente", async (_, push) => {
      const r = await correr(bbFalso(push), viejo());
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("aviso no entregado");
      const estado = JSON.parse(await readFile(join(r.dir, "canario-cola-estado.json"), "utf8"));
      expect(estado.avisado.q1).toBeUndefined();
    });
  });

  it("la primera pasada guarda cuándo vio la fila, y no avisa todavía", async () => {
    const filaJson = JSON.stringify([fila()]);
    const salud = JSON.stringify(INCIDENTE);
    const r = await correr(`case "$1" in thread) echo '${filaJson}';; *) echo '${salud}';; esac`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 retenidas");
    const estado = JSON.parse(await readFile(join(r.dir, "canario-cola-estado.json"), "utf8"));
    expect(Object.keys(estado.primeraVez)).toEqual(["q1"]);
  });
});
