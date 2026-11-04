#!/usr/bin/env node
// Canario de la cola de plazas: cada 10 minutos, en el servidor de bb (una
// `bb automation`), avisa si el plugin retiene un mensaje 10 minutos o más
// con una cuenta usable y con plaza libre que podría correrlo; si lo retiene 2
// horas o más sin ninguna que pueda («Esperar siempre» sigue esperando, pero no
// en silencio); y si un mensaje que falla lleva 10 minutos parado.
//
// No usa la lógica del plugin: el fallo del 2026-11-03 fue justo que el plugin
// daba por bueno su veto. Solo lee lo que bb enseña por fuera:
// `bb thread queue list --json` y `bb claude-switcher health --json`.
//
// Una lectura que falla sale con código 1 (visible en `bb automation runs`) y,
// si dura media hora, también avisa: nunca «todo bien» sin haber mirado.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const UMBRAL_MS = 10 * 60_000;
export const REAVISO_MS = 60 * 60_000;
/** Una fila que bb no enseña este rato se da por ida: mientras la reevalúa la oculta, y su antigüedad no se pierde por eso. */
export const OLVIDO_MS = 20 * 60_000;
/** Retenida este rato sin ninguna cuenta que pueda correrla: avisa aunque sea «Esperar siempre». */
export const SIN_DESTINO_MS = 2 * 60 * 60_000;
/** Un solo aviso agrupado cada este rato: esperar toda una noche no son ocho avisos por hora. */
export const REAVISO_SIN_DESTINO_MS = 6 * 60 * 60_000;
/** El vigilante lleva este rato sin poder mirar: avisa. Un fallo suelto solo queda en `bb automation runs`. */
export const FALLO_MS = 30 * 60_000;
/** Lo que puede tardar cada llamada a bb: colgada, el vigilante no podría decir que no ve (Astra IR3-001). */
const BB_MS = Number(process.env.CANARIO_BB_MS ?? 60_000);
const SIN_DESTINO = "sin-destino";
const PLUGIN = "claude-switcher";
/** Lo único por lo que una fila fallida no espera nada (cola real del servidor, 2026-11-04). */
const ARCHIVADO = "Thread is archived";
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
 * El juicio, puro. `estado`: { primeraVez: {fila: ms}, vista: {fila: ms}, avisado: {hilo: ms},
 * conLibre: {hilo: ms} }.
 * Devuelve los avisos de esta pasada y el estado siguiente.
 */
