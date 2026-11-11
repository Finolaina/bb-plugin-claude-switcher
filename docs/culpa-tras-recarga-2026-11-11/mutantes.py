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
M = [
    ("R1 recarga", "al cargar no se recupera dónde arrancó el turno (se culpa la cuenta del proyecto)", "server.ts",
     "          if (!startedOn.has(t.id)) startedOn.set(t.id, seatName(key));\n", "",
     S, "leaves that account unmarked"),
    ("R1 recarga", "lo mismo, visto en la marca de health (juicio con la cuenta del proyecto fuera)", "server.ts",
     "          if (!startedOn.has(t.id)) startedOn.set(t.id, seatName(key));\n", "",
     S, "judged because the project's account is out too"),
    ("R1 recarga", "un turno en marcha sin contar al cargar no queda desconocido", "server.ts",
     "              startedOn.set(t.id, null);\n", "              void 0;\n",
     S, "no seat counts"),
    ("R2 seguro", "sin el seguro: el reinicio informado vale siempre", "server.ts",
     "blamed.unknown !== true && !resetOfAccount(blamed, until, now)",
     "blamed.unknown !== true && false",
     S, "600001 ms past"),
    ("R2 seguro", "el seguro también en una cuenta sin leer", "server.ts",
     "until !== null && blamed !== undefined && blamed.unknown !== true && !resetOfAccount(blamed, until, now)",
     "until !== null && (blamed === undefined || blamed.unknown === true || !resetOfAccount(blamed, until, now))",
     S, "an account not read is marked until the reset reported"),
    ("R2 seguro", "tolerancia estricta (el corte exacto de 10 min ya no casa)", "src/switch.ts",
     "Math.abs(reset - w.resetsAt) <= RESET_TOGETHER_MS", "Math.abs(reset - w.resetsAt) < RESET_TOGETHER_MS",
     SW, "matches its weekly within the tolerance"),
    ("R2 seguro", "sin la regla de las 5 h (una Team sin sesión abierta en su lectura)", "src/switch.ts",
     "  if (account.session.absent !== true && reset", "  if (false && reset",
     SW, "any reset within the next 5 hours"),
    ("R2 seguro", "una ventana sin reinicio por delante no casa con nada", "src/switch.ts",
     "      : reset <= now + length + RESET_TOGETHER_MS;", "      : false && length > 0;",
     SW, "not ahead"),
    ("R2 seguro", "sin las ventanas por modelo", "src/switch.ts",
     "[account.weekly, ...Object.values(account.models)]", "[account.weekly]",
     SW, "matches a model's own window"),
    ("R3 atasco", "las libres no miran las marcas (la línea vuelve a mentir)", "server.ts",
     "      const libres = free.filter((_, i) => ends[i] === null);", "      const libres = free;",
     S, "usage limit's mark keeps"),
    ("R3 atasco", "sin la hora en que vuelve la primera marcada", "server.ts",
     "...(libres.length === 0 ? { vuelve: isoInZone(Math.min(...marked)) } : {}),", "...(libres.length < 0 ? { marked } : {}),",
     S, "usage limit's mark keeps"),
    ("R3 atasco", "la línea del registro con las libres vacías no lo dice", "src/atascos.ts",
     "    a.libres.length === 0\n", "    false\n",
     S, "usage limit's mark keeps"),
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
