#!/usr/bin/env python3
"""Cada guarda de «un tic de Calor no mueve el proyecto» tiene una prueba que la caza: se aplica el
cambio en un clon limpio de HEAD, se ejecuta su prueba y se exige rojo. Un mutante que no aplica o que
queda en verde hace fallar el script. Salida: mutantes.salida.txt, junto a este fichero.
Mismo método que docs/revision-2026-11-04/mutantes.py."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/cambios-caches-2026-11-04/mutantes.salida.txt")
T = ("server.test.ts", "T-tic")
MARCA = ("src/switch.test.ts", "isCalorTick")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

# (mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("placeTurn no sabe que es un tic: mueve", "server.ts", "{ abandoned: false, tick }", "{ abandoned: false }", *T),
    ("un tic ya en cola también se rechaza", "server.ts", "const tick = ctx.queuedMessages.length === 0 && isCalorTick", "const tick = isCalorTick", *T),
    ("se rechaza también lo que no movería", "server.ts", "if (tick && (turn.refused !== undefined || turn.held !== undefined)) {", "if (tick) {", *T),
    ("lo que movería ya no se rechaza", "server.ts", "if (tick && (turn.refused !== undefined || turn.held !== undefined)) {", "if (tick && turn.held !== undefined) {", *T),
    ("lo retenido no se rechaza y entra en cola", "server.ts", "if (tick && (turn.refused !== undefined || turn.held !== undefined)) {", "if (tick && turn.refused !== undefined) {", *T),
    ("el modelo se apunta antes de decidir (T-001)", "server.ts", "if (!tick) noteTurn();", "noteTurn();", *T),
    ("un tic que sigue no apunta su modelo", "server.ts", 'if (tick && decision?.action !== "reject") noteTurn();', "", *T),
    ("un tic sin colocación no apunta su modelo", "server.ts", "} else if (tick) noteTurn();", "}", *T),
    ("un tic coloca un proyecto nuevo (T-002)", "server.ts", "const first = tick ? null : placeNewProject(thread);", "const first = placeNewProject(thread);", *T),
    ("el cierre de Calor cuenta como tic", "src/switch.ts", f"calor: tic de caché #{UUID}\\./", f"calor: (?:tic de caché|cierre automático) #{UUID}/", *T),
    ("cualquier mensaje cuenta como tic", "src/switch.ts", "return CALOR_TICK.test(text);", "return text !== null;", *T),
    ("la marca sin ancla casa en mitad de un texto", "src/switch.ts", "/^\\s*calor: tic de caché", "/calor: tic de caché", *MARCA),
    ("la marca no exige el UUID", "src/switch.ts", f"#{UUID}\\./", "#\\S+\\./", *MARCA),
    ("la marca no distingue mayúsculas", "src/switch.ts", f"#{UUID}\\./", f"#{UUID}\\./i", *MARCA),
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
    for nombre, fichero, viejo, nuevo, tests, filtro in M:
        ruta = os.path.join(clon, fichero)
        original = open(ruta, encoding="utf-8").read()
        if original.count(viejo) != 1:
            lineas.append(f"NO APLICA  {nombre} (coincidencias: {original.count(viejo)})")
            fallos += 1
            print(lineas[-1], flush=True)
            continue
        open(ruta, "w", encoding="utf-8").write(original.replace(viejo, nuevo))
        r = subprocess.run(["npx", "vitest", "run", tests, "-t", filtro], cwd=clon, capture_output=True, text=True)
        resumen = next((l.strip() for l in r.stdout.splitlines() if "Tests " in l), "sin resumen")
        if r.returncode != 0 and "failed" in resumen:
            lineas.append(f"MUERE      {nombre} · {resumen}")
        else:
            lineas.append(f"VIVE       {nombre} · {resumen}")
            fallos += 1
        print(lineas[-1], flush=True)
        open(ruta, "w", encoding="utf-8").write(original)
    r = subprocess.run(["npx", "vitest", "run"], cwd=clon, capture_output=True, text=True)
    resumen = next((l.strip() for l in r.stdout.splitlines() if "Tests " in l), "sin resumen")
    lineas.append(f"SIN MUTAR  rc={r.returncode} · {resumen}")
    print(lineas[-1], flush=True)
    if r.returncode != 0:
        fallos += 1
    lineas.append(f"mutantes: {len(M)}, sin morir o sin aplicar: {fallos}")
    open(SALIDA, "w", encoding="utf-8").write("\n".join(lineas) + "\n")
    print(lineas[-1])
    shutil.rmtree(trabajo)
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
