#!/usr/bin/env node
// Canario de la cola de plazas: cada 10 minutos, en el servidor de bb (una
// `bb automation`), avisa si el plugin retiene un mensaje 10 minutos o más
// con una cuenta usable y con plaza libre que podría correrlo.
//
// No usa la lógica del plugin: el fallo del 2026-11-03 fue justo que el plugin
// daba por bueno su veto. Solo lee lo que bb enseña por fuera:
// `bb thread queue list --json` y `bb claude-switcher health --json`.
//
// Una lectura que falla sale con código 1 (visible en `bb automation runs`):
// nunca «todo bien» sin haber mirado.
import { execFile } from "node:child_process";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const UMBRAL_MS = 10 * 60_000;
export const REAVISO_MS = 60 * 60_000;
/** Una fila que bb no enseña este rato se da por ida: mientras la reevalúa la oculta, y su antigüedad no se pierde por eso. */
export const OLVIDO_MS = 20 * 60_000;
const PLUGIN = "claude-switcher";
const RESERVADO = "Fable";

/** «claude-opus-5-5», «opus», «opus[1m]» → «Opus»; sin nombre conocido, el modelo que guarda el reparto. */
export function familia(model) {
  const m =
    /^claude-([a-z]+)-/.exec(model ?? "") ??
    /^(fable|opus|sonnet|haiku)(?:\[[^\]]*\])?$/i.exec(model ?? "");
  if (m === null) return RESERVADO;
  const nombre = m[1].toLowerCase();
  return nombre[0].toUpperCase() + nombre.slice(1);
}

const exacto = (punto) => punto?.pctExacto ?? punto?.pct ?? 0;

/** La ventana del modelo, sin distinguir mayúsculas: la API conserva la grafía que le llega. */
function ventana(cuenta, modelo) {
  const clave = Object.keys(cuenta.modelos ?? {}).find(
    (m) => m.toLowerCase() === modelo.toLowerCase(),
  );
  return clave === undefined ? undefined : cuenta.modelos[clave];
}

/** Si esta cuenta, tal como la enseña `health`, podría correr ahora un turno de `modelo`. */
export function puedeCorrer(cuenta, modelo) {
  if (cuenta.usable !== true) return false;
  const plazas = cuenta.plazas;
  if (plazas !== null && plazas !== undefined && plazas.total !== null && plazas.usadas >= plazas.total)
    return false;
  const propia = ventana(cuenta, modelo);
  // Solo el reloj dice que volvió, y las consultas fallan: el plugin no se fía.
  if (propia?.sinConfirmar === true || exacto(propia) >= 100) return false;
  // «Esperar siempre» (Aitor, 2026-11-03): lo que no es Fable ni Haiku no
  // gasta la semanal de una cuenta que conserva Fable.
  if (modelo === RESERVADO || modelo === "Haiku") return true;
  return cuenta.plan === "team" || exacto(ventana(cuenta, RESERVADO)) >= 100;
}

/**
 * El juicio, puro. `estado`: { primeraVez: {fila: ms}, avisado: {fila: ms} }.
 * Devuelve los avisos de esta pasada y el estado siguiente.
 */
