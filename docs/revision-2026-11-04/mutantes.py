#!/opt/homebrew/bin/python3
"""Cada camino revisado el 2026-11-04 tiene un test de estado real; aquí se comprueba
que ese test muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU test y se exige rojo. Un mutante que no aplica o que queda en verde
hace fallar el script. Salida: mutantes.salida.txt, junto a este fichero."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/revision-2026-11-04/mutantes.salida.txt")

# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    ("T1 reserva", "una Team con semanal vuelve a contar como Max", "src/policy.ts",
     "    account.team !== true &&\n    account.weekly.absent !== true", "    account.weekly.absent !== true",
     "server.test.ts", "T1 reserve"),
    ("T2 pin a Team", "un `use` no repregunta", "server.ts",
     '''        void bb.experimental_hooks
          .recheck("message.dispatch")
          .catch((error: unknown) =>
            bb.log.warn(
              `bb not asked again after a pick''',
     '''        void Promise.resolve()
          .catch((error: unknown) =>
            bb.log.warn(
              `bb not asked again after a pick''',
     "server.test.ts", "T2 a pin"),
    # La reserva decide en dos sitios (chooseAccount y spendsReservedWeekly en
    # decidePlacement): el mutante de la tabla del plan muere en la política, y el
    # del camino entero quita la regla de los dos a la vez.
    ("T3 pin a Ultra", "chooseAccount sin la reserva", "src/policy.ts",
     "      .filter((a) => !spendsReservedWeekly(a, options))\n", "",
     "src/policy.test.ts", ""),
    ("T3 pin a Ultra", "ninguna cuenta guarda la reserva: Opus corre en la Ultra", "src/policy.ts",
     "    reserving(options) &&\n    canRunModel(account, options.reserveModel!) &&\n    account.team !== true &&",
     "    false &&\n    canRunModel(account, options.reserveModel!) &&\n    account.team !== true &&",
     "server.test.ts", "T3b a pick"),
    ("T4 recarga", "no carga project-models", "server.ts",
     "if (!projectModel.has(id)) projectModel.set(id, { model, at: 0 });", "void id, void model;",
     "server.test.ts", "T4 a reload"),
    ("T4 recarga", "no guarda en cada cambio", "server.ts",
     "    if (before === model) return;\n    const snapshot = Object.fromEntries(", "    if (before !== undefined || model !== undefined) return;\n    const snapshot = Object.fromEntries(",
     "server.test.ts", "T4 a reload"),
    ("T5 agotada", "keep sin current-blocked", "src/switch.ts",
     ': { kind: "keep", why: "current-blocked" };', ': { kind: "keep" };',
     "server.test.ts", "T5 an account"),
    ("T5 agotada", "sin la comprobación final antes de reservar", "server.ts",
     "    if (isUsable(settled) && canRunModel(settled, model)) return false;\n    return otherThatRuns(name, model) !== null;",
     "    void settled;\n    return false;",
     "server.test.ts", "R4-001: the account confirmed"),
    ("T6 Esperar siempre", "todas las cuentas cuentan como Team", "server.ts",
     'login !== undefined && planOf(login, measured).plan === "team"', "login !== undefined",
     "server.test.ts", "T6 wait always"),
    ("T7 Team con semanal 100", "isUsable sin semanal", "src/policy.ts",
     "    account.session.usedPercent < 100 &&\n    account.weekly.usedPercent < 100", "    account.session.usedPercent < 100",
     "server.test.ts", "T7 a Team seat"),
    ("T8 alias", "modelFamily sin alias", "src/switch.ts",
     '''    /^claude-([a-z]+)-/.exec(id)?.[1] ??
    /^(fable|opus|sonnet|haiku)(?:\\[[^\\]]*\\])?$/i.exec(id)?.[1]?.toLowerCase();''',
     "    /^claude-([a-z]+)-/.exec(id)?.[1];",
     "server.test.ts", "T8 a model"),
    ("T9 plazas", "se mueve con un hilo trabajando (projectSeated fuera)", "server.ts",
     "      seats.free(key) <= (ahead === -1 ? queue.length : ahead) &&\n      !projectSeated(thread.projectId, thread.id)\n",
     "      seats.free(key) <= (ahead === -1 ? queue.length : ahead)\n",
     "server.test.ts", "T9 seats full"),
    ("T9 plazas", "no se mueve con plazas llenas", "src/switch.ts",
     '    if (input.seatsFull !== true) return { kind: "keep" };', '    return { kind: "keep" };',
     "server.test.ts", "T9 seats full"),
    ("T9b hermano", "exigir hilo parado en current-reserved", "server.ts",
     "    if (turn.abandoned) return null;\n    // Read before the move: what the seats were as it was decided.",
     '''    if (decision.why === "current-reserved" && projectSeated(projectId, thread.id))
      return { account: fromName, byDefault: !from.owned, writes };
    if (turn.abandoned) return null;
    // Read before the move: what the seats were as it was decided.''',
     "server.test.ts", "T9b a sibling"),
    ("T10 cambio a Opus", "opusInstead sin placedOn", "src/switch.ts",
     """  return placedOn({
    ...placement,
    currentAccount:
      decision.kind === "wait" ? decision.account : input.currentAccount,
  });""",
     '  return decision.kind === "wait" ? decision.account : input.currentAccount;',
     "server.test.ts", "T10 a Fable"),
    ("T11 rebalance", "quiet sin projectAtSeats", "server.ts",
     "      !projectAtSeats(projectId) &&\n", "",
     "server.test.ts", "T11 a project"),
    ("T12 reserve", "free <= queue pasa a free <= 0", "src/seats.ts",
     "if (this.free(account) <= this.queue(account).length) {", "if (this.free(account) <= 0) {",
     "src/seats.test.ts", ""),
    ("T13 atasco", "umbral N+1", "src/atascos.ts",
     "now - at < STUCK_WAIT_MS", "now - at <= STUCK_WAIT_MS",
     "src/atascos.test.ts", ""),
    ("T13 atasco", "medir desde createdAt", "src/atascos.ts",
     "    const at = since.get(row.threadId);", "    const at = (row as { createdAt?: number }).createdAt;",
     "server.test.ts", "from when the plugin began to hold it"),
    ("T13 atasco", "sin deduplicar la línea", "server.ts",
     "      if (now - (stuckSaid.get(a.hilo) ?? -Infinity) < STUCK_WAIT_MS) continue;\n", "",
     "server.test.ts", "says it once per 10 minutes"),
    ("T13 atasco", "[] al fallar la lectura", "server.ts",
     "`the queue could not be read to look for stuck threads: ${error instanceof Error ? error.message : String(error)}`,\n        );\n        return null;",
     "`the queue could not be read to look for stuck threads: ${error instanceof Error ? error.message : String(error)}`,\n        );\n        return [];",
     "server.test.ts", "an unreadable queue"),
    ("T14 reintento", "un `use` no revisa los reintentos", "server.ts",
     "        if (measuredPick)\n          void revisitWaits()", "        if (measuredPick && deps.now() < 0)\n          void revisitWaits()",
     "server.test.ts", "T14 a pick"),
    ("C5 motivo", "la espera no dice por qué", "server.ts",
     "seatWait(thread, seatOn, seatWhy)", "seatWait(thread, seatOn)",
     "server.test.ts", "T6 wait always"),
    ("C9 colisión", "sin deduplicar", "server.ts",
     "    if (skipsSaid.has(message)) return;\n", "",
     "server.test.ts", "C9 an account dir"),
    ("C7 canario", "umbral N+1", "scripts/canario-cola.mjs",
     "if (ahora - desde < UMBRAL_MS) continue;", "if (ahora - desde <= UMBRAL_MS) continue;",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "porcentaje redondeado", "scripts/canario-cola.mjs",
     "punto?.pctExacto ?? punto?.pct ?? 0", "punto?.pct ?? 0",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "cuenta la fila fallida", "scripts/canario-cola.mjs",
     '      f.waitingOn.pluginId === PLUGIN &&\n      (f.failureReason ?? null) === null,', "      f.waitingOn.pluginId === PLUGIN,",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "«Esperar siempre» fuera: Opus en una Ultra libre avisa", "scripts/canario-cola.mjs",
     'return cuenta.plan === "team" || exacto(cuenta.modelos?.[RESERVADO]) >= 100;', "return true;",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "lectura fallida sale con 0", "scripts/canario-cola.mjs",
     "      console.error(`lectura fallida: ${error.message}`);\n      process.exitCode = 1;", "      console.error(`lectura fallida: ${error.message}`);\n      process.exitCode = 0;",
     "scripts/canario-cola.test.ts", ""),
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
    # El clon sin mutar debe estar en verde con los mismos filtros.
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
