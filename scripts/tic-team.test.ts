import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CERROJO_MS, RETIC_MS, VIEJO_MS, elegir } from "./tic-team.mjs";

const NOW = Date.parse("2026-11-07T12:41:00+01:00");
const MEDIDO = "2026-11-07T12:36:00+01:00";
const LEIDA = Date.parse(MEDIDO);
const team = (nombre: string, over: Record<string, unknown> = {}) => ({
  nombre,
  plan: "team",
  cincoHoras: true,
  usable: true,
  sesion: { pct: 0, pctExacto: 0, vuelve: null },
  semana: { pct: 40, pctExacto: 40, vuelve: "2026-11-12T12:00:00+01:00" },
  ...over,
});
const LISTA = Object.fromEntries(
  ["team1", "team2", "team3", "ultra1"].map((n) => [
    n,
    { configDir: `/cuentas/${n}`, observedAt: LEIDA },
  ]),
);
const decide = (
  cuentas: unknown[],
  { estado = {}, ahora = NOW, medido = MEDIDO, lista = LISTA } = {},
) => elegir({ health: { medido, cuentas }, lista, estado, ahora });
const elige = (cuentas: unknown[], opciones = {}) =>
  decide(cuentas, opciones).tics.map((t: { cuenta: string }) => t.cuenta);

describe("elegir", () => {
  it("las 12:36 del 2026-11-07 reconstruidas: tic a las Team sin ventana, no a las que la tienen abierta", () => {
    expect(
      elige([
        team("team1"),
        team("team2", {
          sesion: { pct: 0, pctExacto: 0, vuelve: "2026-11-07T17:10:00+01:00" },
        }),
        team("team3"),
      ]),
    ).toEqual(["team1", "team3"]);
  });

  it("una ventana que ya se renovó aunque la lectura no lo sepa recibe tic; un minuto antes, no", () => {
    const vuelve = (iso: string) =>
      team("team1", { sesion: { pct: 100, pctExacto: 100, vuelve: iso } });
    expect(elige([vuelve("2026-11-07T12:41:00+01:00")])).toEqual(["team1"]);
    expect(elige([vuelve("2026-11-07T12:42:00+01:00")])).toEqual([]);
  });

  it("solo Team: una Max con ventana de 5 h y una Ultra, sin ventana abierta, no reciben tic", () => {
    expect(elige([team("ultra1", { plan: "max" })])).toEqual([]);
    expect(
      elige([team("ultra1", { plan: "ultra", cincoHoras: false })]),
    ).toEqual([]);
  });

  it("una Team con la semanal agotada no recibe tic; al 99,9 % sí", () => {
    const semana = (p: number) =>
      team("team1", { semana: { pct: p, pctExacto: p, vuelve: null } });
    expect(elige([semana(100)])).toEqual([]);
    expect(elige([semana(99.9)])).toEqual(["team1"]);
  });

  it("una Team que no se puede usar (sin login, error) no recibe tic", () => {
    expect(
      elige([team("team1", { usable: false, problema: "sin login" })]),
    ).toEqual([]);
  });

  it("tras un tic, no repite hasta que una lectura POSTERIOR al tic siga sin ventana y pasen RETIC_MS", () => {
    const tras = (anterior: number, leida: number) =>
      elige([team("team1")], {
        estado: { ultimo: { team1: anterior } },
        lista: { team1: { configDir: "/cuentas/team1", observedAt: leida } },
      });
    // Lectura posterior al tic, pero aún dentro de RETIC_MS: no.
    expect(tras(NOW - RETIC_MS + 1, NOW - 1000)).toEqual([]);
    // Pasado RETIC_MS, con una lectura de después del tic: sí.
    expect(tras(NOW - RETIC_MS, NOW - RETIC_MS + 1)).toEqual(["team1"]);
    // Pasado RETIC_MS, pero la lectura es de antes del tic (o del mismo instante): no.
    expect(tras(NOW - RETIC_MS, NOW - RETIC_MS)).toEqual([]);
  });

  it("la cuenta por defecto (configDir null) recibe tic sin carpeta propia", () => {
    expect(
      decide([team("team1")], {
        lista: { team1: { configDir: null, observedAt: LEIDA } },
      }).tics,
    ).toEqual([{ cuenta: "team1", carpeta: null }]);
  });

  it("una Team que no sale en la lista no recibe tic y sale como saltada", () => {
    const r = decide([team("team9")]);
    expect(r.tics).toEqual([]);
    expect(r.saltadas).toEqual([{ cuenta: "team9", motivo: "sin carpeta" }]);
  });

  it("la lectura de ESA cuenta vieja no decide, aunque otras estén al día", () => {
    const lista = (leida: number | null) => ({
      team1: { configDir: "/cuentas/team1", observedAt: leida },
    });
    expect(
      decide([team("team1")], { lista: lista(NOW - VIEJO_MS - 1) }),
    ).toEqual({
      tics: [],
      saltadas: [{ cuenta: "team1", motivo: "lectura vieja" }],
    });
    expect(
      decide([team("team1")], { lista: lista(null) }).saltadas,
    ).toHaveLength(1);
    expect(elige([team("team1")], { lista: lista(NOW - VIEJO_MS) })).toEqual([
      "team1",
    ]);
  });

  it("una lectura de uso global vieja no decide nada: falla", () => {
    const viejo = new Date(NOW - VIEJO_MS - 1).toISOString();
    expect(() => elige([team("team1")], { medido: viejo })).toThrow(/vieja/);
    expect(
      elige([team("team1")], {
        medido: new Date(NOW - VIEJO_MS).toISOString(),
      }),
    ).toEqual(["team1"]);
  });

  it("una salud sin la forma esperada falla en vez de decir «nada que hacer»", () => {
    expect(() =>
      elegir({ health: { medido: MEDIDO }, lista: {}, estado: {}, ahora: NOW }),
    ).toThrow(/forma/);
  });
});