export function judge({ filas, health, estado, ahora }) {
  const vivas = filas.filter(
    (f) =>
      f.waitingOn?.kind === "plugin" &&
      f.waitingOn.pluginId === PLUGIN &&
      (f.failureReason ?? null) === null,
  );
  const primeraVez = {};
  const avisado = {};
  const vista = {};
  const avisos = [];
  // Las que bb no enseña en esta lectura, un rato: siguen con su antigüedad.
  for (const [id, cuando] of Object.entries(estado.vista ?? {}))
    if (ahora - cuando < OLVIDO_MS && estado.primeraVez?.[id] !== undefined) {
      primeraVez[id] = estado.primeraVez[id];
      vista[id] = cuando;
      if (estado.avisado?.[id] !== undefined) avisado[id] = estado.avisado[id];
    }
  for (const fila of vivas) {
    const desde = estado.primeraVez?.[fila.id] ?? ahora;
    primeraVez[fila.id] = desde;
    vista[fila.id] = ahora;
    const antes = estado.avisado?.[fila.id];
    if (antes !== undefined) avisado[fila.id] = antes;
    if (ahora - desde < UMBRAL_MS) continue;
    const modelo = familia(fila.model);
    const libres = health.cuentas
      .filter((c) => puedeCorrer(c, modelo))
      .map((c) => c.nombre);
    if (libres.length === 0) continue;
    if (antes !== undefined && ahora - antes < REAVISO_MS) continue;
    avisado[fila.id] = ahora;
    avisos.push({
      fila: fila.id,
      hilo: fila.threadId,
      modelo,
      minutos: Math.floor((ahora - desde) / 60_000),
      libres,
      // Dato del plugin, solo para el texto: no decide si se avisa.
      ocupado:
        health.atascos?.some((a) => a.hilo === fila.threadId && a.proyectoOcupado) === true,
    });
  }
  return { avisos, estado: { primeraVez, avisado, vista }, retenidas: vivas.length };
}

export function textoAviso(a) {
  return `El switcher retiene el hilo ${a.hilo} (${a.modelo}) ${a.minutos} min con ${a.libres.join(", ")} libre${a.libres.length === 1 ? "" : "s"}${a.ocupado ? "; su proyecto tiene otro hilo en marcha y por eso no se mueve solo" : ""}`;
}

const run = promisify(execFile);

async function bb(args) {
  const candidatos = [
    process.env.BB_CLI,
    "bb",
    join(homedir(), ".local/bin/bb"),
  ].filter(Boolean);
  let ultimo;
  for (const binario of candidatos) {
    try {
      return (await run(binario, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch (error) {
      ultimo = error;
      // Solo se prueba el siguiente si este binario no existe.
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw ultimo;
}

async function leerEstado(ruta) {
  try {
    return JSON.parse(await readFile(ruta, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      console.error(`estado ilegible, empieza de cero: ${error.message}`);
    return {};
  }
}

export async function main({ dir = process.cwd(), ahora = Date.now() } = {}) {
  const filas = JSON.parse(await bb(["thread", "queue", "list", "--json"]));
  const health = JSON.parse(await bb(["claude-switcher", "health", "--json"]));
  if (!Array.isArray(filas) || !Array.isArray(health.cuentas))
    throw new Error("la cola o la salud no tienen la forma esperada");
  const ruta = join(dir, "canario-cola-estado.json");
  const veredicto = judge({
    filas,
    health,
    estado: await leerEstado(ruta),
    ahora,
  });
  let entregado = true;
  for (const aviso of veredicto.avisos) {
    const texto = textoAviso(aviso);
    console.log(`AVISO ${texto}`);
    await appendFile(
      join(dir, "avisos.log"),
      `${new Date(ahora).toISOString()} ${texto}\n`,
    );
    try {
      const entrada = join(dir, "canario-cola-aviso.json");
      await writeFile(
        entrada,
        JSON.stringify({
          title: "Switcher: hilo retenido",
          body: texto,
          threadId: aviso.hilo,
        }),
      );
      const respuesta = JSON.parse(
        await bb([
          "plugin", "rpc", "call", "--json", "--input-file", entrada,
          "push-notifications", "notifications.send",
        ]),
      );
      // Lista vacía: el plugin de avisos dice que no llegó a nadie.
      if (!(respuesta.channels?.length > 0))
        throw new Error("ningún canal lo recibió");
    } catch (error) {
      entregado = false;
      // Sin marcar: se repite en la pasada siguiente.
      delete veredicto.estado.avisado[aviso.fila];
      console.error(`aviso no entregado: ${error.message}`);
    }
  }
  const temporal = `${ruta}.tmp`;
  await writeFile(temporal, JSON.stringify(veredicto.estado));
  await rename(temporal, ruta);
  console.log(
    `cola: ${filas.length} filas, ${veredicto.retenidas} retenidas por el switcher, ${veredicto.avisos.length} avisos`,
  );
  return entregado ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`lectura fallida: ${error.message}`);
      process.exitCode = 1;
    },
  );
