#!/usr/bin/env python3
"""Semanal de las Team (0.2.49). Aitor 2026-11-07: «no entiendo por qué pone agotada si tiene fable, revísalo
por favor» (team4: 5 h al 0 %, Fable al 85 % y la semanal general al 100 %).
Cada condición nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/reparto-por-hueco-2026-11-07/mutantes.py
(corre en un clon: en el worktree pisaría lo que se edite mientras tanto)."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/semanal-team-2026-11-07/mutantes.salida.txt")

PA, PAT = "src/panel.ts", "src/panel.test.ts"
US, UST = "src/usage-source.ts", "src/usage-source.test.ts"
V, VT = "server.ts", "server.test.ts"
TEAM4 = "team4, 2026-11-07"
# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("panel", "la semana de una Team no la agota", PA,
     "        usage.weekly,\n      ];\n", "        ...(team ? [] : [usage.weekly]),\n      ];\n", PAT, TEAM4),
    ("panel", "sin barra de semana en una Team", PA,
     "        ...(usage.weekly.absent === true || usage.weekly.missing === true\n          ? []",
     "        ...(team || usage.weekly.absent === true || usage.weekly.missing === true\n          ? []", PAT, TEAM4),
    ("panel", "agotada por la semana, sigue diciendo sus hilos", PA,
     "  if (whole && team && !weekOut) {", "  if (whole && team) {", PAT, TEAM4),
    ("panel", "agotada por la semana, su barra sigue siendo la de 5 h", PA,
     '(team && !weekOut ? "five" : "week")', '(team ? "five" : "week")', PAT, TEAM4),
    ("panel", "corte: la semana agota desde el 99 %", PA,
     "usedOf(usage.weekly, now) >= 100;", "usedOf(usage.weekly, now) >= 99;", PAT, TEAM4),
    ("panel", "corte: la semana no agota ni al 100 %", PA,
     "usedOf(usage.weekly, now) >= 100;", "usedOf(usage.weekly, now) > 100;", PAT, TEAM4),
    ("panel", "parte del día en la semana de una Team", PA,
     "  const weekUsed = whole && !team ? usedOf(usage.weekly, now) : 100;",
     "  const weekUsed = whole ? usedOf(usage.weekly, now) : 100;", PAT, TEAM4),
    ("panel", "la barra pinta una semana desconocida (Astra r2)", PA,
     "usage.weekly.absent === true || usage.weekly.missing === true\n", "usage.weekly.absent === true\n", PAT, TEAM4),
    ("panel", "una semana desconocida agota la Team (Astra r2)", PA,
     "whole && team && usage.weekly.missing !== true && usedOf", "whole && team && usedOf", PAT, TEAM4),
    ("panel", "el estado no lleva la marca missing a las vistas (Astra r2)", V,
     "  missing: z.literal(true).optional(),\n", "", VT, "missing mark"),
    ("panel de bb", "ninguna semanal en una Team", US,
     '((info.plan === "team" && weekly.missing === true) || weekly.absent === true',
     '(info.plan === "team" || weekly.absent === true', UST, TEAM4),
    ("panel de bb", "la semanal incompleta de una Team se enseña", US,
     '((info.plan === "team" && weekly.missing === true) || weekly.absent === true',
     '(weekly.absent === true', UST, "BARS-001"),
    ("panel de bb", "una semanal medida sin reinicio se esconde (Codex Sol r1)", US,
     '((info.plan === "team" && weekly.missing === true) || weekly.absent === true',
     '((info.plan === "team" && weekly.resetsAt === null) || weekly.absent === true', UST, "measured without a reset"),
    ("atado", "el cambio anticipado escribe encima de un movimiento en curso", V,
     "    if (moving(projectId)) {\n      bb.log.info(\n        `thread ${thread.id}: not moved ahead",
     "    if (false) {\n      bb.log.info(\n        `thread ${thread.id}: not moved ahead",
     VT, "the move ahead does not move a project while another move of it is written"),
]


def resumen_de(salida: str) -> str:
    return next((l.strip() for l in salida.splitlines() if "Tests " in l), "sin resumen")


def main() -> int:
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
        resumen = resumen_de(r.stdout)
        if r.returncode != 0 and "failed" in resumen:
            lineas.append(f"MUERE      {camino} · {nombre} · {tests} {filtro!r} · {resumen}")
        else:
            lineas.append(f"VIVE       {camino} · {nombre} · {tests} {filtro!r} · {resumen}")
            fallos += 1
        print(lineas[-1], flush=True)
        open(ruta, "w").write(original)
    r = subprocess.run(["npx", "vitest", "run"], cwd=clon, capture_output=True, text=True)
    lineas.append(f"SIN MUTAR  rc={r.returncode} · {resumen_de(r.stdout)}")
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
