#!/usr/bin/env python3
"""Opus solo por Team (0.2.44, encargo de Aitor del 2026-11-06: «los Opus tienen que salir por Team sí o sí»).
Cada pieza nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/revision-2026-11-04/mutantes.py."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/opus-por-team-2026-11-06/mutantes.salida.txt")

QUITA_REGLA = ("  if (holdsForReserve(options)) return true;\n", "")
# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("R1 canario", "sin la regla: Opus vuelve a la Ultra con margen o sin Fable", "src/policy.ts", *QUITA_REGLA,
     "src/policy.test.ts", "Opus solo por Team"),
    ("R1 canario", "sin la regla (servidor: Team llena, Ultra ociosa)", "src/policy.ts", *QUITA_REGLA,
     "server.test.ts", "canario: with no Team seat free"),
    ("R1 canario", "sin la regla (colocación con pin a Ultra)", "src/policy.ts", *QUITA_REGLA,
     "src/switch.test.ts", "canario: an Opus turn with the Team seat full"),
    ("R2 pin", "un pin a Ultra vuelve a aguantar a Opus al colocar", "src/switch.ts",
     "  const pinHolds = input.pinned === true && !holdsForReserve(options);\n", "  const pinHolds = input.pinned === true;\n",
     "src/switch.test.ts", "Opus solo por Team: placement"),
    ("R2 pin", "un pin a Ultra vuelve a aguantar a Opus (servidor)", "src/switch.ts",
     "  const pinHolds = input.pinned === true && !holdsForReserve(options);\n", "  const pinHolds = input.pinned === true;\n",
     "server.test.ts", "T3"),
    ("R2 pin", "un hilo en error con pin a Ultra se reintenta allí en Opus", "src/switch.ts",
     "      input.pinned === true && !holdsForReserve(options)\n        ? { ...options, reserveModel: undefined }",
     "      input.pinned === true\n        ? { ...options, reserveModel: undefined }",
     "src/switch.test.ts", "in Opus, leaves the picked Max account"),
    ("R3 pin se queda", "el movimiento de Opus borra el pin", "server.ts",
     "        keepPin: otherModel(model),\n      });\n      await markHandled(projectId);\n      // A move for a crowded",
     "        keepPin: false,\n      });\n      await markHandled(projectId);\n      // A move for a crowded",
     "server.test.ts", "T3 a pick by hand of an Ultra with a Team seat free"),
    ("R3 pin se queda", "la vuelta a casa borra el pin", "server.ts",
     "      pins.get(projectId) !== toName &&\n", "",
     "server.test.ts", "T3 a pick by hand of an Ultra with a Team seat free"),
    # Codex r1 (codex-r1.md): cada hallazgo con su prueba.
    ("R5 r1-1", "una Max agotada vuelve a dejar arrancar a Opus para que falle", "server.ts",
     "    return spendsReservedWeekly(settle(usage, deps.now()), options);\n",
     "    const s = settle(usage, deps.now());\n    return isUsable(s) && canRunModel(s, model) && spendsReservedWeekly(s, options);\n",
     "server.test.ts", "r1-1"),
    ("R5 r1-2", "una cuenta sin leer cuyo login no dice nada vuelve a valer para Opus", "server.ts",
     "    return login === undefined || planOf(login, null).plan !== \"team\";\n",
     "    if (login === undefined) return false;\n    const { plan } = planOf(login, null);\n    return login.kind === \"max\" || plan === \"ultra\" || plan === \"max\";\n",
     "server.test.ts", "r1-2"),
    ("R5 r1-3", "una Max sin semanal vuelve a valer para Opus", "src/policy.ts",
     "  if (!reserving(options) || account.team === true) return false;\n",
     "  if (!reserving(options) || account.team === true || account.weekly.absent === true) return false;\n",
     "server.test.ts", "r1-3"),
    ("R5 r1-3", "una Max sin semanal vuelve a valer para Opus (política)", "src/policy.ts",
     "  if (!reserving(options) || account.team === true) return false;\n",
     "  if (!reserving(options) || account.team === true || account.weekly.absent === true) return false;\n",
     "src/policy.test.ts", "Codex r1 high 3"),
    ("R5 r1-4", "un movimiento entre Team borra el pin", "server.ts",
     "        keepPin: otherModel(model),\n      });\n      await markHandled(projectId);\n      // A move for a crowded",
     "        keepPin: false,\n      });\n      await markHandled(projectId);\n      // A move for a crowded",
     "server.test.ts", "r1-4"),
    ("R5 r1-5", "tras recargar, Fable no vuelve a la cuenta fijada", "server.ts",
     "    if (pin !== undefined) return pin;\n", "",
     "server.test.ts", "r1-5"),
    # Codex r2 (codex-r2.md).
    ("R6 r2-1", "un login que dice Max o Ultra vuelve a ser Team por no tener semanal", "src/accounts.ts",
     "      !ultra &&\n      login.planName !== \"Max\" &&\n      !tier.includes(\"max_\") &&\n", "",
     "server.test.ts", "r2-1"),
    ("R6 r2-1", "un login que dice Max o Ultra vuelve a ser Team (planOf)", "src/accounts.ts",
     "      !ultra &&\n      login.planName !== \"Max\" &&\n      !tier.includes(\"max_\") &&\n", "",
     "src/accounts.test.ts", "Codex r2 high 1"),
    ("R6 r2-2", "una Team agotada vuelve a dejar arrancar a Opus para que falle", "server.ts",
     "    return !(isUsable(settled) && canRunModel(settled, model));\n  }\n  /** A turn in",
     "    return false && !(isUsable(settled) && canRunModel(settled, model));\n  }\n  /** A turn in",
     "server.test.ts", "r2-2"),
    # Codex r3 (codex-r3.md).
    ("R7 r3-1", "un movimiento de Haiku borra el pin", "server.ts",
     "        keepPin: otherModel(model),\n      });\n      await markHandled(projectId);\n      // A move for a crowded",
     "        keepPin: heldModel(model),\n      });\n      await markHandled(projectId);\n      // A move for a crowded",
     "server.test.ts", "r3-1"),
    ("R7 r3-2", "el rescate del refresco no mira la cuenta fijada", "server.ts",
     "      excursionFrom: wayHome(projectId, model, measuredAccounts(model), now),\n", "",
     "server.test.ts", "r3-2"),
    ("R7 r3-3", "una espera de Opus en una cuenta sin leer no busca Team", "server.ts",
     "        !heldOff(fromName, model)) ||\n", "        true) ||\n",
     "server.test.ts", "r3-3"),
    ("R7 r3-4", "un login cuyo plan dice Team no es Team", "src/accounts.ts",
     "login.kind === \"team\" || login.planName === \"Team\"", "login.kind === \"team\"",
     "src/accounts.test.ts", "Codex r3 medium 4"),
    ("R6 r2-3", "una excursión nueva tapa el pin", "server.ts",
     "    if (pin !== undefined) return pin;\n    const excursion = excursions.get(projectId);\n    if (excursion === undefined) return undefined;\n",
     "    const excursion = excursions.get(projectId);\n    if (excursion === undefined) return pin;\n",
     "server.test.ts", "r2-3"),
    ("R2 pin", "un pin a Ultra deja de retener a Opus en la puerta", "server.ts",
     "    void projectId;\n", "    if (projectId !== undefined && pins.get(projectId) === name) return false;\n",
     "server.test.ts", ""),
    ("R2 pin", "una espera de Opus se suelta en la Max fijada a mano", "server.ts",
     "        (pins.get(projectId) === fromName &&\n        !holdsForReserve({ preferredModel: model, ...reserveOf() })\n",
     "        (pins.get(projectId) === fromName\n",
     "server.test.ts", "never released on the Max account picked by hand"),
    ("R4 Flota", "esperandoTeam cuenta también los turnos de Fable", "src/atascos.ts",
     "    if (at === undefined || modelo === null) continue;\n", "    if (at === undefined) continue;\n",
     "src/atascos.test.ts", "waitingForTeam"),
    ("R4 Flota", "health no lee la cola para esperandoTeam", "server.ts",
     "      esperandoTeam: await esperandoTeam(),\n", "      esperandoTeam: [],\n",
     "server.test.ts", "health lists the Opus turn waiting"),
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
