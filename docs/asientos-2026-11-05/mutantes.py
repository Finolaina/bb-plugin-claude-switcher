#!/usr/bin/env python3
"""Mutantes de la 0.2.43 (asientos sin esperas fijas e historial de 7 días; Aitor, 2026-11-05).

Cada mutante rompe a propósito una pieza; la suite debe fallar con cada uno ("muerto").
Uso, desde la raíz del repo: python3 docs/asientos-2026-11-05/mutantes.py
Deja el código como estaba al acabar, también si se corta (try/finally).
Primero corre la suite sin mutar y exige que pase; un mutante cuenta como muerto solo si
Vitest informa de tests fallidos, no si no arranca (Codex ASIENTOS-R2-004).
"""
import subprocess
import sys

MUTANTES = [
    ("M1 el hilo con hermanos espera en vez de moverse al momento", "server.ts",
     "    return { kind: \"stuck\", minutes, wanted, capacity, working };\n  }",
     "    if (since === null) return null;\n    return { kind: \"stuck\", minutes, wanted, capacity, working };\n  }"),
    ("M2 sin plazas para todos, no prueba una plaza para el hilo solo", "server.ts",
     "    if (busy?.kind === \"crowded\" && decision.kind === \"keep\") {",
     "    if (false && busy?.kind === \"crowded\" && decision.kind === \"keep\") {"),
    ("M3 un asiento libre no vuelve a preguntar a los de otras cuentas", "server.ts",
     "    if (admitted.length > 0 || waitingElsewhere)",
     "    if (admitted.length > 0)"),
    ("M4 vuelve a preguntar en cada consulta, no solo al liberarse un asiento", "server.ts",
     "    const waitingElsewhere =\n      freed &&",
     "    const waitingElsewhere =\n      true &&"),
    ("M5 la ventana de calma corta en N en vez de pasado N", "server.ts",
     "    if (last !== undefined && now - last <= limit) return null;",
     "    if (last !== undefined && now - last < limit) return null;"),
    ("M6 el texto del movimiento al momento dice 0 min", "server.ts",
     "${busy.minutes === 0 ?",
     "${busy.minutes === -1 ?"),
    ("M7 la poda borra también lo de 7 días justos", "src/historial.ts",
     "DELETE FROM seat_samples WHERE at < ?",
     "DELETE FROM seat_samples WHERE at <= ?"),
    ("M8 las muestras no guardan los hilos en espera", "server.ts",
     "        waiting: taken.queued.length,",
     "        waiting: 0,"),
    ("M9 las filas STUCK no se guardan", "server.ts",
     "      toHistorial(`thread ${a.hilo} stuck`, (db) =>",
     "      if (false) toHistorial(`thread ${a.hilo} stuck`, (db) =>"),
    ("M10 al arrancar no relee el historial", "server.ts",
     "      for (const r of readSamples(historial, deps.now() - SEAT_SAMPLES_MS))",
     "      for (const r of readSamples(historial, deps.now() + 1))"),
    ("M11 history --dias admite 8", "server.ts",
     "dias < 1 || dias > HISTORIAL_DIAS)",
     "dias < 1 || dias > HISTORIAL_DIAS + 1)"),
    ("M12 una retención movida a otra cuenta no libera la de antes (Codex ASIENTOS-001)", "server.ts",
     "if (before !== undefined && before.account !== key) admitWaiting(true);",
     "if (false) admitWaiting(true);"),
    ("M13 las muestras de kv no quedan en memoria si la base no las admite (Codex ASIENTOS-002)", "server.ts",
     "  for (const [name, s] of fromKv ?? []) keep(name, s);",
     "  if (historial === null) for (const [name, s] of fromKv ?? []) keep(name, s);"),
    ("M14 sin borrar kv no se lee la base (Codex ASIENTOS-002)", "server.ts",
     "          await bb.storage.kv.delete(KV_SEATS);\n        } catch (error) {",
     "          await bb.storage.kv.delete(KV_SEATS);\n        } catch (error) {\n          historial = null;"),
    ("M15 las retenciones de fuera se guardan sumadas a las de bb (Codex ASIENTOS-003)", "server.ts",
     "        reserved: taken.reserved,\n        external:",
     "        reserved: taken.reserved + (taken.external?.length ?? 0),\n        external:"),
    ("M16 una plaza abandonada al fallar un movimiento no despierta la cola (Codex ASIENTOS-R2-001)", "server.ts",
     "    if (had !== undefined && had !== key) admitWaiting(true);\n    return got;",
     "    return got;"),
    ("M17 las reservas caducadas no se sueltan antes de juzgar con hermanos (Codex ASIENTOS-R2-002)", "server.ts",
     "    if (when === \"before\") admitWaiting();\n    let seatsFull",
     "    let seatsFull"),
    ("M18 un turno que arranca en otra cuenta que su plaza no la suelta a la cola (Codex ASIENTOS-R3-002)", "server.ts",
     "    const { over } = seats.confirm(threadId, key, deps.now());\n    if (had !== undefined && had !== key) admitWaiting(true);",
     "    const { over } = seats.confirm(threadId, key, deps.now());"),
]
# Codex ASIENTOS-R3-001 (dos movimientos del mismo proyecto en vuelo) no lleva arreglo: una
# guarda que retenía el segundo rompió 6 tests que fijan a propósito cómo se resuelven dos
# movimientos que se cruzan (el último en escribir manda y el fallo se reintenta donde está
# el proyecto). Lo cubre el test «no second move while one of the project is being written».


def vitest() -> tuple[int, str]:
    r = subprocess.run(["npx", "vitest", "run", "--bail=1"], capture_output=True, text=True, timeout=900)
    resumen = next((l.strip() for l in r.stdout.splitlines() if l.strip().startswith("Tests ")), "sin resumen")
    return r.returncode, resumen


def main() -> int:
    rc, resumen = vitest()
    print(f"SIN MUTAR  rc={rc} · {resumen}")
    if rc != 0 or "failed" in resumen or "passed" not in resumen:
        print("la suite sin mutar no pasa: no se prueba ningún mutante")
        return 2
    vivos = []
    for nombre, fichero, antes, despues in MUTANTES:
        original = open(fichero).read()
        if original.count(antes) != 1:
            print(f"?? {nombre}: el ancla aparece {original.count(antes)} veces")
            vivos.append(nombre)
            continue
        try:
            open(fichero, "w").write(original.replace(antes, despues))
            rc, resumen = vitest()
            muerto = rc != 0 and "failed" in resumen
        finally:
            open(fichero, "w").write(original)
        print(("muerto " if muerto else "VIVO   ") + nombre + " · " + resumen)
        if not muerto:
            vivos.append(nombre)
    print(f"{len(MUTANTES) - len(vivos)}/{len(MUTANTES)} mutantes muertos")
    return 1 if vivos else 0


if __name__ == "__main__":
    sys.exit(main())
