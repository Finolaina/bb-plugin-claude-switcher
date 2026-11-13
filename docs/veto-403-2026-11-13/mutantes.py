#!/usr/bin/env python3
"""Un fallo de red no veta cuentas (0.2.54, Aitor 2026-11-13: «tengo problemas con el switcher y hay cuota pero
todas esperan team3, fijame un hilo del switcher y podemos pasar hilos fallidos a otras cuentas ultra con cuota»).
Cada pieza nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD, se
ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script. Se niega a
correr (código 3) con el árbol sucio. Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que
docs/culpa-tras-recarga-2026-11-11/mutantes.py."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/veto-403-2026-11-13/mutantes.salida.txt")
S = "server.test.ts"
H = "src/health.test.ts"
SW = "src/switch.test.ts"

# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("red", "una página de Cloudflare se juzga como negativa (la mañana de hoy)", "server.ts",
     "      if (text !== null && isNetworkBlock(text)) {\n        noteBlock(",
     "      if (false) {\n        noteBlock(",
     S, "the morning of 2026-11-13"),
    ("red", "una línea STUCK por bloqueo, no por racha", "server.ts",
     "    if (run !== undefined && now - run.last < NETWORK_STREAK_MS) {",
     "    if (false) {",
     S, "one STUCK line per machine and run of blocks"),
    ("red", "la racha sigue a los 10 min justos (corte exacto)", "server.ts",
     "    if (run !== undefined && now - run.last < NETWORK_STREAK_MS) {",
     "    if (run !== undefined && now - run.last <= NETWORK_STREAK_MS) {",
     S, "one STUCK line per machine and run of blocks"),
    ("red", "sin línea STUCK del bloqueo", "server.ts",
     "        noteBlock(host, event, deps.now());\n", "",
     S, "one STUCK line per machine and run of blocks"),
    ("cortacircuitos", "hacen falta 4 cuentas, no 3", "server.ts",
     "export const REFUSAL_STORM_ACCOUNTS = 3;", "export const REFUSAL_STORM_ACCOUNTS = 4;",
     S, "the third at exactly 5 min opens it"),
    ("cortacircuitos", "ventana estricta: la 3.ª a 5 min justos no abre (corte exacto)", "server.ts",
     ".filter((r) => now - r.at <= REFUSAL_STORM_MS);", ".filter((r) => now - r.at < REFUSAL_STORM_MS);",
     S, "the third at exactly 5 min opens it"),
    ("cortacircuitos", "sin ventana: la 3.ª a 5 min + 1 ms abre", "server.ts",
     ".filter((r) => now - r.at <= REFUSAL_STORM_MS);", ".filter(() => true);",
     S, "the third at 5 min"),
    ("cortacircuitos", "las máquinas se suman", "server.ts",
     "    const recent = (refusalsOn.get(host) ?? []).filter(",
     "    const recent = [...refusalsOn.values()].flat().filter(",
     S, "refusals on two machines are not added together"),
    ("cortacircuitos", "el cuerpo JSON de la API cuenta para la racha", "server.ts",
     "      const counts = !isApiErrorBody(text);", "      const counts = true;",
     S, "three refusals whose text is the API"),
    ("cortacircuitos", "no se levantan los vetos de la racha (Fable no vuelve)", "server.ts",
     "      refusedAt.delete(r.account);\n      lifted.push(r.account);",
     "      lifted.push(r.account);",
     S, "take a Fable turn again at once"),
    ("cortacircuitos", "no se levantan los vetos de la racha (Opus no vuelve)", "server.ts",
     "      refusedAt.delete(r.account);\n      lifted.push(r.account);",
     "      lifted.push(r.account);",
     S, "take an Opus turn again at once"),
    # Quitar el atajo entero de handleFailure ya no muere: markRefused mira la racha
    # abierta (VETO-001) y retiene el fallo igual; el atajo solo cambia los restos
    # (reintento a los 2 min y no en el acto), sin prueba propia. Se muta lo que sí decide.
    ("cortacircuitos", "abierta, una negativa allí no la alarga", "server.ts",
     "      if (counts && stormOpen(host, at)) {\n        storms.get(host)!.last = at;\n",
     "      if (counts && stormOpen(host, at)) {\n",
     S, "VETO-002"),
    ("cortacircuitos", "la 3.ª se juzga y mueve el proyecto", "server.ts",
     "      if (!markRefused(failedOn, now, event, model)) {", "      if (!markRefused(failedOn, now, event, model) && false) {",
     S, "the third at exactly 5 min opens it"),
    ("cortacircuitos", "un turno que acaba bien en esa máquina no cierra la racha", "server.ts",
     "      stormBack(host ?? \"\", since);\n", "",
     S, "closes it; one started before"),
    ("cortacircuitos", "un turno arrancado en el mismo instante en que se abre la racha la cierra (corte exacto)", "server.ts",
     "    if (storm === undefined || since <= storm.opened) return;", "    if (storm === undefined || since < storm.opened) return;",
     S, "closes it; one started before"),
    ("cortacircuitos", "un turno de otra máquina cierra la racha", "server.ts",
     "    const storm = storms.get(host);\n    if (storm === undefined || since <= storm.opened) return;\n    storms.delete(host);",
     "    const storm = [...storms.values()][0];\n    if (storm === undefined || since <= storm.opened) return;\n    storms.clear();",
     S, "closes it; one started before"),
    ("VETO-001", "una racha abierta mientras se juzgaba el fallo no retiene en markRefused", "server.ts",
     "      if (stormOpen(host, now)) {\n        storms.get(host)!.last = now;\n        return false;\n      }\n", "",
     S, "VETO-001"),
    ("VETO-002", "sin tope: la racha sigue abierta mientras lleguen negativas", "server.ts",
     " && now - storm.since <= REFUSAL_STORM_MAX_MS) return true;", ") return true;",
     S, "VETO-002"),
    ("VETO-002", "tope estricto: a los 15 min justos ya cierra (corte exacto)", "server.ts",
     " && now - storm.since <= REFUSAL_STORM_MAX_MS) return true;", " && now - storm.since < REFUSAL_STORM_MAX_MS) return true;",
     S, "VETO-002"),
    ("VETO-002", "red.hasta sin el tope", "server.ts",
     "          until: Math.min(storm.last + REFUSAL_STORM_MS, storm.since + REFUSAL_STORM_MAX_MS),",
     "          until: storm.last + REFUSAL_STORM_MS,",
     S, "still open"),
    ("VETO-003", "el fin de un fallo borra la máquina del siguiente del mismo hilo", "server.ts",
     "      if (seen !== undefined && refusalSeen.get(event.threadId) === seen) refusalSeen.delete(event.threadId);",
     "      refusalSeen.delete(event.threadId);",
     S, "VETO-003"),
    ("VETO-004", "la máquina desconocida cuenta para una racha", "server.ts",
     "    if (seen?.counts !== false && host !== \"\") {", "    if (seen?.counts !== false) {",
     S, "VETO-004"),
    ("VETO-005", "una fila sin hilo cuenta como hilo atascado", "src/historial.ts",
     "  const stuck = o.stuck.filter((r) => r.at >= since && r.thread !== \"\");", "  const stuck = o.stuck.filter((r) => r.at >= since);",
     S, "VETO-005"),
    ("VETO-005", "history --json sin las notas aparte", "server.ts",
     "                      stuck: stuck.filter((r) => r.thread !== \"\"),", "                      stuck,",
     S, "VETO-005"),
    ("R2-001", "una sesión perdida con errorInfo unauthorized cuenta para la racha", "server.ts",
     "      const counts = !isApiErrorBody(text) && !(text !== null && isSessionLoss(text));",
     "      const counts = !isApiErrorBody(text);",
     S, "R2-001"),
    ("R2-003", "unblock no saca la cuenta de las rachas en curso", "server.ts",
     "      const kept = recent.filter((r) => r.account !== name);",
     "      const kept = recent;",
     S, "R2-003"),
    ("límite", "una negativa vuelve a poner marca de límite con el informe guardado del hilo", "server.ts",
     "    if (!stuck && failedOn !== null && !refusal) {", "    if (!stuck && failedOn !== null && !isSessionLost(event)) {",
     S, "a refusal puts no usage limit"),
    ("health", "problema sin el rechazo («sin motivo»)", "src/health.ts",
     "  const refused = marks.rechazos?.find((r) => r.account === a.name);", "  const refused = undefined as { http: number | null; until: number } | undefined;",
     H, "an account set aside by a refusal"),
    ("health", "problema sin la marca de límite", "src/health.ts",
     "  const limit = limits[0];", "  const limit = undefined as { scope: string; until: number } | undefined;",
     H, "an account marked by a usage limit"),
    ("health", "problema sin la sesión perdida", "src/health.ts",
     "  const lost = marks.sinSesion?.find((m) => m.account === a.name);", "  const lost = undefined as { hostName: string; until: number } | undefined;",
     H, "an account without a session on a machine says it"),
    ("health", "una cuenta no usable sin causa conocida vuelve a dar problema null", "src/health.ts",
     "  return a.usable\n    ? null\n", "  return true\n    ? null\n",
     H, "never says"),
    ("health", "health --json sin rechazos", "server.ts",
     "      rechazos: [...refusedAt]", "      rechazos: [...refusedAt].slice(0, 0)",
     S, "sets the account aside for 6 h, as before, and health says why"),
    ("health", "health --json sin red", "server.ts",
     "      red: networkRuns(now),", "      red: [],",
     S, "the third at exactly 5 min opens it"),
    ("unblock", "unblock no vuelve a preguntar a los que esperan", "server.ts",
     "    askWaitingAgain(`${name} was unblocked`);\n", "",
     S, "a turn that waited for a Team seat starts at once"),
    ("unblock", "unblock no quita el veto", "server.ts",
     "    refusedAt.delete(name);\n    refusedHttp.delete(name);\n", "",
     S, "a turn that waited for a Team seat starts at once"),
    ("unblock", "unblock no quita las marcas de límite", "server.ts",
     "    limitedAt.delete(name);\n", "",
     S, "lifts every usage limit"),
    ("unblock", "unblock no quita la sesión perdida", "server.ts",
     "    sessionLostAt.delete(name);\n", "",
     S, "lifts every usage limit"),
    ("api", "isApiErrorBody no reconoce el cuerpo JSON", "src/switch.ts",
     '/"type"\\s*:\\s*"error"/.test(text)', '/"type":"never"/.test(text)',
     SW, "tells the API"),
]


def exigir_arbol_limpio(repo: str) -> None:
    """Se niega a correr si el repo tiene cambios sin guardar: estas pruebas mutan ficheros (pisarian trabajo ajeno)."""
    r = subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.strip():
        print("NO CORRO: el arbol de trabajo de " + repo + " no esta limpio (git status --porcelain no esta vacio).")
        print("Guarda o descarta los cambios antes, o corre estas pruebas desde un worktree limpio.")
        sys.exit(3)


def main() -> int:
    exigir_arbol_limpio(REPO)
    head = subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"], text=True).strip()
    trabajo = tempfile.mkdtemp(prefix="mutantes-")
    clon = os.path.join(trabajo, "clon")
    subprocess.check_call(["git", "clone", "-q", REPO, clon])
    subprocess.check_call(["git", "-C", clon, "checkout", "-q", head])
    os.symlink(os.path.join(REPO, "node_modules"), os.path.join(clon, "node_modules"))
    lineas = [f"HEAD {head}"]
    fallos = 0
    for camino, nombre, fichero, viejo, nuevo, tests, filtro in M:
        ruta = os.path.join(clon, fichero)
        original = open(ruta).read()
        if original.count(viejo) != 1:
            lineas.append(f"NO APLICA  {camino} · {nombre} (coincidencias: {original.count(viejo)})")
            fallos += 1
            print(lineas[-1], flush=True)
            continue
        open(ruta, "w").write(original.replace(viejo, nuevo))
        orden = ["npx", "vitest", "run", tests]
        if filtro:
            orden += ["-t", filtro]
        r = subprocess.run(orden, cwd=clon, capture_output=True, text=True)
        resumen = next((l.strip() for l in r.stdout.splitlines() if "Tests " in l), "sin resumen")
        if r.returncode != 0 and "failed" in resumen:
            lineas.append(f"MUERE      {camino} · {nombre} · {tests} {filtro!r} · {resumen}")
        else:
            lineas.append(f"VIVE       {camino} · {nombre} · {tests} {filtro!r} · {resumen}")
            fallos += 1
        print(lineas[-1], flush=True)
        open(ruta, "w").write(original)
    r = subprocess.run(["npx", "vitest", "run"], cwd=clon, capture_output=True, text=True)
    resumen = next((l.strip() for l in r.stdout.splitlines() if "Tests " in l), "sin resumen")
    lineas.append(f"SIN MUTAR  rc={r.returncode} · {resumen}")
    print(lineas[-1], flush=True)
    if r.returncode != 0:
        fallos += 1
    lineas.append(f"mutantes: {len(M)}, sin morir o sin aplicar: {fallos}")
    open(SALIDA, "w").write("\n".join(lineas) + "\n")
    print(lineas[-1])
    shutil.rmtree(trabajo)
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
