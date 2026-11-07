#!/usr/bin/env node
// Tic a las Team: cada 5 minutos, en el servidor de bb (una `bb automation`),
// manda un «ok» con Haiku a cada cuenta Team cuya sesión de 5 horas ya se
// renovó y nadie ha vuelto a abrir. La ventana empieza a contar con el primer
// mensaje: abierta cuanto antes, se renueva antes cuando luego le damos caña
// (Aitor, 2026-11-07: «dar un tic a todas las cuentas team cuando su nueva
// sesión se pueda empezar … así empezaría a contar cuanto antes»).
//
// Medido antes de construirlo (2026-11-07, cuenta nuestra): en 2 días las 5
// Team pasaron ~20 h sin ventana entre una sesión y la siguiente; un «ok» con
// Haiku desde team3 abrió su ventana (vuelve null → 17:40) con la sesión al
// 0 % y 0,0006 $ de coste de lista.
//
// No usa la lógica del plugin ni lo cambia: lee `bb claude-switcher health
// --json` (la ventana de cada cuenta) y `list --json` (su carpeta y la hora de
// su lectura). Una lectura o un tic que falla sale con código 1, visible en
// `bb automation runs`.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Tras un tic, no se repite antes de esto aunque la lectura siga sin ventana. */
export const RETIC_MS = 30 * 60_000;
/** Una lectura de uso más vieja no sirve para saber si hay ventana abierta. */
export const VIEJO_MS = 30 * 60_000;
/** Una pasada no empieza tics nuevos pasado este rato: los que queden, en la siguiente. */
export const PASADA_MS = Number(process.env.TIC_PASADA_MS ?? 10 * 60_000);
/** Un cerrojo más viejo es de una pasada muerta: PASADA_MS más un último tic de CLAUDE_MS caben. */
export const CERROJO_MS = 15 * 60_000;
const BB_MS = 60_000;
const CLAUDE_MS = 120_000;
/**
 * Fuera del entorno de claude: lo que lo haría hijo de otra sesión y toda
 * credencial que gane al login guardado en la carpeta de la cuenta (con ellas
 * el tic iría a otra cuenta y diría «ok»; Codex r1). Además, toda variable
 * ANTHROPIC_*: claves, URL y los alias de modelo (`ANTHROPIC_DEFAULT_HAIKU_MODEL`
 * cambia lo que es «haiku» aunque se pase `--model haiku`; Codex r2).
 */
const FUERA = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
export const ARGS = [
  "-p", "Responde solo: ok",
  "--model", "haiku",
  "--tools", "",
  "--strict-mcp-config",
  "--setting-sources", "project",
  "--no-session-persistence",
  "--output-format", "json",
];

const pct = (ventana) => ventana?.pctExacto ?? ventana?.pct ?? 0;

/**
 * El juicio, puro. `lista`: {cuenta: {configDir, observedAt}} de `list --json`
 * (configDir null = la cuenta por defecto, sin CLAUDE_CONFIG_DIR);
 * `estado`: {ultimo: {cuenta: ms del último tic bueno}}.
 * Devuelve las Team que reciben tic ahora y las que lo merecían pero no se pueden juzgar.
 */
export function elegir({ health, lista, estado, ahora }) {
  if (!Array.isArray(health?.cuentas) || typeof health.medido !== "string")
    throw new Error("la salud no tiene la forma esperada");
  const medido = Date.parse(health.medido);
  if (!(ahora - medido <= VIEJO_MS))
    throw new Error(`lectura de uso vieja (${health.medido})`);
  const tics = [];
  const saltadas = [];
  for (const c of health.cuentas) {
    if (c.plan !== "team" || c.usable !== true) continue;
    if (pct(c.semana) >= 100) continue;
    const vuelve = c.sesion?.vuelve ?? null;
    if (vuelve !== null && Date.parse(vuelve) > ahora) continue;
    const cuenta = lista[c.nombre];
    if (cuenta === undefined) {
      saltadas.push({ cuenta: c.nombre, motivo: "sin carpeta" });
      continue;
    }
    // `medido` es la lectura más nueva de todas: la de esta cuenta puede ser vieja (Codex r1).
    const leida = cuenta.observedAt;
    if (typeof leida !== "number" || ahora - leida > VIEJO_MS) {
      saltadas.push({ cuenta: c.nombre, motivo: "lectura vieja" });
      continue;
    }
    const anterior = estado.ultimo?.[c.nombre];
    // Sin ventana en una lectura de antes del tic no dice nada del tic.
    if (anterior !== undefined && (leida <= anterior || ahora - anterior < RETIC_MS)) continue;
    tics.push({ cuenta: c.nombre, carpeta: cuenta.configDir ?? null });
  }
  return { tics, saltadas };
}

const run = promisify(execFile);

async function bb(args) {
  const candidatos = [process.env.BB_CLI, "bb", join(homedir(), ".local/bin/bb")].filter(Boolean);
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
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw ultimo;
}

