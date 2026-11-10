#!/usr/bin/env python3
"""Sesión perdida en una máquina (0.2.51, Aitor 2026-11-10: «no han cambiado de cuentas»).
Cada pieza nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/opus-ultra-sin-fable-2026-11-06/mutantes.py."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/sin-login-2026-11-10/mutantes.salida.txt")
S = "server.test.ts"
SW = "src/switch.test.ts"

# Sin la marca en un camino: el camino no ve ninguna marca mientras haya una de sesión.
SIN = "(sessionLostAt.size > 0 ? null : limitedUntil(name, model, projectId))"
# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("D1 texto", "sin la detección del texto (nunca casa)", "src/switch.ts",
     "const SESSION_LOSS =\n  /not logged in|", "const SESSION_LOSS =\n  /(?!)/i || /not logged in|",
     SW, "is told by its text"),
    ("D1 texto", "sin la detección del texto (servidor: el fallo se ignora)", "src/switch.ts",
     "const SESSION_LOSS =\n  /not logged in|", "const SESSION_LOSS =\n  /(?!)/i || /not logged in|",
     S, "moves the project off the account and retries the turn at once"),
    ("D1 texto", "un 401 en cualquier sitio (casa 4010 y messages.401 de un 400; code-reviewer r1, low 4)", "src/switch.ts",
     "|(?:api error:|http|status) 401\\b|\\b401 unauthorized|", "|401|",
     SW, "is not a limit, a crash nor any other text"),
    ("D1 texto", "un 401 sin ancla de estado (casa messages.401 de un 400; code-reviewer r1, low 4)", "src/switch.ts",
     "|(?:api error:|http|status) 401\\b|\\b401 unauthorized|", "|\\b401\\b|",
     SW, "is not a limit, a crash nor any other text"),
    ("D2 fallo", "en el intento 5 y pasado el fallo se ignora (code-reviewer r1, high)", "server.ts",
     "      (declined === \"not-rate-limit\" || declined === \"attempts-exhausted\") &&\n",
     "      declined === \"not-rate-limit\" &&\n",
     S, "code-reviewer r1, high"),
    ("D2 fallo", "el fallo sin errorInfo no se lee del registro", "server.ts",
     "      if ((await sessionLossText(event.threadId, event.requestId)) === null) {",
     "      if (true) {",
     S, "moves the project off the account and retries the turn at once"),
    ("D3 rescate", "el hilo en error no se lee como sesión perdida", "server.ts",
     "      errorInfo = SESSION_LOST_INFO;", "      void SESSION_LOST_INFO;",
     S, "left in error by a login past its time limit"),
    ("H1 máquina", "sin la dimensión de máquina (la marca vale en todas)", "server.ts",
     "      if (host !== \"\" && hosts !== null && !hosts.has(host)) continue;\n", "",
     S, "leaves the account to a project with no thread on that machine"),
    ("H1 máquina", "la máquina del hilo no se lee (\"\" vale en todas)", "server.ts",
     "    return environments?.find((e) => e.id === thread.environmentId)?.hostId ?? \"\";",
     "    void environments;\n    return \"\";",
     S, "leaves the account to a project with no thread on that machine"),
    ("H1 máquina", "sin releer la máquina antes de marcar una desconocida (code-reviewer r1, low 1)", "server.ts",
     "      if (host === \"\" && thread.environmentId !== null) host = await threadHost(thread);\n", "",
     S, "reads the thread's machine again"),
    ("H1 máquina", "además una marca de límite de toda la cuenta", "server.ts",
     "    if (!stuck && failedOn !== null && !isSessionLost(event))", "    if (!stuck && failedOn !== null)",
     S, "leaves the account to a project with no thread on that machine"),
    ("H1 máquina", "sin leer las máquinas de los demás proyectos al marcar", "server.ts",
     "      void readAllHosts();\n", "",
     S, "leaves the account to a project with no thread on that machine"),
    ("M1 marca", "el fallo no marca la cuenta", "server.ts",
     "      marks.set(host, now);\n", "",
     S, "keeps the account from the turns of another project"),
    ("C1 colocación", "sin la marca en la colocación antes del turno (placementOf)", "server.ts",
     "      // turn is judged on its numbers (see the judge).\n      limitedUntil: (name: string) => limitedUntil(name, model, projectId),",
     "      // turn is judged on its numbers (see the judge).\n      limitedUntil: (name: string) => " + SIN + ",",
     S, "keeps the account from the turns of another project"),
    ("C2 plaza llena", "sin la marca en la colocación antes del turno: mover por plaza (crowded)", "server.ts",
     "      // turn is judged on its numbers (see the judge).\n      limitedUntil: (name: string) => limitedUntil(name, model, projectId),",
     "      // turn is judged on its numbers (see the judge).\n      limitedUntil: (name: string) => " + SIN + ",",
     S, "crowded, the path of 2026-11-10"),
    ("C3 proyecto nuevo", "sin la marca en placeProject", "server.ts",
     "      limitedUntil: (name: string) => sessionLostOn(name, projectId)?.until ?? null,\n", "",
     S, "placeProject"),
    ("C4 rescate", "el rescate del refresco no ve la cuenta sin sesión (stranded)", "server.ts",
     "    // No session there on one of the project's machines (sin-login 2026-11-10).\n    const lost = sessionLostOn(name, projectId);\n    if (lost !== null) return `sin sesión en ${hostLabel(lost.host)}`;\n"
     "    // A mark standing for the model: out whatever its read says, as in the\n    // placement (Astra r8 medium 1).\n    const marked = limitedUntil(name, model, projectId);",
     "    // A mark standing for the model: out whatever its read says, as in the\n    // placement (Astra r8 medium 1).\n    const marked = (sessionLostAt.size > 0 ? null : limitedUntil(name, model, projectId));",
     S, "rescueStranded"),
    ("C4 rescate", "sin la marca en la colocación del rescate", "server.ts",
     "      // Nor to an account whose mark stands for the model (Astra r8 medium 1).\n      limitedUntil: (name: string) => limitedUntil(name, model, projectId),",
     "      // Nor to an account whose mark stands for the model (Astra r8 medium 1).\n      limitedUntil: (name: string) => " + SIN + ",",
     S, "rescueStranded"),
    ("C5 cambio anticipado", "sin la marca en aheadTargets (moveAhead)", "server.ts",
     "      if (sessionLostOn(usage.name, projectId) !== null) return false;\n", "",
     S, "moveAhead"),
    ("C6 espera adelantada", "sin la marca en moveUpWait", "server.ts",
     "      limitedUntil(fromName, model, projectId) === null &&\n",
     "      (sessionLostAt.size > 0 || limitedUntil(fromName, model, projectId) === null) &&\n",
     S, "moveUpWait"),
    ("C7 juicio", "el juicio de un hilo en error no bloquea la cuenta sin sesión", "server.ts",
     "      accounts: sessionBlocked(measuredAccounts(model), projectId),",
     "      accounts: measuredAccounts(model),",
     S, "does not retry a thread left in error on the account"),
    ("T1 tope", "sin el tope (la marca no caduca)", "server.ts",
     "      if (now >= until) {\n        marks.delete(host);", "      if (false) {\n        marks.delete(host);",
     S, "ms after the failure"),
    ("T1 tope", "corte un milisegundo más tarde", "server.ts",
     "      if (now >= until) {\n        marks.delete(host);", "      if (now > until) {\n        marks.delete(host);",
     S, "ms after the failure"),
    ("T1 tope", "corte un milisegundo antes", "server.ts",
     "      const until = at + SESSION_LOST_MS;\n      if (now >= until) {",
     "      const until = at + SESSION_LOST_MS - 1;\n      if (now >= until) {",
     S, "ms after the failure"),
    ("T2 vuelta", "un turno que acaba bien no quita la marca", "server.ts",
     "    if (typeof ran === \"string\" && since !== undefined) sessionBack(ran, { host, since });\n", "",
     S, "takes the session as back once a turn ends well on the account on that machine"),
    ("T2 vuelta", "un turno que acaba bien en otra máquina la quita", "server.ts",
     "sessionBack(ran, { host, since });", "sessionBack(ran);",
     S, "takes the session as back once a turn ends well on the account on that machine"),
    ("T2 vuelta", "un turno bueno en otra máquina no quita la marca de una máquina desconocida (code-reviewer r1, low 1)", "server.ts",
     "((host === \"\" || host === turn.host) && turn.since >= at)", "(host === turn.host && turn.since >= at)",
     S, "machine unknown as back"),
    ("T2 vuelta", "un turno que arrancó antes del fallo quita la marca (code-reviewer r1, low 2)", "server.ts",
     "((host === \"\" || host === turn.host) && turn.since >= at)", "(host === \"\" || host === turn.host)",
     S, "started before the failure"),
    ("T2 vuelta", "corte de la hora de arranque un milisegundo más tarde (code-reviewer r1, low 2)", "server.ts",
     "((host === \"\" || host === turn.host) && turn.since >= at)", "((host === \"\" || host === turn.host) && turn.since > at)",
     S, "takes the session as back once a turn ends well on the account on that machine"),
    ("T2 vuelta", "la hora de arranque se pierde al leer la cuenta (code-reviewer r1, low 2)", "server.ts",
     "      startedTime.set(thread.id, startedAt);\n", "      void startedAt;\n",
     S, "takes the session as back once a turn ends well on the account on that machine"),
    ("U1 a mano", "un use a mano no quita la marca (la colocación lo deshace)", "server.ts",
     "        sessionBack(to?.name ?? current.defaultAccountName);\n", "",
     S, "lets a pick by hand of the account stand"),
    ("V1 visible", "sin fila en history", "server.ts",
     "      toHistorial(`thread ${event.threadId} stuck`, (db) =>\n        addStuck(db, {\n          at: now,\n          thread: event.threadId,",
     "      void ((_: unknown, __: unknown) => 0)(`thread ${event.threadId} stuck`, (db: HistorialDb) =>\n        addStuck(db, {\n          at: now,\n          thread: event.threadId,",
     S, "counts the turn among the stuck threads"),
    ("V2 health", "health sin las marcas", "server.ts",
     "      sinSesion: sessionMarks(),\n", "",
     S, "counts the turn among the stuck threads"),
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
