#!/usr/bin/env python3
"""Reparto por hueco (0.2.48). Aitor 2026-11-07: «la cuenta de viaulab, se sigue disparando el tema la cuenta
semanal y fable se queda sin gastar»; «tampoco quiero que hilos se queden parados, si una cuenta se queda sin
cuota tiene que saltar a otra, el trabajo prima».
Cada condición nueva tiene una prueba que muere con su mutante: se aplica el cambio en un clon limpio de HEAD,
se ejecuta SU prueba y se exige rojo. Un mutante que no aplica o que queda en verde hace fallar el script.
Salida: mutantes.salida.txt, junto a este fichero. Mismo motor que docs/opus-ultra-sin-fable-2026-11-06/mutantes.py
(corre en un clon: en el worktree pisaría lo que se edite mientras tanto)."""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
SALIDA = os.path.join(REPO, "docs/reparto-por-hueco-2026-11-07/mutantes.salida.txt")

P, S, V, H = "src/policy.ts", "src/switch.ts", "server.ts", "src/health.ts"
PT, ST, VT, HT = "src/policy.test.ts", "src/switch.test.ts", "server.test.ts", "src/health.test.ts"
FABLE_TIER = (
    "        ? (pick(roomy.filter((a) => a.team !== true)) ??\n"
    "          (input.seatsWantedOnly === true && wanted > 1 ? null : pick(roomy)))\n"
)
# (camino, mutante, fichero, viejo, nuevo, ficheros de test, filtro)
M = [
    # B1 opusRoom
    ("B1 hueco", "una Team tiene hueco", P, "    account.team === true ||\n    account.unknown === true ||\n", "    account.unknown === true ||\n",
     PT, "opusRoom"),
    ("B1 hueco", "una lectura incompleta tiene hueco", P, "    account.unknown === true ||\n    account.stale === true ||\n", "    account.stale === true ||\n",
     PT, "opusRoom"),
    ("B1 hueco", "sin semanal también hay hueco", P, "    account.stale === true ||\n    account.weekly.absent === true\n  )\n", "    account.stale === true\n  )\n",
     PT, "opusRoom"),
    ("B1 hueco", "la Fable libre suma en vez de restar", P,
     "  return 100 - account.weekly.usedPercent - share * (100 - own.usedPercent);\n",
     "  return 100 - account.weekly.usedPercent + share * (100 - own.usedPercent);\n",
     PT, "opusRoom"),
    # B2 rank
    ("B2 orden", "sin el tramo de hueco", P, "    roomTier(account, options),\n", "    0,\n",
     PT, "B2"),
    ("B2 orden", "sin el tramo de hueco (servidor)", P, "    roomTier(account, options),\n", "    0,\n",
     VT, "B2: a new project goes to the Ultra with the most room"),
    ("B2 orden", "un proyecto nuevo se coloca sin la reserva", V,
     "      // The share ranks a new project by room (0.2.48, B2): without the\n"
     "      // reserve here the choice was by deadline alone (PLAN §A row 1).\n"
     "      ...reserveOf(),\n", "",
     VT, "B2: a new project goes to the Ultra with the most room"),
    ("B2 orden", "tramos redondeados en vez de truncados (9,9 y 10 en el mismo)", P,
     "  return room === null ? 0 : -Math.floor(room / ROOM_TIER);\n", "  return room === null ? 0 : -Math.round(room / ROOM_TIER);\n",
     PT, "cut: room 9.9 and 10.0"),
    ("B2 orden", "Fable en una Team no va la última", P, "    reserveOnTeam,\n", "    0,\n",
     PT, "a Team seat goes last for Fable"),
    ("B2 orden", "el hueco no ordena a Opus entre las Ultra sin Fable", P,
     "  if (!choosingReserve(options) && !holdsForReserve(options)) return 0;\n", "  if (!choosingReserve(options)) return 0;\n",
     PT, "most room first"),
    ("B2 orden", "el hueco también ordena a Haiku", P,
     "  if (!choosingReserve(options) && !holdsForReserve(options)) return 0;\n", "",
     PT, "most room first"),
    ("B2 orden", "el servidor no pasa reserveShare", V, "    reserveShare: current.reserveShare,\n", "",
     VT, "reparto por hueco"),
    # B3 roomMove
    ("B3 mover", "hueco 0 también se mueve", S, "  if (here === null || here >= 0) return null;\n", "  if (here === null || here > 0) return null;\n",
     ST, "B3"),
    ("B3 mover", "el salto exacto de 20 no basta", S, "    return room !== null && room >= here + gap;\n", "    return room !== null && room > here + gap;\n",
     ST, "cut of the gap"),
    ("B3 mover", "con hermanos, -10 ya mueve", S,
     "    (here >= ROOM_MOVE_WITH_SIBLINGS || input.movedRecently === true)\n", "    (here > ROOM_MOVE_WITH_SIBLINGS || input.movedRecently === true)\n",
     ST, "with a sibling at work, only below -10"),
    ("B3 mover", "con hermanos, un movimiento reciente no frena", S,
     "    (here >= ROOM_MOVE_WITH_SIBLINGS || input.movedRecently === true)\n", "    here >= ROOM_MOVE_WITH_SIBLINGS\n",
     ST, "not within stuckMoveMinutes"),
    ("B3 mover", "una elección a mano no frena", S,
     "      input.pinned === true ? null : roomMove(current, accounts, input, options);\n", "      roomMove(current, accounts, input, options);\n",
     ST, "a pick by hand"),
    ("B3 mover", "el servidor no pasa roomMoveGap", V, "            roomMoveGap: current.roomMoveGap,\n", "",
     VT, "B3"),
    ("B3 mover", "el servidor no dice si hay hermanos", V, "            projectSeated: projectSeated(projectId, thread.id),\n", "",
     VT, "with a sibling at work, -9.5 stays"),
    ("B3 mover", "el servidor no mira el movimiento reciente", V, " || movedRecently(projectId, now),\n", ",\n",
     VT, "no other within stuckMoveMinutes"),
    ("B3 mover", "el movimiento por hueco no se apunta", V, "      if (decision.why === \"fable-room\") roomMoves.set(projectId, now);\n", "",
     VT, "no other within stuckMoveMinutes"),
    # B4 crowded
    ("B4 atasco", "crowded vuelve a ser solo de Opus", V,
     "    if (!(limit > 0) || !current.autoSwitch) return null;\n",
     "    if (!(limit > 0) || !current.autoSwitch) return null;\n    if (!reserving({ preferredModel: model, ...reserveOf() })) return null;\n",
     VT, "B4"),
    ("B4 atasco", "Fable con plazas llenas no prefiere la Ultra", S, FABLE_TIER,
     "        ? pick(roomy)\n",
     ST, "an Ultra seat before a Team seat"),
    ("B4 atasco", "plazas para todos en una Team ganan a una plaza en Ultra", S, FABLE_TIER,
     "        ? (pick(roomy.filter((a) => a.team !== true)) ??\n          pick(roomy))\n",
     ST, "seats for all only"),
    ("B4 atasco", "el motivo habla de margen de Fable para un turno de Fable", V,
     "            return reserving(options) &&\n", "            return true &&\n",
     VT, "B4"),
    # B5 overflow
    ("B5 desagüe", "sin el desagüe en spendsReservedWeekly", P, "  if (overflowsByRoom(account, options)) return false;\n", "",
     PT, "B5"),
    ("B5 desagüe", "sin el desagüe en spendsReservedWeekly (servidor)", P, "  if (overflowsByRoom(account, options)) return false;\n", "",
     VT, "every Team seat full and main at room 46"),
    ("B5 desagüe", "la Ultra del desagüe no va detrás de las Team", P,
     "      overflowsByRoom(account, options))\n", "      false)\n",
     PT, "a Team seat with one seat goes first"),
    ("B5 desagüe", "hueco 15,0 exacto no entra", P, "    room >= threshold &&\n", "    room > threshold &&\n",
     PT, "cut: room 14.9 waits"),
    ("B5 desagüe", "100 no apaga (hueco 100 entra)", P,
     "  if (threshold === undefined || !(threshold < 100) || share === undefined)\n",
     "  if (threshold === undefined || share === undefined)\n",
     PT, "opusOverflowRoom 100 turns it off"),
    ("B5 desagüe", "también Haiku", P,
     "  if (!holdsForReserve(options) || account.team === true) return false;\n", "  if (account.team === true) return false;\n",
     PT, "Haiku and Fable keep their rules"),
    ("B5 desagüe", "sin la marca del servidor también entra", P,
     "    options.noTeamTakes?.(options.preferredModel) === true\n", "    options.noTeamTakes?.(options.preferredModel) !== false\n",
     PT, "opusOverflowRoom 100 turns it off"),
    ("B5 desagüe", "una Team llena cuenta como capaz", V,
     "      return seats.free(key) > (ahead === -1 ? queue.length : ahead);\n", "      return true;\n",
     VT, "every Team seat full and main at room 46"),
    ("B5 desagüe", "una Team con la cola igual a sus plazas cuenta como capaz", V,
     "      return seats.free(key) > (ahead === -1 ? queue.length : ahead);\n", "      return seats.free(key) >= (ahead === -1 ? queue.length : ahead);\n",
     VT, "every Team seat full and main at room 46"),
    ("B5 tope", "la hora exacta de maximumWaitHours no basta", V,
     "          now - since >= current.maximumWaitHours * 3_600_000))\n", "          now - since > current.maximumWaitHours * 3_600_000))\n",
     VT, "held past maximumWaitHours, it takes"),
    ("B5 tope", "100 no apaga la salida", V, "      current.opusOverflowRoom < 100 &&\n", "",
     VT, "held past maximumWaitHours with opusOverflowRoom 100"),
    ("B5 tope", "maximumWaitHours 0 no apaga la salida", V, "      current.maximumWaitHours > 0 &&\n", "",
     VT, "held past maximumWaitHours with opusOverflowRoom 100"),
    ("B5 tope", "la colocación no mira la espera del hilo", V, "      preferredModel: model,\n      ...reserveFor(threadId, now),\n      excursionFrom:", "      preferredModel: model,\n      ...reserveOf(),\n      excursionFrom:",
     VT, "held past maximumWaitHours, it takes"),
    ("B5 tope", "el control al arrancar no mira la espera del hilo", V,
     "    const options = { preferredModel: model, ...reserveFor(threadId, deps.now()) };\n",
     "    const options = { preferredModel: model, ...reserveOf() };\n",
     VT, "held past maximumWaitHours, it takes"),
    # Codex r1 (docs/reparto-por-hueco-2026-11-07/codex-r1.txt)
    ("r1 high 1", "la espera adelantada elige sin B5", V,
     "          ...reserveFor(threadId, now),\n          freeSeats,\n",
     "          ...reserveFor(threadId, now),\n          opusOverflowRoom: 100,\n          freeSeats,\n",
     VT, "within two passes, no project listed"),
    ("r1 high 1", "la cuenta actual de la espera adelantada se juzga sin B5", V,
     "              ...reserveFor(threadId, now),\n            })?.account) === fromName))\n",
     "              ...reserveFor(threadId, now),\n              opusOverflowRoom: 100,\n            })?.account) === fromName))\n",
     VT, "is released on main once the project is there"),
    ("r1 medium 2", "un movimiento por hueco no reserva su plaza", V,
     "      decision.why === \"current-full\" || decision.why === \"fable-room\"\n",
     "      decision.why === \"current-full\"\n",
     VT, "claims its seat on the destination"),
    ("r1 medium 3", "crowded solo mira sus propios movimientos", V,
     "    if (movedRecently(thread.projectId, now)) return null;\n",
     "    const last = crowdedMoves.get(thread.projectId)?.at;\n    if (last !== undefined && now - last <= limit) return null;\n",
     VT, "Codex r1 medium 3"),
    ("r1 medium 4", "una lectura vieja da hueco", P, "    account.stale === true ||\n", "",
     PT, "not fresh"),
    ("r1 medium 4", "una lectura vieja da hueco (servidor, colocación)", V,
     "      const measured = readStale(raw.name) ? { ...raw, stale: true as const } : raw;\n",
     "      const measured = raw;\n",
     VT, "endpoint down 31 min"),
    ("r1 medium 4", "una lectura vieja da huecoOpus en health", V,
     "                  ...(readStale(account.name) ? { stale: true as const } : {}),\n", "",
     VT, "endpoint down 31 min"),
    ("r1 medium 4", "a dos refrescos justos ya es vieja", V,
     "deps.now() - m.observedAt > maxReadAgeMs();\n", "deps.now() - m.observedAt >= maxReadAgeMs();\n",
     VT, "no query since"),
    ("r1 medium 4", "a dos refrescos y 1 ms aún es fresca", V,
     "deps.now() - m.observedAt > maxReadAgeMs();\n", "deps.now() - m.observedAt > maxReadAgeMs() + 1;\n",
     VT, "no query since"),
    ("r1 medium 5", "la Team que acaba de fallar cuenta como capaz (switch)", S,
     "  const ruledOut = stuck ? null : failedOn;\n", "  const ruledOut = null;\n",
     ST, "ruled out"),
    ("r1 medium 5", "un hilo en error también descarta la cuenta", S,
     "  const ruledOut = stuck ? null : failedOn;\n", "  const ruledOut = failedOn;\n",
     ST, "ruled out"),
    ("r1 medium 5", "el servidor no descarta la Team que acaba de fallar", V,
     "      if (a.name === ruledOut || limitedUntil(a.name, model) !== null) return false;\n", "      if (limitedUntil(a.name, model) !== null) return false;\n",
     VT, "Codex r1 medium 5"),
    ("r1 medium 5", "el juez no pasa la cuenta descartada", V,
     "      noTeamTakes: (m: string, ruledOut: string | null) => noTeamTakes(m, undefined, ruledOut),\n", "",
     VT, "Codex r1 medium 5"),
    # Codex r2 (docs/reparto-por-hueco-2026-11-07/codex-r2.txt)
    # The mark's other conditions: a refusal is out already (refusing), and
    # judged on its failure the event is a limit or a refusal (handleFailure
    # ignores the rest; «a failure that is no usage limit» checks it whole).
    ("r2 high 1", "la marca no cuenta en noTeamTakes", V,
     "      if (a.name === ruledOut || limitedUntil(a.name, model) !== null) return false;\n", "      if (a.name === ruledOut) return false;\n",
     VT, "keeps main and the turn runs there"),
    ("r2 high 1", "el juicio no deja marca", V,
     "    if (!stuck && failedOn !== null)\n      markLimited(\n", "    if (false && failedOn !== null)\n      markLimited(\n",
     VT, "keeps main and the turn runs there"),
    ("r2 high 1", "en el reinicio exacto del 429 sigue fuera", V,
     " && now < end)\n", " && now <= end)\n",
     VT, "until the 429's reset"),
    ("r2 high 1", "el reinicio del 429 no termina la marca", V,
     " && now < end)\n", ")\n",
     VT, "until the 429's reset"),
    ("r2 high 1", "un hilo en error rescatado deja marca", V,
     "    if (!stuck && failedOn !== null)\n",
     "    if (failedOn !== null)\n",
     VT, "left in error, judged on a refresh"),
    ("r2 medium 2", "stuckMoveMinutes 0 no frena B3 con hermanos", V,
     "            movedRecently: !(current.stuckMoveMinutes > 0) || movedRecently(projectId, now),\n",
     "            movedRecently: movedRecently(projectId, now),\n",
     VT, "Codex r2 medium 2"),
    ("r2 medium 2", "stuckMoveMinutes 0 frena B3 también sin hermanos", S,
     "    input.projectSeated === true &&\n    (here >= ROOM_MOVE_WITH_SIBLINGS || input.movedRecently === true)\n",
     "    (input.projectSeated === true || input.movedRecently === true) &&\n    (here >= ROOM_MOVE_WITH_SIBLINGS || input.movedRecently === true)\n",
     VT, "Codex r2 medium 2"),
    # Astra r3 (docs/reparto-por-hueco-2026-11-07/astra-r3.txt)
    ("r3 high 1", "una cuenta marcada sigue siendo destino", S, "      marked(a.name) === null,\n", "      true,\n",
     VT, "two Team seats marked"),
    ("r3 high 1", "el juicio no pasa las marcas", V,
     "      ...(heldModel(model) ? { limitedUntil: (name: string) => limitedUntil(name, model) } : {}),\n", "",
     VT, "two Team seats marked"),
    ("r3 high 1", "las marcas también cuentan para un turno de Fable", V,
     "      ...(heldModel(model) ? { limitedUntil:", "      ...(true ? { limitedUntil:",
     VT, "a retry of a told turn whose wait moves the project"),
    ("r3 high 1", "un hilo en error también mira las marcas", S,
     "    stuck ? null : (input.limitedUntil?.(name) ?? null);\n", "    input.limitedUntil?.(name) ?? null;\n",
     ST, "left in error is judged on the measurements"),
    ("r3 high 1", "una marca no retrasa la espera", S,
     "      if (until !== null) at = at === null ? null : Math.max(at, until);\n",
     "      if (until !== null) at = at === null ? null : at;\n",
     ST, "the wait is on it, at"),
    ("r3 medium 2", "la marca de un modelo vale para todos", V,
     "(scope === \"\" || scope === model.toLowerCase())", "(true)",
     VT, "Fable at 100 %"),
    ("r3 medium 2", "la marca siempre es de toda la cuenta", V,
     "        limitScope(input.accounts.find((a) => a.name === failedOn), model, now)?.toLowerCase() ?? \"\",\n", "        \"\",\n",
     VT, "Fable at 100 %"),
    ("r3 medium 2", "noTeamTakes pregunta por Fable y no por el modelo del turno", V,
     "      if (a.name === ruledOut || limitedUntil(a.name, model) !== null) return false;\n",
     "      if (a.name === ruledOut || limitedUntil(a.name, current.preferredModel) !== null) return false;\n",
     VT, "Fable at 100 %"),
    ("r3 medium 2", "la ventana propia al 100 % exacto no explica el 429", V,
     "      own.usedPercent >= 100 &&\n", "      own.usedPercent > 100 &&\n",
     VT, "Fable at 100 %"),
    ("r3 medium 2", "con la sesión llena la marca sigue siendo del modelo", V,
     "      a.session.usedPercent < 100 &&\n", "",
     VT, "the session window full"),
    ("r3 medium 2", "con la semanal general llena la marca sigue siendo del modelo", V,
     "      a.weekly.usedPercent < 100\n      ? model", "      true\n      ? model",
     VT, "the weekly_all window full"),
    ("r3 medium 3", "el permiso no sobrevive a la consulta", V,
     "      (overdueTold.has(threadId) ||\n", "      (false ||\n",
     VT, "asked again 1 ms later"),
    ("r3 medium 3", "el proceed no apunta el permiso", V,
     "      if (decision.action === \"proceed\" && overdue(ctx.thread.id, deps.now()))\n        overdueTold.add(ctx.thread.id);\n", "",
     VT, "asked again 1 ms later"),
    ("r3 medium 3", "el permiso sigue tras arrancar el turno", V,
     "    overdueTold.delete(thread.id);\n    // A hidden thread's turn too", "    // A hidden thread's turn too",
     VT, "asked again 1 ms later"),
    ("r3 medium 4", "solo los movimientos de plaza y hueco atan el proyecto", V,
     "    const seatMove = decision.account !== fromName;\n", "    const seatMove = claim !== null && decision.account !== fromName;\n",
     VT, "Astra r3 medium 4"),
    # Astra r4 (docs/reparto-por-hueco-2026-11-07/astra-r4.txt)
    ("r4 high 1", "sin reinicio informado, la marca acaba en el acto", V,
     "reportedFreeAt(event) ?? now + LIMIT_NO_RESET_MS", "reportedFreeAt(event) ?? now",
     VT, "no reset reported"),
    ("r4 high 1", "sin reinicio informado, a los 30 min justos sigue fuera", V,
     "reportedFreeAt(event) ?? now + LIMIT_NO_RESET_MS", "reportedFreeAt(event) ?? now + LIMIT_NO_RESET_MS + 1",
     VT, "no reset reported"),
    ("r4 medium 3", "una marca nueva borra las de otros ámbitos", V,
     "    const marks = limitedAt.get(name) ?? new Map<string, number>();\n", "    const marks = new Map<string, number>();\n",
     VT, "does not overwrite the account's mark"),
    ("r4 medium 3", "de dos marcas vale la que vence antes", V,
     "        until = Math.max(until ?? end, end);\n", "        until = Math.min(until ?? end, end);\n",
     VT, "till the latest of its marks"),
    # Astra r5 (docs/reparto-por-hueco-2026-11-07/astra-r5.txt)
    ("r5 medium 1", "la colocación cuenta las cuentas marcadas", S,
     "    .filter((a) => !markedOut(input, a.name))\n", "",
     ST, "the Ultra with room marked is no destination"),
    ("r5 medium 1", "la colocación cuenta las cuentas marcadas (servidor)", S,
     "    .filter((a) => !markedOut(input, a.name))\n", "",
     VT, "is not placed back on the marked Team seat"),
    ("r5 medium 1", "la cuenta actual marcada sale de la colocación", S,
     "  return name !== input.currentAccount && (input.limitedUntil", "  return (input.limitedUntil",
     ST, "a project on a marked Ultra"),
    ("r5 medium 1", "una Team sin leer marcada es destino", S,
     "  return unreadTeamSeats(input).filter((a) => !markedOut(input, a.name));\n", "  return unreadTeamSeats(input);\n",
     ST, "an unread Team seat marked"),
    ("r5 medium 1", "reserveWait no espera a que acabe la marca", S,
     "    const at = Math.max(free, input.limitedUntil?.(raw.name) ?? free);\n", "    const at = free;\n",
     ST, "reserveWait: the Ultra marked"),
    ("r5 medium 1", "el servidor no pasa las marcas a la colocación", V,
     "      limitedUntil: (name: string) => limitedUntil(name, model),\n      excursionFrom:",
     "      excursionFrom:",
     VT, "is not placed back on the marked Team seat"),
    ("r5 medium 1", "la espera adelantada suelta en una cuenta marcada", V,
     "          .filter((a) => a.name !== fromName && limitedUntil(a.name, model) === null)\n",
     "          .filter((a) => a.name !== fromName)\n",
     VT, "marked by another turn"),
    ("r5 medium 2", "un 429 sin reinicio acorta la marca del mismo ámbito", V,
     "    marks.set(scope, Math.max(marks.get(scope) ?? until, until));\n", "    marks.set(scope, until);\n",
     VT, "then one with no reset"),
    ("r5 medium 2", "dentro del ámbito gana el vencimiento más temprano", V,
     "    marks.set(scope, Math.max(marks.get(scope) ?? until, until));\n", "    marks.set(scope, Math.min(marks.get(scope) ?? until, until));\n",
     VT, "then one with no reset"),
    ("r4 medium 2", "el atado se suelta al escribir, antes del historial", V,
     "      bb.log.info(`thread ${thread.id}: ${reason}`);\n      await recordMove(\n",
     "      bb.log.info(`thread ${thread.id}: ${reason}`);\n      seatMoving.delete(projectId);\n      await recordMove(\n",
     VT, "while its history is stored"),
    ("r4 medium 2", "el atado se suelta tras el historial, antes de decirle que arranque", V,
     "    const handedOver = seatMove && when === \"before\";\n", "    const handedOver = false;\n",
     VT, "while the default's login is looked at"),
    ("r4 medium 2", "el despacho no suelta el atado al acabar", V,
     "        heldMoves.delete(ctx.thread.id);\n        releaseMove(held);\n", "        heldMoves.delete(ctx.thread.id);\n",
     VT, "holds the project's other moves while it is written"),
    ("r5 medium 3", "el atado de antes de un turno no se apunta: nadie lo suelta", V,
     "    if (handedOver) heldMoves.set(thread.id, projectId);\n", "",
     VT, "stops holding the project when its dispatch ends"),
    ("r5 medium 3", "un atado sin soltar no caduca", V,
     "    return since !== undefined && deps.now() - since < SEAT_TTL_MS;\n", "    return since !== undefined;\n",
     VT, "whose history never lands holds the project"),
    ("r5 medium 3", "a los SEAT_TTL_MS justos el atado sigue", V,
     "    return since !== undefined && deps.now() - since < SEAT_TTL_MS;\n", "    return since !== undefined && deps.now() - since <= SEAT_TTL_MS;\n",
     VT, "whose history never lands holds the project"),
    ("r4 medium 4", "cancelar no borra la salida por espera máxima", V,
     "    forgetWait(threadId);\n    overdueTold.delete(threadId);\n", "    forgetWait(threadId);\n",
     VT, "then cancelled by hand"),
    ("r4 medium 4", "sin espera apuntada, cancelar no mira la salida", V,
     "    if (asked === undefined && !overdueTold.has(threadId)) return;\n", "    if (asked === undefined) return;\n",
     VT, "then cancelled by hand"),
    # health
    ("health", "fablePerdida sin dividir por la parte de Fable", H,
     "    fablePerdida: room < 0 && reserve.share > 0 ? round1(-room / reserve.share) : 0,\n",
     "    fablePerdida: room < 0 && reserve.share > 0 ? round1(-room) : 0,\n",
     HT, "huecoOpus and fablePerdida"),
    ("health", "el servidor no pasa la reserva", V,
     "        : { reserve: { model: current.preferredModel, share: current.reserveShare } }),\n", "        : {}),\n",
     VT, "huecoOpus and fablePerdida"),
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
