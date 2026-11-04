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
     "    if (parsed.success) storedProjectModels = parsed.data;", "    void parsed;",
     "server.test.ts", "T4 a reload"),
    ("T4 recarga", "no guarda en cada cambio", "server.ts",
     "    if (!projectModelsRead || (before === model && !projectModelsUnsaved)) return;\n    const snapshot = Object.fromEntries(", "    if (before !== undefined || model !== undefined) return;\n    const snapshot = Object.fromEntries(",
     "server.test.ts", "T4 a reload"),
    ("T4 recarga", "una lectura fallida pisa lo guardado", "server.ts",
     "    if (!projectModelsRead || (before === model && !projectModelsUnsaved)) return;", "    if (before === model && !projectModelsUnsaved) return;",
     "server.test.ts", "a store that could not be read"),
    ("T15 sin leer", "una Ultra sin leer corre Opus", "server.ts",
     "      return unreadKeepsReserve(name);\n", "      return false;\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "sin leer no busca otra cuenta", "src/switch.ts",
     "      input.unreadKeepsReserve?.(input.currentAccount) !== true ||\n", "      true ||\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "una Team sin leer también espera", "server.ts",
     '    return login.kind === "max" || plan === "ultra" || plan === "max";\n', "    return plan !== null;\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "un login que solo dice Max o Ultra no basta", "server.ts",
     '    return login.kind === "max" || plan === "ultra" || plan === "max";\n', '    return plan === "ultra" || plan === "max";\n',
     "server.test.ts", "a login that says no more"),
    ("T15 sin leer", "sin leer la cuenta del proyecto, sale a los 3 intentos", "server.ts",
     "          [...measuredAccounts(model), ...accounts].some((a) =>\n", "          measuredAccounts(model).some((a) =>\n",
     "server.test.ts", "with its project's account not read"),
    ("T15 sin leer", "sin leer y Team llena, fuera de la cola", "src/switch.ts",
     '      ? { kind: "keep", why: "current-reserved" }\n      : { kind: "move", account: elsewhere.account', '      ? { kind: "keep" }\n      : { kind: "move", account: elsewhere.account',
     "server.test.ts", "with every Team seat full it waits"),
    ("T15 sin leer", "con todas las lecturas caídas no usa la Team libre", "server.ts",
     "      unreadTeams: unreadTeams(model),\n", "",
     "server.test.ts", "with all the reads down"),
    ("T16 hermano", "un movimiento descartado de entrada cuenta como movimiento", "server.ts",
     "    // Dropped here it is no move: a sibling's start stays known.\n    if (siblingHolds()) return false;\n", "",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "sin mirar tras repartir las sesiones", "server.ts",
     "      // this look and the write.\n      if (siblingHolds()) return false;\n", "      // this look and the write.\n",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "un proyecto nuevo se da por colocado sin colocarse", "server.ts",
     "        `thread ${thread.id}: not placed (another thread is about to start on ${fromName})`,\n      );\n      return;\n", "        `thread ${thread.id}: not placed (another thread is about to start on ${fromName})`,\n      );\n      await markHandled(projectId);\n      return;\n",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "la retención se renueva con cada pregunta", "server.ts",
     "      else if (!toldToStart.has(ctx.thread.id))\n", "      else\n",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "un hermano solo admitido de una cola también retiene", "server.ts",
     "      if (told !== undefined && now - told < SEAT_TTL_MS) return sibling;\n", "      if (told === undefined || now - told < SEAT_TTL_MS) return sibling;\n",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "la retención no caduca", "server.ts",
     "      if (told !== undefined && now - told < SEAT_TTL_MS) return sibling;\n", "      if (told !== undefined) return sibling;\n",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "el turno no espera al hermano admitido", "server.ts",
     "        : siblingAdmitted(projectId, thread.id);\n", "        : null;\n",
     "server.test.ts", "T16 a sibling"),
    ("T16 hermano", "el turno siguiente hereda la cuenta atrás del anterior", "server.ts",
     "    forgetWait(thread.id);\n    toldToStart.delete(thread.id);\n    // A hidden", "    forgetWait(thread.id);\n    // A hidden",
     "server.test.ts", "T16 a sibling"),
    ("T15 sin leer", "la Team llena sin leer no da cola", "src/switch.ts",
     "    ...unreadTeamSeats(input).filter((a) => !known.has(a.name)),\n", "",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "la Team medida y agotada cuenta como sin leer", "server.ts",
     "        return known === undefined || known.unknown === true;\n", "        return true;\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "la Team que rechazó sigue siendo destino", "server.ts",
     "        if (loggedOut(login.name) || refusing(login.name)) return false;\n", "        if (loggedOut(login.name)) return false;\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "Ultra leída y Team sin leer: espera con la Team libre", "src/switch.ts",
     "    (holdsForReserve(options)\n      ? chooseSeated(unreadTeamSeats(input), options, input.freeSeats)\n      : null) ??\n", "",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "antes de las primeras lecturas gasta una Team a ciegas", "server.ts",
     "    if (refreshes === 0) return [];\n", "",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "las primeras lecturas no vuelven a preguntar", "server.ts",
     "      if (first && firstReadsAwaited)\n", "      if (false as boolean)\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("T15 sin leer", "la Team con respuesta incompleta no da cola", "src/switch.ts",
     "    input.accounts.filter((a) => a.unknown !== true).map((a) => a.name),\n", "    input.accounts.map((a) => a.name),\n",
     "server.test.ts", "T15 an Ultra not read"),
    ("C7 canario", "la fila oculta olvida el aviso agrupado", "scripts/canario-cola.mjs",
     "    if (!ocultas) delete avisado[SIN_DESTINO];\n", "    void ocultas;\n    delete avisado[SIN_DESTINO];\n",
     "scripts/canario-cola.test.ts", ""),
    ("T14 reintento", "confirmar la cuenta no revisa los reintentos", "server.ts",
     "        measuredPick = collector.get(toName) !== undefined;\n        if (toName === fromName) return;\n", "        if (toName === fromName) return;\n        measuredPick = collector.get(toName) !== undefined;\n",
     "server.test.ts", "T14b a pick"),
    ("T1 reserva", "una Team con semanal no va primero aunque no gaste", "src/policy.ts",
     "    (account.team === true || account.weekly.absent === true) &&\n    modelWindow", "    account.weekly.absent === true &&\n    modelWindow",
     "src/policy.test.ts", "a Team seat that reports"),
    ("T4 recarga", "el final de un turno no guarda su modelo", "server.ts",
     "      noteProjectModel(projectId, model, started.activity);\n", "      void model;\n",
     "server.test.ts", "a turn seen only as it ends"),
    ("T4 recarga", "lo que trae la recarga gana a un turno nuevo", "server.ts",
     "      { model, at: 0 },\n", "      { model, at: Number.MAX_SAFE_INTEGER },\n",
     "server.test.ts", "a turn seen only as it ends"),
    ("T5 agotada", "espera a una Ultra que guarda Fable", "server.ts",
     "        { preferredModel: model, reserveModel: current.preferredModel },\n      )?.account ?? null\n    );\n  }\n  /**\n   * A turn in `model` on `name`", "        { preferredModel: model },\n      )?.account ?? null\n    );\n  }\n  /**\n   * A turn in `model` on `name`",
     "server.test.ts", "no other account can run it"),
    ("T5 agotada", "una cuenta desconocida cuenta como agotada", "server.ts",
     "    if (usage === undefined || usage.unknown === true) return false;\n    const settled", "    if (usage === undefined) return false;\n    const settled",
     "server.test.ts", "an account unknown for now"),
    ("T5 agotada", "los intentos no se devuelven al salir", "server.ts",
     "    waitAsked.delete(threadId);\n    blockedWaits.delete(threadId);\n", "    waitAsked.delete(threadId);\n",
     "server.test.ts", "a bb that fails every write"),
    ("T13 atasco", "salir no olvida la espera", "server.ts",
     "    } else if (ctx.attempt === \"start-turn\") {\n      forgetWait(ctx.thread.id);\n", "    } else if (ctx.attempt === \"start-turn\") {\n",
     "server.test.ts", "the wait is forgotten once it goes"),
    ("T13 atasco", "unirse a un turno olvida la espera", "server.ts",
     "    } else if (ctx.attempt === \"start-turn\") {\n      forgetWait(ctx.thread.id);\n", "    } else {\n      forgetWait(ctx.thread.id);\n",
     "server.test.ts", "a look that only joins"),
    ("T13 atasco", "un turno que arranca no acaba la espera", "server.ts",
     "    adviceOver(thread.id);\n    forgetWait(thread.id);\n    toldToStart.delete(thread.id);\n    // A hidden", "    adviceOver(thread.id);\n    toldToStart.delete(thread.id);\n    // A hidden",
     "server.test.ts", "a turn that starts"),
    ("T13 atasco", "el hilo que se va deja su espera", "server.ts",
     "    adviceOver(thread.id);\n    forgetWait(thread.id);\n    toldToStart.delete(thread.id);\n    stuckSaid.delete(thread.id);\n", "    adviceOver(thread.id);\n    toldToStart.delete(thread.id);\n",
     "server.test.ts", "a turn that starts"),
    ("T13 atasco", "una fila fallida deja de contar", "src/atascos.ts",
     'row.failureReason !== "Thread is archived"', "(row.failureReason ?? null) === null",
     "server.test.ts", "a row whose attempt failed"),
    ("T13 atasco", "un proyecto fijado a mano cuenta como atascado", "server.ts",
     "        if (read.external) continue;\n        account = read.account", "        account = read.account",
     "server.test.ts", "a project set by hand"),
    ("T4 recarga", "una escritura fallida no se reintenta", "server.ts",
     "(before === model && !projectModelsUnsaved)", "before === model",
     "server.test.ts", "a write that failed"),
    ("T5 agotada", "cancelar no devuelve los intentos", "server.ts",
     "    await forgetCancelledWait(entry.threadId);\n", "",
     "server.test.ts", "a message cancelled by hand"),
    ("T5 agotada", "espera sin tope si bb falla al escribir", "server.ts",
     "if (waited < BLOCKED_WAITS) {", "if (waited >= 0) {",
     "server.test.ts", "a bb that fails every write"),
    ("T5 agotada", "plaza propia con la capacidad bajada", "server.ts",
     "? Math.max(freeSeats(name), 0) + 1", "? freeSeats(name) + 1",
     "server.test.ts", "admitted, with the capacity lowered"),
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
     "    if (turn.abandoned) return null;\n    // Its move would carry along a sibling about to start: asked again soon.",
     '''    if (decision.why === "current-reserved" && projectSeated(projectId, thread.id))
      return { account: fromName, byDefault: !from.owned, writes };
    if (turn.abandoned) return null;
    // Its move would carry along a sibling about to start: asked again soon.''',
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
     'return typeof read === "object" ? read.value : null;', 'return typeof read === "object" ? read.value : [];',
     "server.test.ts", "an unreadable queue"),
    ("T13 atasco", "un hueco de bb borra la antigüedad", "server.ts",
     "        readAt - asked > WAIT_FORGOTTEN_MS &&\n", "        readAt - asked > -1 &&\n",
     "server.test.ts", "a row bb hides"),
    ("T13 atasco", "cancelar no borra la antigüedad", "server.ts",
     "    await forgetCancelledWait(entry.threadId);\n", "",
     "server.test.ts", "the last held message cancelled"),
    ("T13 atasco", "cancelar borra la antigüedad con otro aún en cola", "server.ts",
     "    if (typeof rows !== \"object\" || rows.value.length > 0) return;\n    if (waitAsked.get(threadId) !== asked) return;", "    if (typeof rows !== \"object\") return;\n    if (waitAsked.get(threadId) !== asked) return;",
     "server.test.ts", "the last held message cancelled"),
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
     "    if (razon === ARCHIVADO) return false;\n", "",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "«Esperar siempre» fuera: Opus en una Ultra libre avisa", "scripts/canario-cola.mjs",
     'return cuenta.plan === "team" || exacto(ventana(cuenta, RESERVADO)) >= 100;', "return true;",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "retenida sin destino no avisa", "scripts/canario-cola.mjs",
     "if (ahora - desde >= SIN_DESTINO_MS && !sinDestino.has(fila.threadId))", "if (false)",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "sin destino, umbral N+1", "scripts/canario-cola.mjs",
     "if (ahora - desde >= SIN_DESTINO_MS &&", "if (ahora - desde > SIN_DESTINO_MS &&",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "sin destino repite cada hora", "scripts/canario-cola.mjs",
     "(hilo === SIN_DESTINO ? REAVISO_SIN_DESTINO_MS : REAVISO_MS)", "REAVISO_MS",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "una fila que falla no avisa", "scripts/canario-cola.mjs",
     "      razon !== null ||\n", "",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "sin cuentas sale en verde", "scripts/canario-cola.mjs",
     "    veredicto.retenidas > 0 &&\n    (health.cuentas.length === 0 ||", "    false &&\n    (health.cuentas.length === 0 ||",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "retenida y fallida se pisan", "scripts/canario-cola.mjs",
     "const clave = `${fila.threadId}:fallida`;", "const clave = fila.threadId;",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "el aviso agrupado no entregado se da por dado", "scripts/canario-cola.mjs",
     "delete veredicto.estado.avisado[aviso.clave ?? aviso.hilo];", "delete veredicto.estado.avisado[aviso.hilo];",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "sin nadie en el caso no olvida el aviso", "scripts/canario-cola.mjs",
     "    if (!ocultas) delete avisado[SIN_DESTINO];\n  } else if (avisado", "    void ocultas;\n  } else if (avisado",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "un bb colgado lo deja parado", "scripts/canario-cola.mjs",
     "          timeout: BB_MS,\n", "",
     "scripts/canario-cola.test.ts", "un bb colgado"),
    ("C7 canario", "sin poder mirar no avisa nunca", "scripts/canario-cola.mjs",
     "      return avisarFallo({ motivo: error.message });\n", "",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "sin poder mirar avisa al primer fallo", "scripts/canario-cola.mjs",
     "if (ahora - desde >= FALLO_MS && (", "if ((",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "sale en verde si lo ejecutan por un enlace", "scripts/canario-cola.mjs",
     "return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);", "return process.argv[1] === fileURLToPath(import.meta.url);",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "un aviso por fila, no por hilo", "scripts/canario-cola.mjs",
     "    if (avisado[fila.threadId] !== undefined) continue;\n    avisado[fila.threadId] = ahora;", "    avisado[fila.threadId] = ahora;",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "se fía de la ventana que solo el reloj da por libre", "scripts/canario-cola.mjs",
     "propia?.sinConfirmar === true || exacto(propia) >= 100", "exacto(propia) >= 100",
     "scripts/canario-cola.test.ts", ""),
    ("C7 canario", "un hueco de bb borra la antigüedad", "scripts/canario-cola.mjs",
     "if (ahora - cuando < OLVIDO_MS && estado.primeraVez?.[id] !== undefined) {", "if (ahora - cuando < -1 && estado.primeraVez?.[id] !== undefined) {",
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
