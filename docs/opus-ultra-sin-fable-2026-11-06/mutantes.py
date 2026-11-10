#!/usr/bin/env python3
"""Opus en una Max/Ultra sin Fable (0.2.47, Aitor 2026-11-06: «si fable llega al 100 se abre opus en esa cuenta»).
Cada pieza nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/opus-por-team-2026-11-06/mutantes.py."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/opus-ultra-sin-fable-2026-11-06/mutantes.salida.txt")

QUITA = ("  if (reserveSpentTillWeekly(account, options.reserveModel!)) return false;\n", "")
# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("S1 regla", "sin la regla: Opus no entra en la Ultra sin Fable", "src/policy.ts", *QUITA,
     "src/policy.test.ts", "an Ultra out of Fable until its weekly resets"),
    ("S1 regla", "sin la regla (servidor: arranca y se mueve allí)", "src/policy.ts", *QUITA,
     "server.test.ts", "out of Fable until its weekly resets"),
    ("S1 regla", "sin la regla (espera tras un fallo)", "src/policy.ts", *QUITA,
     "src/switch.test.ts", "waits for a Max account out of Fable until its weekly resets"),
    ("S2 umbral", "Fable al 99 % ya abre la Ultra", "src/policy.ts",
     "    own.usedPercent >= 100 &&\n", "    own.usedPercent >= 99 &&\n",
     "src/policy.test.ts", "Fable at 99 % keeps it Fable's"),
    ("S3 renovación", "una semanal que se renueva después de Fable también abre", "src/policy.ts",
     "    account.weekly.resetsAt <= own.resetsAt + RESET_TOGETHER_MS\n", "    true\n",
     "src/policy.test.ts", "still Fable's when Fable comes back"),
    ("S3 renovación", "una semanal que se renueva después de Fable también abre (servidor)", "src/policy.ts",
     "    account.weekly.resetsAt <= own.resetsAt + RESET_TOGETHER_MS\n", "    true\n",
     "server.test.ts", "whose weekly outlives Fable's window, an Opus turn still waits"),
    ("S3 renovación", "sin margen de 10 min", "src/policy.ts",
     "    account.weekly.resetsAt <= own.resetsAt + RESET_TOGETHER_MS\n", "    account.weekly.resetsAt <= own.resetsAt\n",
     "src/policy.test.ts", "still Fable's when Fable comes back"),
    ("S3 renovación", "margen abierto un milisegundo", "src/policy.ts",
     "    account.weekly.resetsAt <= own.resetsAt + RESET_TOGETHER_MS\n", "    account.weekly.resetsAt <= own.resetsAt + RESET_TOGETHER_MS + 1\n",
     "src/policy.test.ts", "still Fable's when Fable comes back"),
    ("S4 sin dato", "una cuenta sin semanal (null cuenta como 0) también abre", "src/policy.ts",
     "    account.weekly.absent !== true &&\n    account.weekly.resetsAt !== null &&\n", "",
     "src/policy.test.ts", "no reset known for Fable's window"),
    ("S5 orden", "la Ultra sin Fable va antes que las Team (sin el escalón)", "src/policy.ts",
     "    afterTeams(account, options) ? 1 : 0,\n", "    0,\n",
     "src/policy.test.ts", "comes after every Team seat with room"),
    ("S5 orden", "sin el escalón: una Team con ventana de Opus y sesión más llena pierde (Codex R047-002)", "src/policy.ts",
     "    afterTeams(account, options) ? 1 : 0,\n", "    0,\n",
     "src/policy.test.ts", "Codex R047-002"),
    ("S6 Haiku", "la Ultra sin Fable va detrás de las Team también para Haiku", "src/policy.ts",
     "    holdsForReserve(options) &&\n    account.team !== true &&\n    reserveSpentTillWeekly", "    account.team !== true &&\n    reserveSpentTillWeekly",
     "src/policy.test.ts", "Haiku keeps its order"),
    ("S7 Team sin leer", "la Ultra sin Fable medida gana a una Team sin leer (Codex R047-003)", "src/switch.ts",
     "      measured.filter((a) => !afterTeams(a, options)),\n", "      measured,\n",
     "src/switch.test.ts", "Codex R047-003"),
    ("S8 ronda 2", "el ritmo del día va antes que el escalón de las Team (Codex R047-R2-001)", "src/policy.ts",
     "    afterTeams(account, options) ? 1 : 0,\n    saved,\n", "    saved,\n    afterTeams(account, options) ? 1 : 0,\n",
     "src/policy.test.ts", "Codex R047-R2-001"),
    ("S8 ronda 2", "con la cuenta llena, la Team sin leer no se mira (Codex R047-R2-002)", "src/switch.ts",
     "        pick(unreadTeamSeats(input)) ??\n", "",
     "src/switch.test.ts", "Codex R047-R2-002"),
    ("S8 ronda 2", "plazas para todos en la Ultra ganan a una plaza en Team (Codex R047-R2-003)", "src/switch.ts",
     "        (input.seatsWantedOnly === true && wanted > 1 ? null : pick(roomy)))\n", "        pick(roomy))\n",
     "src/switch.test.ts", "Codex R047-R2-003"),
    ("S8 ronda 2", "a la misma hora, la espera tras un fallo elige por nombre (Codex R047-R2-004)", "src/switch.ts",
     "        (late !== earliest.late\n          ? !late\n          : before(account.name, earliest.account)))\n",
     "        before(account.name, earliest.account))\n",
     "src/switch.test.ts", "at the same reset, waits for the Team seat"),
    ("S8 ronda 2", "a la misma hora, la espera antes de arrancar elige por nombre (Codex R047-R2-004)", "src/switch.ts",
     "        (late !== earliest.late ? !late : account.name < earliest.account))\n",
     "        account.name < earliest.account)\n",
     "src/switch.test.ts", "waiting before the turn"),
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
