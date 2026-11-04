import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FALLO_MS,
  OLVIDO_MS,
  REAVISO_MS,
  REAVISO_SIN_DESTINO_MS,
  SIN_DESTINO_MS,
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

  it("una fila que falla por otra cosa avisa a los 10 minutos, tenga o no quien la retiene", () => {
    const filas = [fila({ failureReason: "hook timed out", waitingOn: null })];
    expect(juzga(INCIDENTE, filas, NOW - UMBRAL_MS + 1).avisos).toEqual([]);
    const { avisos, retenidas } = juzga(INCIDENTE, filas);
    expect(retenidas).toBe(1);
    expect(avisos).toEqual([
      { tipo: "fallida", clave: "t1:fallida", fila: "q1", hilo: "t1", minutos: 10, razon: "hook timed out" },
    ]);
    expect(textoAviso(avisos[0]!)).toBe("El mensaje del hilo t1 lleva 10 min parado; último fallo: hook timed out");
  });

  it("una fila retenida y otra fallida del mismo hilo avisan las dos", () => {
    const { avisos } = judge({
      filas: [fila(), fila({ id: "q2", failureReason: "hook timed out" })],
      health: INCIDENTE,
      estado: { primeraVez: { q1: NOW - UMBRAL_MS, q2: NOW - UMBRAL_MS } },
      ahora: NOW,
    });
    expect(avisos.map((a) => (a as { tipo?: string }).tipo)).toEqual([undefined, "fallida"]);
  });

  describe("retenida sin ninguna cuenta que pueda correrla", () => {
    const NADIE = { cuentas: [cuenta("team2", { usable: false }), INCIDENTE.cuentas[2]] };

    it("1:59 no avisa; 2:00 sí, y dice a quién", () => {
      expect(juzga(NADIE, undefined, NOW - SIN_DESTINO_MS + 1).avisos).toEqual([]);
      const { avisos } = juzga(NADIE, undefined, NOW - SIN_DESTINO_MS);
      expect(avisos).toHaveLength(1);
      expect(textoAviso(avisos[0]!)).toBe(
        "1 hilo lleva 2 h retenido sin ninguna cuenta que pueda correrlo: t1 (Opus)",
      );
    });

    it("varios hilos son un solo aviso, con la mayor espera", () => {
      const { avisos } = judge({
        filas: [fila(), fila({ id: "q2" }), fila({ id: "q3", threadId: "t2" })],
        health: NADIE,
        estado: {
          primeraVez: { q1: NOW - SIN_DESTINO_MS, q2: NOW - 5 * SIN_DESTINO_MS, q3: NOW - 39 * SIN_DESTINO_MS },
        },
        ahora: NOW,
      });
      expect(avisos).toHaveLength(1);
      expect(textoAviso(avisos[0]!)).toBe(
        "2 hilos llevan hasta 78 h retenidos sin ninguna cuenta que pueda correrlo: t1 (Opus), t2 (Opus)",
      );
    });

    it("se repite cada 6 horas, no cada hora", () => {
      const paso = (avisado: number) =>
        judge({
          filas: [fila()],
          health: NADIE,
          estado: { primeraVez: { q1: NOW - 10 * REAVISO_SIN_DESTINO_MS }, vista: {}, avisado: { "sin-destino": avisado } },
          ahora: NOW,
        }).avisos;
      expect(paso(NOW - REAVISO_SIN_DESTINO_MS + 1)).toEqual([]);
      expect(paso(NOW - REAVISO_SIN_DESTINO_MS)).toHaveLength(1);
    });

    it("sin nadie en ese caso olvida el aviso: el próximo que llegue no espera 6 horas", () => {
      const { estado } = judge({
        filas: [],
        health: NADIE,
        estado: { avisado: { "sin-destino": NOW - 60_000 } },
        ahora: NOW,
      });
      expect(estado.avisado).toEqual({});
    });

    it("una fila oculta un momento no repite el aviso al volver", () => {
      const primera = { q1: NOW - 3 * SIN_DESTINO_MS };
      const oculta = judge({
        filas: [],
        health: NADIE,
        estado: { primeraVez: primera, vista: { q1: NOW - 60_000 }, avisado: { "sin-destino": NOW - 60_000 } },
        ahora: NOW,
      });
      expect(oculta.estado.avisado).toEqual({ "sin-destino": NOW - 60_000 });
      const vuelve = judge({ filas: [fila()], health: NADIE, estado: oculta.estado, ahora: NOW + 60_000 });
      expect(vuelve.avisos).toEqual([]);
    });

    it("con una cuenta libre es el aviso de siempre, no este", () => {
      const { avisos } = juzga(INCIDENTE, undefined, NOW - SIN_DESTINO_MS);
      expect(avisos.map((a) => (a as { tipo?: string }).tipo)).toEqual([undefined]);
    });
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
        estado: { primeraVez: { q1: NOW - 2 * REAVISO_MS }, avisado: { t1: avisado } },
        ahora: NOW,
      }).avisos;
    expect(paso(NOW - REAVISO_MS + 1)).toEqual([]);
    expect(paso(NOW - REAVISO_MS)).toHaveLength(1);
  });

  it("tres mensajes del mismo hilo son un aviso, no tres", () => {
    const filas = [fila(), fila({ id: "q2" }), fila({ id: "q3" })];
    const { avisos } = judge({
      filas,
      health: INCIDENTE,
      estado: {
        primeraVez: { q1: NOW - UMBRAL_MS, q2: NOW - UMBRAL_MS, q3: NOW - UMBRAL_MS },
      },
      ahora: NOW,
    });
    expect(avisos.map((a) => a.fila)).toEqual(["q1"]);
  });

  it("recuerda la primera vez que ve cada fila y olvida las que llevan 20 minutos sin verse", () => {
    const { estado, avisos } = judge({
      filas: [fila({ id: "q2" })],
      health: INCIDENTE,
      estado: {
        primeraVez: { q1: NOW - UMBRAL_MS },
        avisado: { t1: NOW - REAVISO_MS },
        vista: { q1: NOW - OLVIDO_MS },
      },
      ahora: NOW,
    });
    expect(avisos).toEqual([]);
    expect(estado).toEqual({ primeraVez: { q2: NOW }, avisado: {}, vista: { q2: NOW } });
  });

  it("una fila que bb oculta un momento mientras la reevalúa no pierde su antigüedad", () => {
    const hueco = judge({
      filas: [],
      health: INCIDENTE,
      estado: {
        primeraVez: { q1: NOW - 8 * 60_000 },
        vista: { q1: NOW - 10_000 },
      },
      ahora: NOW,
    });
    expect(hueco.avisos).toEqual([]);
    expect(hueco.estado.primeraVez.q1).toBe(NOW - 8 * 60_000);
    const vuelve = judge({
      filas: [fila()],
      health: INCIDENTE,
      estado: hueco.estado,
      ahora: NOW + 2 * 60_000,
    });
    expect(vuelve.avisos).toHaveLength(1);
  });

  it("no se fía de una ventana cuyo reset solo dice el reloj, con las consultas fallando", () => {
    expect(
      juzga({
        cuentas: [
          cuenta("team2", { modelos: { Opus: { pct: 0, pctExacto: 0, sinConfirmar: true } } }),
        ],
      }).avisos,
    ).toEqual([]);
  });

  it("lee las ventanas sin distinguir mayúsculas", () => {
    expect(
      juzga({ cuentas: [cuenta("team2", { modelos: { opus: { pct: 100, pctExacto: 100 } } })] }).avisos,
    ).toEqual([]);
    expect(
      juzga({
        cuentas: [
          cuenta("ultra1", { plan: "ultra", modelos: { fable: { pct: 100, pctExacto: 100 } } }),
        ],
      }).avisos,
    ).toHaveLength(1);
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
  const correr = async (fake: string, estado?: unknown, fallo?: unknown, env: Record<string, string> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "canario-"));
    if (estado !== undefined)
      await writeFile(join(dir, "canario-cola-estado.json"), JSON.stringify(estado));
    if (fallo !== undefined)
      await writeFile(join(dir, "canario-cola-fallo.json"), JSON.stringify(fallo));
    const binario = join(dir, "bb-falso");
    await writeFile(binario, `#!/bin/sh\n${fake}\n`);
    await chmod(binario, 0o755);
    try {
      const salida = await promisify(execFile)(process.execPath, [SCRIPT], {
        cwd: dir,
        env: { ...process.env, BB_CLI: binario, ...env },
      });
      return { code: 0, ...salida, dir };
    } catch (error) {
      return { ...(error as { code: number; stdout: string; stderr: string }), dir };
    }
  };

  it("ejecutado por un enlace mira igual: no sale en verde sin haber mirado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canario-enlace-"));
    const binario = join(dir, "bb-falso");
    await writeFile(binario, `#!/bin/sh\ncase "$1" in thread) echo '[]';; *) echo '{"cuentas":[]}';; esac\n`);
    await chmod(binario, 0o755);
    const enlace = join(dir, "canario.mjs");
    await symlink(SCRIPT, enlace);
    const salida = await promisify(execFile)(process.execPath, [enlace], {
      cwd: dir,
      env: { ...process.env, BB_CLI: binario },
    });
    expect(salida.stdout).toContain("0 retenidas");
  });

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

  it.each([
    ["sin cuentas", '{"cuentas":[]}'],
    ["cuentas sin el campo usable", '{"cuentas":[{"nombre":"team2","plan":"team"}]}'],
  ])("con filas retenidas y %s sale 1: no ha podido juzgarlas", async (_, salud) => {
    const r = await correr(`case "$1" in thread) echo '${JSON.stringify([fila()])}';; *) echo '${salud}';; esac`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no enseña cuentas");
  });

  describe("sin poder mirar", () => {
    const rota = `case "$1" in plugin) echo "$@" > "$PWD/llamada"; cp "$6" "$PWD/entrada"; echo '{"ok":true,"channels":["web"]}';; *) exit 3;; esac`;
    const hay = (dir: string, fichero: string) => readFile(join(dir, fichero), "utf8").then(() => true, () => false);

    it("un bb colgado es no poder mirar: sale 1 y apunta desde cuándo", async () => {
      const r = await correr("exec sleep 30", undefined, undefined, { CANARIO_BB_MS: "200" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("lectura fallida");
      expect(await hay(r.dir, "canario-cola-fallo.json")).toBe(true);
    });

    it("un fallo suelto sale 1, sin aviso, y apunta desde cuándo", async () => {
      const r = await correr(rota);
      expect(r.code).toBe(1);
      expect(await hay(r.dir, "llamada")).toBe(false);
      expect(JSON.parse(await readFile(join(r.dir, "canario-cola-fallo.json"), "utf8")).desde).toBeGreaterThan(0);
    });

    it("media hora seguida avisa, una vez por hora", async () => {
      const r = await correr(rota, undefined, { desde: Date.now() - FALLO_MS - 60_000 });
      expect(r.code).toBe(1);
      expect(JSON.parse(await readFile(join(r.dir, "entrada"), "utf8")).title).toBe("Switcher: el vigilante no ve la cola");
      const otra = await correr(rota, undefined, { desde: Date.now() - 2 * FALLO_MS, avisado: Date.now() - REAVISO_MS + 60_000 });
      expect(await hay(otra.dir, "llamada")).toBe(false);
    });

    it("en cuanto vuelve a mirar, la cuenta empieza de cero", async () => {
      const r = await correr(`case "$1" in thread) echo '[]';; *) echo '{"cuentas":[]}';; esac`, undefined, { desde: 1 });
      expect(r.code).toBe(0);
      expect(await hay(r.dir, "canario-cola-fallo.json")).toBe(false);
    });
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
      expect(estado.avisado.t1).toBeGreaterThan(0);
    });

    it.each([
      ["falla", "exit 4"],
      ["no llega a nadie", `echo '{"ok":true,"channels":[]}'`],
      ["se cuelga", "exec sleep 30"],
    ])("si el aviso %s sale 1 y lo repite en la pasada siguiente", async (_, push) => {
      const r = await correr(bbFalso(push), viejo(), undefined, { CANARIO_BB_MS: "2000" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("aviso no entregado");
      const estado = JSON.parse(await readFile(join(r.dir, "canario-cola-estado.json"), "utf8"));
      expect(estado.avisado.t1).toBeUndefined();
    });
  });

  it("el aviso agrupado que no se entrega se repite en la pasada siguiente", async () => {
    const salud = JSON.stringify({ cuentas: [cuenta("team2", { usable: false })] });
    const r = await correr(
      `case "$1" in thread) echo '${JSON.stringify([fila()])}';; claude-switcher) echo '${salud}';; plugin) exit 4;; esac`,
      { primeraVez: { q1: Date.now() - SIN_DESTINO_MS - 60_000 } },
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(await readFile(join(r.dir, "canario-cola-estado.json"), "utf8")).avisado).toEqual({});
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
