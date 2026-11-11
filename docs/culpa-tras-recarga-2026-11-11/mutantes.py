#!/usr/bin/env python3
"""La culpa de un fallo es de donde corrió el turno (0.2.52, Aitor 2026-11-11: «puedes revisar por qué motivo hay
hilos en cola y que mejorarías?», «Arreglalo y publicalo»). Cada pieza nueva tiene una prueba que muere con su
mutante: se aplica el cambio en un clon limpio de HEAD, se ejecuta SU prueba y se exige rojo. Un mutante que no
aplica o que queda en verde hace fallar el script. Se niega a correr (código 3) con el árbol sucio.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/sin-login-2026-11-10/mutantes.py."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/culpa-tras-recarga-2026-11-11/mutantes.salida.txt")
S = "server.test.ts"
SW = "src/switch.test.ts"

# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
NULL = "    if (started === undefined && beforeLoad) started = null;\n"
FREE = """            preferredModel: model,
            ...reserveOf(projectId),
            freeSeats: seatRoom,"""
M = [
    ("R1 recarga", "el fallo de un turno de antes de la carga se culpa a la cuenta del proyecto (el incidente)", "server.ts",
     NULL, "", S, "the incident"),
    ("R1 recarga", "lo mismo: una negativa con la cuenta guardada perdida veta la del proyecto (RELOAD-001)", "server.ts",
     NULL, "", S, "RELOAD-001"),
    ("R1 recarga", "lo mismo: una negativa veta la cuenta del proyecto (RELOAD-002)", "server.ts",
     NULL, "", S, "RELOAD-002"),
    ("R1 recarga", "lo mismo: un turno sin plaza al cargar", "server.ts",
     NULL, "", S, "no seat counts marks nobody"),
    ("R1 recarga", "la lista de la carga no cuenta (solo el fallo antes de ella)", "server.ts",
     "    return !underWayListed || underWayAtLoad.has(threadId);", "    return !underWayListed;",
     S, "the incident"),
    ("R1 recarga", "el fallo que llega antes de la lista se culpa como antes (RELOAD-003, low 4)", "server.ts",
     "    return !underWayListed || underWayAtLoad.has(threadId);", "    return underWayAtLoad.has(threadId);",
     S, "RELOAD-003"),
    ("R1 recarga", "el fin del turno (thread.idle) no saca al hilo: el rechazo en la puerta queda desconocido", "server.ts",
     "    underWayAtLoad.delete(thread.id);\n    turnsUnderWay.delete(thread.id);\n    // Reserved too", "    turnsUnderWay.delete(thread.id);\n    // Reserved too",
     S, "once its turn of before the load has ended"),
    ("R1 recarga", "el hilo archivado no saca al hilo: un turno tras desarchivarlo queda desconocido (code-reviewer r2, low 3)", "server.ts",
     "    underWayAtLoad.delete(thread.id);\n    turnsUnderWay.delete(thread.id);\n    releaseSeat(thread.id, \"the thread is gone\");",
     "    turnsUnderWay.delete(thread.id);\n    releaseSeat(thread.id, \"the thread is gone\");",
     S, "a thread archived ends"),
    ("R1 recarga", "el refresco no vuelve a contar si la lista de la carga falló (code-reviewer r2, medium 2)", "server.ts",
     "      if (!underWayListed) countSeats();\n", "",
     S, "read again on a refresh"),
    ("R1 recarga", "un recuento posterior añade hilos al conjunto (code-reviewer r2, low 5)", "server.ts",
     "      if (!underWayListed)\n        for (const t of running)", "      if (true)\n        for (const t of running)",
     S, "a later count adds no thread"),
    ("R1 recarga", "un hilo que acabó mientras se leía la lista entra en el conjunto (code-reviewer r2, low 5)", "server.ts",
     "if (!ended.has(t.id) && !startedUnlisted.has(t.id)) underWayAtLoad.add", "if (!startedUnlisted.has(t.id)) underWayAtLoad.add",
     S, "ended while the threads were listed"),
    ("R1 recarga", "un hilo que esta carga vio arrancar antes de una lista tardía entra en el conjunto (code-reviewer r2, low 3)", "server.ts",
     "if (!ended.has(t.id) && !startedUnlisted.has(t.id)) underWayAtLoad.add", "if (!ended.has(t.id)) underWayAtLoad.add",
     S, "before a late list"),
    ("R1 recarga", "el fallo del turno no saca al hilo: el de su reintento queda desconocido", "server.ts",
     "    underWayAtLoad.delete(event.threadId);\n", "",
     S, "once its turn of before the load has failed"),
    ("R2 seguro", "sin el seguro: el reinicio informado vale siempre", "server.ts",
     "        !resetOfAccount(blamed, until, now, collector.get(failedOn)?.observedAt ?? undefined)",
     "        false",
     S, "600001 ms past"),
    ("R2 seguro", "el seguro también en una cuenta sin leer", "server.ts",
     "        until !== null &&\n        until > now &&\n        blamed !== undefined &&\n        blamed.unknown !== true &&\n",
     "        until !== null &&\n        until > now &&\n        (blamed === undefined ||\n        blamed.unknown === true) ? true :\n",
     S, "an account not read is marked until the reset reported"),
    ("R2 seguro", "judge no pasa la hora de la lectura (medium 1 en el servidor)", "server.ts",
     "collector.get(failedOn)?.observedAt ?? undefined)", "undefined)",
     S, "a weekly at 0 % with no reset at its read"),
    ("R2 seguro", "tolerancia estricta (el corte exacto de 10 min ya no casa)", "src/switch.ts",
     "Math.abs(reset - w.resetsAt) <= RESET_TOGETHER_MS", "Math.abs(reset - w.resetsAt) < RESET_TOGETHER_MS",
     SW, "matches its weekly within the tolerance"),
    ("R2 seguro", "sin el límite inferior de una ventana sin reinicio por delante (medium 1)", "src/switch.ts",
     "      reset >= opened + length - RESET_TOGETHER_MS &&", "      true &&",
     SW, "opens after it"),
    ("R2 seguro", "límite inferior sin tolerancia (corte exacto)", "src/switch.ts",
     "      reset >= opened + length - RESET_TOGETHER_MS &&", "      reset >= opened + length &&",
     SW, "resets between its read plus a week"),
    ("R2 seguro", "sin el límite superior", "src/switch.ts",
     "      reset <= now + length + RESET_TOGETHER_MS\n", "      true\n",
     SW, "resets between its read plus a week"),
    ("R2 seguro", "sin la hora de la lectura", "src/switch.ts",
     "Math.max(readAt ?? now, w.resetsAt ?? -Infinity)", "Math.max(-Infinity, w.resetsAt ?? -Infinity)",
     SW, "opens after it"),
    ("R2 seguro", "sin el reinicio ya pasado", "src/switch.ts",
     "Math.max(readAt ?? now, w.resetsAt ?? -Infinity)", "Math.max(readAt ?? now, -Infinity)",
     SW, "opens no sooner than that reset"),
    ("R2 seguro", "sin hora de lectura, la ventana se abre en cualquier momento pasado (code-reviewer r2, nit 6)", "src/switch.ts",
     "Math.max(readAt ?? now, w.resetsAt ?? -Infinity)", "Math.max(readAt ?? -Infinity, w.resetsAt ?? -Infinity)",
     SW, "nit 6"),
    ("R2 seguro", "la sesión de 5 h: la franja con la sesión sin abrir (Team)", "src/switch.ts",
     "    fits(account.session, SESSION_WINDOW_MS) ||", "    false ||",
     SW, "a Team whose read shows none open"),
    ("R2 seguro", "la regla vieja: cualquier reinicio en 5 h aunque la sesión tenga reinicio conocido (low 2)", "src/switch.ts",
     "    fits(account.session, SESSION_WINDOW_MS) ||",
     "    (account.session.absent !== true && reset <= now + SESSION_WINDOW_MS + RESET_TOGETHER_MS) ||\n    fits(account.session, SESSION_WINDOW_MS) ||",
     SW, "4 h 50"),
    ("R2 seguro", "sin las ventanas por modelo", "src/switch.ts",
     "[account.weekly, ...Object.values(account.models)]", "[account.weekly]",
     SW, "matches a model's own window"),
    ("R2 vencido", "un reinicio que ya pasó al juzgar marca 30 min (Codex Astra r2 RESET-001)", "server.ts",
     "        until > now &&\n", "",
     S, "RESET-001"),
    ("R3 atasco", "las libres no miran las marcas (la línea vuelve a mentir)", "server.ts",
     "      const libres = free.filter((_, i) => ends[i] === null);", "      const libres = free;",
     S, "usage limit's mark keeps"),
    ("R3 atasco", "sin la hora en que vuelve la primera marcada", "server.ts",
     "...(libres.length === 0 ? { vuelve: isoInZone(Math.min(...marked)) } : {}),", "...(libres.length < 0 ? { marked } : {}),",
     S, "usage limit's mark keeps"),
    ("R3 atasco", "la línea del registro con las libres vacías no lo dice", "src/atascos.ts",
     "    a.libres.length === 0\n", "    false\n",
     S, "usage limit's mark keeps"),
    ("R3 atasco", "la reserva de las libres sin el proyecto (code-reviewer r1)", "server.ts",
     FREE, FREE.replace("reserveOf(projectId)", "reserveOf()"),
     S, "an Ultra is free for the held Opus turn"),
    ("R3 health", "health --json sin las marcas", "server.ts",
     "      limites: limitMarks(),", "      limites: [],",
     S, "health shows each account's standing mark"),
    ("R3 health", "la línea de la cuenta no enseña su marca", "src/health.ts",
     "        .filter((l) => l.cuenta === c.nombre)", "        .filter(() => false)",
     S, "health shows each account's standing mark"),
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