const SCRIPT = fileURLToPath(new URL("./tic-team.mjs", import.meta.url));

describe("tic-team.mjs ejecutado", () => {
  /**
   * `claude`: cuerpo de un claude de mentira. Cada llamada deja en llamadas.txt
   * un bloque: carpeta, variables que no deben llegar, carpeta de trabajo y un argumento por línea.
   */
  async function preparar(
    claude: string,
    configDir: string | null = "/cuentas/team1",
  ) {
    const dir = await mkdtemp(join(tmpdir(), "tic-team-"));
    const ahora = Date.now();
    const health = JSON.stringify({
      medido: new Date(ahora).toISOString(),
      cuentas: [
        team("team1"),
        team("team2", {
          sesion: {
            pct: 3,
            pctExacto: 3,
            vuelve: new Date(ahora + 3_600_000).toISOString(),
          },
        }),
      ],
    });
    const list = JSON.stringify({
      accounts: [
        { name: "team1", configDir, observedAt: ahora },
        { name: "team2", configDir: "/cuentas/team2", observedAt: ahora },
      ],
    });
    await writeFile(join(dir, "health.json"), health);
    await writeFile(join(dir, "list.json"), list);
    const bb = join(dir, "bb-falso");
    await writeFile(
      bb,
      `#!/bin/sh\ncase "$2" in health) cat "${dir}/health.json";; list) cat "${dir}/list.json";; *) exit 9;; esac\n`,
    );
    const cl = join(dir, "claude-falso");
    await writeFile(
      cl,
      [
        "#!/bin/sh",
        `{ echo "---"; echo "\${CLAUDE_CONFIG_DIR-sin}"; echo "\${CLAUDECODE-sin}\${CLAUDE_CODE_OAUTH_TOKEN-sin}\${ANTHROPIC_AUTH_TOKEN-sin}\${ANTHROPIC_API_KEY-sin}"; pwd; printf '[%s]\\n' "$@"; } >> "${dir}/llamadas.txt"`,
        claude,
      ].join("\n"),
    );
    await chmod(bb, 0o755);
    await chmod(cl, 0o755);
    const correr = async () => {
      try {
        const r = await promisify(execFile)(process.execPath, [SCRIPT], {
          cwd: dir,
          env: {
            ...process.env,
            BB_CLI: bb,
            TIC_CLAUDE: cl,
            CLAUDECODE: "1",
            CLAUDE_CONFIG_DIR: "/cuenta/de-quien-lo-lanza",
            CLAUDE_CODE_OAUTH_TOKEN: "otra",
            ANTHROPIC_AUTH_TOKEN: "otra",
            ANTHROPIC_API_KEY: "otra",
          },
        });
        return { code: 0, stdout: r.stdout };
      } catch (e) {
        const err = e as { code: number; stdout: string };
        return { code: err.code, stdout: err.stdout };
      }
    };
    const llamadas = async () => {
      let texto = "";
      try {
        texto = await readFile(join(dir, "llamadas.txt"), "utf8");
      } catch {
        return [];
      }
      return texto
        .split("---\n")
        .filter(Boolean)
        .map((b) => {
          const [carpeta, credenciales, cwd, ...args] = b.trim().split("\n");
          return {
            carpeta,
            credenciales,
            cwd,
            args: args.map((a) => a.slice(1, -1)),
          };
        });
    };
    const log = () => readFile(join(dir, "tic-team.log"), "utf8");
    return { dir, correr, llamadas, log };
  }
  const OK = `echo '{"is_error":false,"result":"ok"}'`;

  it("da el tic solo a la Team sin ventana y no lo repite en la pasada siguiente", async () => {
    const { correr, llamadas, log } = await preparar(OK);
    const primera = await correr();
    expect(primera.code).toBe(0);
    expect(primera.stdout).toMatch(/1 tic, 0 fallos/);
    expect(await log()).toMatch(/team1 ok/);
    expect(await log()).not.toMatch(/team2/);
    const segunda = await correr();
    expect(segunda.code).toBe(0);
    expect(segunda.stdout).toMatch(/0 tics/);
    expect(await llamadas()).toHaveLength(1);
  });

  it("lanza claude en la carpeta de la cuenta, con Haiku, sin herramientas, fuera del repo y sin ninguna credencial de quien lo lanza", async () => {
    const { dir, correr, llamadas } = await preparar(OK);
    expect((await correr()).code).toBe(0);
    const [l] = await llamadas();
    expect(l.carpeta).toBe("/cuentas/team1");
    expect(l.credenciales).toBe("sinsinsinsin");
    expect(l.cwd).toBe(join(tmpdir(), "tic-team-vacia"));
    expect(l.cwd.startsWith(dir)).toBe(false);
    expect(l.args).toEqual([
      "-p",
      "Responde solo: ok",
      "--model",
      "haiku",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "project",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
  });

  it("la cuenta por defecto recibe el tic sin CLAUDE_CONFIG_DIR, tampoco el de quien lo lanza", async () => {
    const { correr, llamadas } = await preparar(OK, null);
    expect((await correr()).code).toBe(0);
    expect((await llamadas())[0].carpeta).toBe("sin");
  });

  it("un tic que falla sale con código 1 y se reintenta en la pasada siguiente", async () => {
    const { correr, llamadas, log } = await preparar(
      `echo '{"is_error":true,"result":"Not logged in"}'; exit 1`,
    );
    expect((await correr()).code).toBe(1);
    expect(await log()).toMatch(/team1 FALLO/);
    expect((await correr()).code).toBe(1);
    expect(await llamadas()).toHaveLength(2);
  });

  it("si claude acaba con código 0 pero dice is_error, cuenta como fallo", async () => {
    const { correr } = await preparar(
      `echo '{"is_error":true,"result":"limit"}'`,
    );
    expect((await correr()).code).toBe(1);
  });

  it("con otra pasada en marcha no da ningún tic; con un cerrojo de una pasada muerta, sí", async () => {
    const { dir, correr, llamadas } = await preparar(OK);
    const cerrojo = join(dir, "tic-team.lock");
    await writeFile(cerrojo, "");
    const r = await correr();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/otra pasada en marcha/);
    expect(await llamadas()).toHaveLength(0);
    const muerto = (Date.now() - CERROJO_MS - 60_000) / 1000;
    await utimes(cerrojo, muerto, muerto);
    expect((await correr()).code).toBe(0);
    expect(await llamadas()).toHaveLength(1);
  });

  it("si el registro no se puede escribir, el tic dado queda guardado y no se repite", async () => {
    const { dir, correr, llamadas } = await preparar(OK);
    await mkdir(join(dir, "tic-team.log"));
    expect((await correr()).code).toBe(1);
    // La segunda no da tic (ya guardado) y no tiene nada que registrar.
    expect((await correr()).stdout).toMatch(/0 tics, 0 fallos/);
    expect(await llamadas()).toHaveLength(1);
  });
});