export function judge({ filas, health, estado, ahora }) {
  // Las que retiene el plugin y las que fallan por lo que sea: un hook que
  // agota sus intentos deja la fila parada hasta que alguien la vea.
  const vivas = filas.filter((f) => {
    const razon = f.failureReason ?? null;
    if (razon === ARCHIVADO) return false;
    return (
      razon !== null ||
      (f.waitingOn?.kind === "plugin" && f.waitingOn.pluginId === PLUGIN)
    );
  });
  const primeraVez = {};
  const avisado = {};
  const vista = {};
  const conLibre = {};
  const avisos = [];
  // Las que bb no enseña en esta lectura, un rato: siguen con su antigüedad.
  for (const [id, cuando] of Object.entries(estado.vista ?? {}))
    if (ahora - cuando < OLVIDO_MS && estado.primeraVez?.[id] !== undefined) {
      primeraVez[id] = estado.primeraVez[id];
      vista[id] = cuando;
    }
  // Por hilo: tres mensajes del mismo hilo son un aviso, no tres.
  for (const [hilo, cuando] of Object.entries(estado.avisado ?? {}))
    if (ahora - cuando < (hilo === SIN_DESTINO ? REAVISO_SIN_DESTINO_MS : REAVISO_MS))
      avisado[hilo] = cuando;
  const sinDestino = new Map();
  for (const fila of vivas) {
    const desde = estado.primeraVez?.[fila.id] ?? ahora;
    primeraVez[fila.id] = desde;
    vista[fila.id] = ahora;
    const fallida = (fila.failureReason ?? null) !== null;
    const modelo = familia(fila.model);
    const libres = health.cuentas
      .filter((c) => puedeCorrer(c, modelo))
      .map((c) => c.nombre);
    if (!fallida && libres.length > 0) conLibre[fila.threadId] = ahora;
    if (ahora - desde < UMBRAL_MS) continue;
    if (fallida) {
      // Aparte del aviso de retenida: el mismo hilo puede tener una de cada.
      const clave = `${fila.threadId}:fallida`;
      if (avisado[clave] !== undefined) continue;
      avisado[clave] = ahora;
      avisos.push({
        tipo: "fallida",
        clave,
        fila: fila.id,
        hilo: fila.threadId,
        minutos: Math.floor((ahora - desde) / 60_000),
        razon: fila.failureReason,
      });
      continue;
    }
    if (libres.length === 0) {
      if (ahora - desde >= SIN_DESTINO_MS && !sinDestino.has(fila.threadId))
        sinDestino.set(fila.threadId, { hilo: fila.threadId, modelo, desde });
      continue;
    }
    // Una plaza que acaba de soltarse no es un atasco: quien espera vuelve a
    // preguntar en 30 s. Con la cola saturada, una sola foto la vería a menudo.
    if (estado.conLibre?.[fila.threadId] === undefined) continue;
    if (avisado[fila.threadId] !== undefined) continue;
    avisado[fila.threadId] = ahora;
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
  // Sin nadie que lleve ese tiempo, el próximo que llegue no espera las 6
  // horas. Quien lo lleva sigue en el caso aunque bb lo oculte un momento o
  // en esta pasada se vea una plaza suelta.
  if (sinDestino.size === 0) {
    if (!Object.values(primeraVez).some((desde) => ahora - desde >= SIN_DESTINO_MS))
      delete avisado[SIN_DESTINO];
  } else if (avisado[SIN_DESTINO] === undefined) {
    avisado[SIN_DESTINO] = ahora;
    const hilos = [...sinDestino.values()];
    avisos.push({
      tipo: SIN_DESTINO,
      clave: SIN_DESTINO,
      hilo: hilos[0].hilo,
      hilos: hilos.map(({ hilo, modelo }) => ({ hilo, modelo })),
      horas: Math.floor((ahora - Math.min(...hilos.map((h) => h.desde))) / (60 * 60_000)),
    });
  }
  return { avisos, estado: { primeraVez, avisado, vista, conLibre }, retenidas: vivas.length };
}

export function textoAviso(a) {
  if (a.tipo === "fallida")
    return `El mensaje del hilo ${a.hilo} lleva ${a.minutos} min parado; último fallo: ${a.razon}`;
  if (a.tipo === SIN_DESTINO)
    return `${a.hilos.length === 1 ? "1 hilo lleva" : `${a.hilos.length} hilos llevan hasta`} ${a.horas} h retenido${a.hilos.length === 1 ? "" : "s"} sin ninguna cuenta que pueda correrlo: ${a.hilos.map((h) => `${h.hilo} (${h.modelo})`).join(", ")}`;
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
      return (
        await run(binario, args, {
          maxBuffer: 64 * 1024 * 1024,
          timeout: BB_MS,
          killSignal: "SIGKILL",
        })
      ).stdout;
    } catch (error) {
      ultimo = error;
      // Solo se prueba el siguiente si este binario no existe.
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw ultimo;
}

/** Manda un aviso; falla si el plugin de avisos no llega a nadie. */
async function enviar(dir, mensaje) {
  const entrada = join(dir, "canario-cola-aviso.json");
  await writeFile(entrada, JSON.stringify(mensaje));
  const respuesta = JSON.parse(
    await bb([
      "plugin", "rpc", "call", "--json", "--input-file", entrada,
      "push-notifications", "notifications.send",
    ]),
  );
  // Lista vacía: el plugin de avisos dice que no llegó a nadie.
  if (!(respuesta.channels?.length > 0))
    throw new Error("ningún canal lo recibió");
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

const FICHERO_FALLO = "canario-cola-fallo.json";

/** La lectura falló: tras FALLO_MS seguidos lo dice una vez por hora, si bb deja. */
export async function avisarFallo({ dir = process.cwd(), ahora = Date.now(), motivo }) {
  const ruta = join(dir, FICHERO_FALLO);
  const fallo = await leerEstado(ruta);
  const desde = fallo.desde ?? ahora;
  let avisado = fallo.avisado ?? null;
  if (ahora - desde >= FALLO_MS && (avisado === null || ahora - avisado >= REAVISO_MS)) {
    try {
      await enviar(dir, {
        title: "Switcher: el vigilante no ve la cola",
        body: `Lleva ${Math.floor((ahora - desde) / 60_000)} min sin poder mirar: ${motivo}`,
      });
      avisado = ahora;
    } catch (error) {
      console.error(`aviso no entregado: ${error.message}`);
    }
  }
  await writeFile(ruta, JSON.stringify({ desde, avisado }));
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
  // Sin cuentas que juzgar, «0 avisos» con filas retenidas no sería haber mirado.
  if (
    veredicto.retenidas > 0 &&
    (health.cuentas.length === 0 ||
      health.cuentas.some((c) => typeof c.usable !== "boolean"))
  )
    throw new Error("la salud no enseña cuentas con las que juzgar lo retenido");
  await rm(join(dir, FICHERO_FALLO), { force: true });
  let entregado = true;
  for (const aviso of veredicto.avisos) {
    const texto = textoAviso(aviso);
    console.log(`AVISO ${texto}`);
    await appendFile(
      join(dir, "avisos.log"),
      `${new Date(ahora).toISOString()} ${texto}\n`,
    );
    try {
      await enviar(dir, {
        title:
          aviso.tipo === "fallida"
            ? "Switcher: mensaje parado"
            : "Switcher: hilo retenido",
        body: texto,
        threadId: aviso.hilo,
      });
    } catch (error) {
      entregado = false;
      // Sin marcar: se repite en la pasada siguiente.
      delete veredicto.estado.avisado[aviso.clave ?? aviso.hilo];
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

/**
 * Ejecutado y no importado (por los tests). Por un enlace `argv[1]` es el
 * enlace e `import.meta.url` su destino: compararlos sin más sale en verde
 * sin haber mirado.
 */
function esEntrada() {
  if (process.argv[1] === undefined) return true;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return true;
  }
}

if (esEntrada())
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`lectura fallida: ${error.message}`);
      process.exitCode = 1;
      return avisarFallo({ motivo: error.message });
    },
  );