/** Un «ok» con Haiku en la cuenta: sin herramientas, sin MCP, sin ajustes de usuario ni sesión guardada. */
async function tic({ carpeta }, vacia) {
  const env = { ...process.env };
  for (const v of Object.keys(env)) if (FUERA.includes(v) || v.startsWith("ANTHROPIC_")) delete env[v];
  if (carpeta !== null) env.CLAUDE_CONFIG_DIR = carpeta;
  let stdout;
  try {
    ({ stdout } = await run(process.env.TIC_CLAUDE ?? "claude", ARGS, {
      cwd: vacia,
      env,
      timeout: CLAUDE_MS,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    const dicho = (error.stdout ?? "").trim().slice(0, 200);
    throw new Error(dicho || error.message);
  }
  const r = JSON.parse(stdout);
  if (r.is_error !== false) throw new Error(String(r.result ?? "is_error").slice(0, 200));
}

async function leerEstado(ruta) {
  try {
    return JSON.parse(await readFile(ruta, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`estado ilegible, empieza de cero: ${error.message}`);
    return {};
  }
}

/** Una sola pasada a la vez: dos solapadas darían dos tics a la misma cuenta (Codex r1). */
export async function cerrar(ruta, ahora, reintento = false) {
  try {
    await (await open(ruta, "wx")).close();
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let edad;
  try {
    edad = ahora - (await stat(ruta)).mtimeMs;
  } catch (error) {
    // Se acaba de soltar: lo intenta una vez más.
    if (error.code === "ENOENT" && !reintento) return cerrar(ruta, ahora, true);
    throw error;
  }
  if (edad < CERROJO_MS || reintento) return false;
  // ponytail: dos pasadas que vean a la vez el mismo cerrojo muerto pueden
  // quedárselo las dos (el borrado de una puede llevarse el nuevo de la otra;
  // Codex r2). Solo pasa si una pasada murió a medias y otra lanzada a mano
  // coincide con la programada; su coste es un tic de más (0,0006 $). Mejora:
  // un token en el cerrojo que su dueño compruebe antes de cada tic.
  console.error("cerrojo de una pasada muerta: se quita");
  await rm(ruta, { force: true });
  return cerrar(ruta, ahora, true);
}

export async function main({ dir = process.cwd(), ahora = Date.now() } = {}) {
  // La lista antes que la salud: así la hora de la lectura de cada cuenta nunca
  // es más nueva que la ventana que enseña la salud (Codex r2).
  const list = JSON.parse(await bb(["claude-switcher", "list", "--json"]));
  const health = JSON.parse(await bb(["claude-switcher", "health", "--json"]));
  if (!Array.isArray(list.accounts)) throw new Error("la lista no tiene la forma esperada");
  const lista = Object.fromEntries(
    list.accounts.map((a) => [a.name, { configDir: a.configDir, observedAt: a.observedAt }]),
  );
  const cerrojo = join(dir, "tic-team.lock");
  if (!(await cerrar(cerrojo, ahora))) {
    console.log("otra pasada en marcha: esta no hace nada");
    return 0;
  }
  try {
    const ruta = join(dir, "tic-team-estado.json");
    const estado = await leerEstado(ruta);
    const { tics, saltadas } = elegir({ health, lista, estado, ahora });
    // En /tmp: claude busca CLAUDE.md hacia arriba desde su carpeta, y la del
    // servidor de bb cuelga de la casa, que tiene uno (Codex r1).
    const vacia = join(tmpdir(), "tic-team-vacia");
    await mkdir(vacia, { recursive: true });
    const ultimo = { ...estado.ultimo };
    let fallos = 0;
    let buenos = 0;
    const inicio = Date.now();
    for (const [i, t] of tics.entries()) {
      if (i > 0 && Date.now() - inicio >= PASADA_MS) {
        console.error(`pasada de más de ${PASADA_MS / 60_000} min: el resto, en la siguiente`);
        break;
      }
      let linea;
      try {
        await tic(t, vacia);
        ultimo[t.cuenta] = Date.now();
        // Guardado tic a tic: un fallo después no hace repetir los ya dados.
        const temporal = `${ruta}.${process.pid}.tmp`;
        await writeFile(temporal, JSON.stringify({ ultimo }));
        await rename(temporal, ruta);
        buenos += 1;
        linea = `${t.cuenta} ok`;
      } catch (error) {
        fallos += 1;
        linea = `${t.cuenta} FALLO ${error.message}`;
      }
      console.log(`tic ${linea}`);
      try {
        await appendFile(join(dir, "tic-team.log"), `${new Date().toISOString()} ${linea}\n`);
      } catch (error) {
        fallos += 1;
        console.error(`registro no escrito: ${error.message}`);
      }
    }
    for (const s of saltadas) console.error(`sin tic ${s.cuenta}: ${s.motivo}`);
    console.log(`${buenos} ${buenos === 1 ? "tic" : "tics"}, ${fallos} fallos`);
    return fallos > 0 || saltadas.length > 0 ? 1 : 0;
  } finally {
    await rm(cerrojo, { force: true });
  }
}

/** Ejecutado y no importado (por los tests); por un enlace, `argv[1]` es el enlace. */
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
    },
  );
