#!/usr/bin/env python3
"""Modelo de cada proyecto sembrado al cargar (0.2.45; página de limpieza del 2026-11-06, punto 60,
y Aitor 2026-11-06: «Puedes resolver hilos o decisiones de cosas que pueden estar pendientes…»).
Cada pieza nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/revision-2026-11-04/mutantes.py
(ese guarda 7 mutantes que dejaron de aplicar con la 0.2.44; por eso, como la 0.2.44, carpeta propia).
Uso: python3 docs/modelo-al-cargar-2026-11-06/mutantes.py (desde el repo, con node_modules instalado)."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/modelo-al-cargar-2026-11-06/mutantes.salida.txt")

F = "seeded at load from the project's latest thread"
# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("S1 siembra", "sin sembrar: el rescate juzga por Fable al proyecto de Opus", "server.ts",
     "        projectModel.set(projectId, { model, at: 0 });\n        seededModels.add(projectId);\n",
     "        seededModels.add(projectId);\n",
     "server.test.ts", "stays there after a reload with nothing stored"),
    ("S2 último hilo", "manda el primer hilo listado, no el más reciente", "server.ts",
     "      (latest.get(t.projectId)?.updatedAt ?? -Infinity) < t.updatedAt\n",
     "      !latest.has(t.projectId)\n",
     "server.test.ts", "the latest thread by activity names it"),
    ("S3 hilos del usuario", "cuenta un hilo de otro proveedor", "server.ts",
     "      t.providerId === CLAUDE_CODE_PROVIDER &&\n      notTheUsersThread(t) === null &&\n      (latest",
     "      notTheUsersThread(t) === null &&\n      (latest",
     "server.test.ts", "another provider's thread or a hidden one"),
    ("S3 hilos del usuario", "cuenta un hilo oculto de un plugin", "server.ts",
     "      t.providerId === CLAUDE_CODE_PROVIDER &&\n      notTheUsersThread(t) === null &&\n      (latest",
     "      t.providerId === CLAUDE_CODE_PROVIDER &&\n      (latest",
     "server.test.ts", "another provider's thread or a hidden one"),
    ("S4 sin guardar", "lo sembrado entra en project-models con el turno de otro proyecto", "server.ts",
     "        .filter(([id]) => !seededModels.has(id))\n", "",
     "server.test.ts", "what is seeded is not stored until a turn names it"),
    ("S4 sin guardar", "un turno del mismo modelo no lo confirma", "server.ts",
     "    const before = seededModels.delete(projectId)\n      ? undefined\n      : projectModel.get(projectId)?.model;",
     "    const before = projectModel.get(projectId)?.model;",
     "server.test.ts", "what is seeded is not stored until a turn names it"),
    ("S5 manda el turno", "la lectura pisa un turno visto mientras leía", "server.ts",
     "        if (projectModel.has(projectId)) return;\n", "",
     "server.test.ts", "a turn seen before the read lands beats what is seeded"),
    ("S6 coste", "lee también los proyectos con modelo guardado", "server.ts",
     "    const asked = ids.filter((id) => !projectModel.has(id));", "    const asked = ids;",
     "server.test.ts", "one read per project with no model stored"),
    ("S7 espera", "el rescate no espera a la lectura en curso", "server.ts",
     "      (await within(modelsSeeded, SEED_WAIT_MS, \"the projects' models\")) ===\n        \"late\" &&",
     "      (await within(Promise.resolve(), SEED_WAIT_MS, \"the projects' models\")) ===\n        \"late\" &&",
     "server.test.ts", "the first rescue waits for the read under way"),
    ("S7 espera", "la espera no tiene tope", "server.ts",
     "(await within(modelsSeeded, SEED_WAIT_MS, \"the projects' models\"))",
     "(await within(modelsSeeded, SEED_WAIT_MS * 1000, \"the projects' models\"))",
     "server.test.ts", "a read that never answers holds neither a turn"),
    ("S7 espera", "el aviso de la espera se repite en cada refresco", "server.ts",
     "        \"late\" &&\n      !seedLateSaid\n", "        \"late\"\n",
     "server.test.ts", "a read that never answers holds neither a turn"),
    ("S8 degradado", "una lectura fallida no se cuenta ni se avisa", "server.ts",
     "await within(latestTurn(thread.id), DISPATCH_LIMIT_MS, what);",
     "await within(latestTurn(thread.id).catch(() => null), DISPATCH_LIMIT_MS, what);",
     "server.test.ts", "a read of bb that fails is said once"),
    ("S8 degradado", "una lista de hilos fallida no avisa", "server.ts",
     "        \"the threads not listed to read each project's model at load; the preferred model judges those with none stored\",\n",
     "        \"\",\n",
     "server.test.ts", "a list of threads that fails is said once"),
    ("S8 degradado", "una lista de hilos fallida deja al rescate esperando", "server.ts",
     "      // The threads not listed: said, and judged as before.\n      seedProjectModels(null);\n", "",
     "server.test.ts", "a list of threads that fails is said once"),
    ("S9 archivados (Codex r1-r2 MLC-001)", "los hilos archivados no cuentan", "server.ts",
     "      for (const t of page.value) noteLatestThread(latest, t);\n", "",
     "server.test.ts", "an archived thread counts"),
    ("S9 archivados (Codex r1-r2 MLC-001)", "una lista de archivados fallida siembra igual", "server.ts",
     "      if (typeof page !== \"object\") return;\n      for (const t of page.value)", "      if (typeof page !== \"object\") break;\n      for (const t of page.value)",
     "server.test.ts", "a list of archived threads that fails"),
]


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
