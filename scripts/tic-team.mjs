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
// --json` (la ventana de cada cuenta) y `list --json` (su carpeta). Una
// lectura o un tic que falla sale con código 1, visible en `bb automation runs`.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Tras un tic, la lectura de uso puede tardar en verlo: no se repite antes de esto. */
export const RETIC_MS = 30 * 60_000;
/** Una lectura de uso más vieja no sirve para saber si hay ventana abierta. */
export const VIEJO_MS = 30 * 60_000;
const BB_MS = 60_000;
const CLAUDE_MS = 120_000;
/** Variables de la sesión que lanza el script: con ellas claude se cree hijo de otra sesión. */
const DE_LA_SESION = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
];

const pct = (ventana) => ventana?.pctExacto ?? ventana?.pct ?? 0;

/**
 * El juicio, puro. `carpetas`: {cuenta: CLAUDE_CONFIG_DIR}; `estado`: {ultimo: {cuenta: ms}}.
 * Devuelve las Team que reciben tic ahora y las que lo merecían pero no pueden.
 */
export function elegir({ health, carpetas, estado, ahora }) {
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
    const anterior = estado.ultimo?.[c.nombre];
    if (anterior !== undefined && ahora - anterior < RETIC_MS) continue;
    const carpeta = carpetas[c.nombre];
    if (!carpeta) {
      saltadas.push({ cuenta: c.nombre, motivo: "sin carpeta" });
      continue;
    }
    tics.push({ cuenta: c.nombre, carpeta });
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
  const env = { ...process.env, CLAUDE_CONFIG_DIR: carpeta };
  for (const v of DE_LA_SESION) if (v !== "CLAUDE_CONFIG_DIR") delete env[v];
  const args = [
    "-p", "Responde solo: ok",
    "--model", "haiku",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--no-session-persistence",
    "--output-format", "json",
  ];
  let stdout;
  try {
    ({ stdout } = await run(process.env.TIC_CLAUDE ?? "claude", args, {
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

export async function main({ dir = process.cwd(), ahora = Date.now() } = {}) {
  const health = JSON.parse(await bb(["claude-switcher", "health", "--json"]));
  const list = JSON.parse(await bb(["claude-switcher", "list", "--json"]));
  if (!Array.isArray(list.accounts)) throw new Error("la lista no tiene la forma esperada");
  const carpetas = Object.fromEntries(list.accounts.map((a) => [a.name, a.configDir]));
  const ruta = join(dir, "tic-team-estado.json");
  const estado = await leerEstado(ruta);
  const { tics, saltadas } = elegir({ health, carpetas, estado, ahora });
  // Carpeta vacía: claude no encuentra ahí ningún CLAUDE.md ni ajustes de proyecto.
  const vacia = join(dir, "tic-team-vacia");
  await mkdir(vacia, { recursive: true });
  const ultimo = { ...estado.ultimo };
  let fallos = 0;
  for (const t of tics) {
    let linea;
    try {
      await tic(t, vacia);
      ultimo[t.cuenta] = ahora;
      linea = `${t.cuenta} ok`;
    } catch (error) {
      fallos += 1;
      linea = `${t.cuenta} FALLO ${error.message}`;
    }
    console.log(`tic ${linea}`);
    await appendFile(join(dir, "tic-team.log"), `${new Date(ahora).toISOString()} ${linea}\n`);
  }
  for (const s of saltadas) console.error(`sin tic ${s.cuenta}: ${s.motivo}`);
  const temporal = `${ruta}.tmp`;
  await writeFile(temporal, JSON.stringify({ ultimo }));
  await rename(temporal, ruta);
  console.log(`${tics.length - fallos} ${tics.length - fallos === 1 ? "tic" : "tics"}, ${fallos} fallos`);
  return fallos > 0 || saltadas.length > 0 ? 1 : 0;
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
