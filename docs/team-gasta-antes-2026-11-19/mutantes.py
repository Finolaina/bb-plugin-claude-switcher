#!/usr/bin/env python3
"""La Team que va a perder semanal en su reinicio va primero entre las Team (0.2.55, Aitor 2026-11-19: «La Team que
va a perder cuota en su reinicio recibe los hilos antes, desde unos 2 días antes. Plazas en 5.»). Cada decisión de la
regla tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD, se ejecuta SU prueba y
se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script. Se niega a correr (código 3) con el
árbol sucio. Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/veto-403-2026-11-13/mutantes.py. Sin mutante
para el reloj de placedOn ni de freeElsewhere: allí chooseAccount mira una sola cuenta y el orden no decide nada
(la primera tirada lo dejó vivo); se quitó."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/team-gasta-antes-2026-11-19/mutantes.salida.txt")
P = "src/team-reset.test.ts"
SWT = "src/team-reset-switch.test.ts"
H = "src/health.test.ts"
S = "server.test.ts"
POL = "src/policy.ts"
SWI = "src/switch.ts"

STEP = "    options.now !== undefined && teamSpendsFirst(account, options.now) ? 0 : 1,\n"
COMMENT = (
    "    // A Team seat that would lose weekly at its reset, with session left,\n"
    "    // first (0.2.55, teamSpendsFirst). Mostly among the Team seats, for the\n"
    "    // steps above keep a Team seat apart from a Max or Ultra; where they tie\n"
    "    // (no preferred model, or a Haiku turn with the reserved model spent on\n"
    "    // both) it goes before a Max or Ultra too: the weekly it spends is lost\n"
    "    // at the reset, and the other spends nothing the reserved model needs\n"
    "    // (review R1-001).\n"
)

# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("corte", "estricto: a las horas justas no entra", POL,
     "  return reset - now <= needMs;", "  return reset - now < needMs;",
     P, "in at exactly its hours"),
    ("corte", "TEAM_SESSION_WEEKLY_POINTS 10 → 11", POL,
     "export const TEAM_SESSION_WEEKLY_POINTS = 10;", "export const TEAM_SESSION_WEEKLY_POINTS = 11;",
     P, "in at exactly its hours"),
    ("corte", "TEAM_SESSION_WEEKLY_POINTS 10 → 9", POL,
     "export const TEAM_SESSION_WEEKLY_POINTS = 10;", "export const TEAM_SESSION_WEEKLY_POINTS = 9;",
     P, "in at exactly its hours"),
    ("corte", "TEAM_SESSION_HOURS 5 → 4", POL,
     "export const TEAM_SESSION_HOURS = 5;", "export const TEAM_SESSION_HOURS = 4;",
     P, "in at exactly its hours"),
    ("corte", "TEAM_SPEND_SLACK 1.5 → 1.4", POL,
     "export const TEAM_SPEND_SLACK = 1.5;", "export const TEAM_SPEND_SLACK = 1.4;",
     P, "in at exactly its hours"),
    ("corte", "TEAM_SPEND_SLACK 1.5 → 1.6", POL,
     "export const TEAM_SPEND_SLACK = 1.5;", "export const TEAM_SPEND_SLACK = 1.6;",
     P, "in at exactly its hours"),
    ("quién", "una Max/Ultra también entra (sin team === true)", POL,
     "  if (account.team !== true || reset === null", "  if (reset === null",
     P, "a Max or Ultra account never is"),
    ("quién", "una semanal al 100 % cuenta con 1 punto por gastar (el < 100)", POL,
     "  const left = 100 - account.weekly.usedPercent;", "  const left = 101 - account.weekly.usedPercent;",
     P, "a weekly at 100 % is out"),
    ("reinicio", "reinicio nulo como inminente", POL,
     "  const reset = account.weekly.resetsAt;", "  const reset = account.weekly.resetsAt ?? now + 1;",
     P, "a reset unknown is out"),
    ("reinicio", "reinicio pasado entra (lectura vieja)", POL,
     " || reset <= now) return false;", ") return false;",
     P, "a reset past"),
    ("reinicio", "reinicio en este mismo instante entra (corte exacto)", POL,
     " || reset <= now) return false;", " || reset < now) return false;",
     P, "a reset past"),
    ("orden", "sin el escalón en la comparación", POL,
     "    if (la !== lb) return la - lb;\n", "",
     P, "the 2026-11-19 case"),
    ("orden", "el escalón después del cuarto de sesión", POL,
     COMMENT + STEP + "    sessionQuarter(account),\n",
     "    sessionQuarter(account),\n" + COMMENT + STEP,
     P, "the 2026-11-19 case"),
    ("orden", "el escalón antes de reserveOnTeam (Fable iría a la Team antes que a la Ultra)", POL,
     "    reserveOnTeam,\n    roomTier(account, options),\n" + COMMENT + STEP,
     STEP + "    reserveOnTeam,\n    roomTier(account, options),\n" + COMMENT,
     P, "Fable goes to the Ultra before the Team seat in the step"),
    ("caminos", "decideSwitch sin reloj", SWI,
     "    savedForUser: input.savedForUser,\n    now: input.now,\n  };\n  // A failure just reported",
     "    savedForUser: input.savedForUser,\n  };\n  // A failure just reported",
     SWT, "a switch after a failure"),
    ("caminos", "decidePlacement sin reloj (proyecto nuevo, fuera de una Ultra, plazas llenas)", SWI,
     "    savedForUser: input.savedForUser,\n    now: input.now,\n  };\n  if (input.isNew) {",
     "    savedForUser: input.savedForUser,\n  };\n  if (input.isNew) {",
     SWT, "the step on every path"),
    ("caminos", "decideAhead sin reloj", SWI,
     "    savedForUser: input.savedForUser,\n    now: input.now,\n  });",
     "    savedForUser: input.savedForUser,\n  });",
     SWT, "a move ahead of the limit"),
    ("caminos", "bestAccount sin reloj", SWI,
     "reserveShare, now },", "reserveShare },",
     SWT, "the best account for the header"),
    ("caminos", "reserveWait desempata al revés", SWI,
     "            ? loses\n", "            ? !loses\n",
     SWT, "the wait for a seat"),
    ("caminos", "reserveWait sin desempate por el escalón", SWI,
     "          : loses !== earliest.loses\n            ? loses\n            : account.name < earliest.account))",
     "          : account.name < earliest.account))",
     SWT, "the wait for a seat"),
    ("health", "gastaAntes siempre falso", "src/health.ts",
     "    gastaAntes: teamSpendsFirst({ ...u, team: true }, now),", "    gastaAntes: false,",
     H, "gastaAntes and semanalPorGastar"),
    ("health", "semanalPorGastar da lo gastado, no lo que queda", "src/health.ts",
     "round1(Math.max(0, 100 - u.weekly.usedPercent))", "round1(u.weekly.usedPercent)",
     H, "gastaAntes and semanalPorGastar"),
    ("health", "sin la frase en el texto", "src/health.ts",
     "      ...(c.gastaAntes === true && c.usable\n", "      ...(c.gastaAntes === null && c.usable\n",
     H, "gastaAntes and semanalPorGastar"),
    ("sesión", "corte del 75 % a 100 %: con la sesión al 75 % entra (cuarto < 4)", POL,
     "  return teamLosesWeekly(account, now) && sessionQuarter(account) < 3;",
     "  return teamLosesWeekly(account, now) && sessionQuarter(account) < 4;",
     P, "74 % in, 75 % out"),
    ("sesión", "corte del 75 % a 50 %: con la sesión al 74 % no entra (cuarto < 2)", POL,
     "  return teamLosesWeekly(account, now) && sessionQuarter(account) < 3;",
     "  return teamLosesWeekly(account, now) && sessionQuarter(account) < 2;",
     P, "74 % in, 75 % out"),
    ("sesión", "el && pasa a ||", POL,
     "  return teamLosesWeekly(account, now) && sessionQuarter(account) < 3;",
     "  return teamLosesWeekly(account, now) || sessionQuarter(account) < 3;",
     P, "74 % in, 75 % out"),
    ("sesión", "rank() sin la sesión (la 0.2.55 de antes de la revisión): decideAhead lleva a tA", POL,
     "    options.now !== undefined && teamSpendsFirst(account, options.now) ? 0 : 1,",
     "    options.now !== undefined && teamLosesWeekly(account, options.now) ? 0 : 1,",
     SWT, "decideAhead: off tE at 96"),
    ("sesión", "rank() sin la sesión: el caso de decidePlacement lleva a tA", POL,
     "    options.now !== undefined && teamSpendsFirst(account, options.now) ? 0 : 1,",
     "    options.now !== undefined && teamLosesWeekly(account, options.now) ? 0 : 1,",
     SWT, "decidePlacement: off an Ultra that keeps Fable, not to tA"),
    ("sesión", "reserveWait también mira la sesión", SWI,
     "    const loses = teamLosesWeekly(account, input.now);",
     "    const loses = teamLosesWeekly(account, input.now) && account.session.usedPercent < 75;",
     SWT, "reserveWait ties by teamLosesWeekly alone"),
    ("health", "la frase también en una cuenta no usable", "src/health.ts",
     "      ...(c.gastaAntes === true && c.usable\n", "      ...(c.gastaAntes === true\n",
     H, "the phrase only on a usable account"),
    ("health", "una lectura parcial (unknown) se toma como entera", "src/health.ts",
     "  if (u === null || u.unknown === true || u.weekly.absent === true)",
     "  if (u === null || u.weekly.absent === true)",
     H, "a read not whole (unknown)"),
    ("health", "una semanal no informada (absent) se toma como medida", "src/health.ts",
     "  if (u === null || u.unknown === true || u.weekly.absent === true)",
     "  if (u === null || u.unknown === true)",
     H, "a read not whole (unknown)"),
    ("health", "gastaAntes con la semanal sola, sin la sesión", "src/health.ts",
     "    gastaAntes: teamSpendsFirst({ ...u, team: true }, now),",
     "    gastaAntes: teamSpendsFirst({ ...u, session: { usedPercent: 0, resetsAt: null }, team: true }, now),",
     H, "with its session at 75 %"),
    ("health", "el servidor no pasa el reloj", "server.ts",
     "      // gastaAntes and semanalPorGastar per Team seat (0.2.55).\n      now,\n", "",
     S, "gives each Team seat gastaAntes"),
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
