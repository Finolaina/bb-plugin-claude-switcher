# Revisión del switcher tras «cuenta agotada retiene hilos» (0.2.39): plan para Astra

Repo público: aquí no van nombres de proyectos ni títulos de hilos; la evidencia con nombres está fuera (`Optimizador/informes/2026-11-04/switcher/evidencia/`).

## Palabras literales

- Aitor, 2026-11-03 ~13:00: «también lo de las cuenta claude, que se vayan balanceando, pero que no sea un "máximo 4" quiero que el panel también se vea la cola de trabajo y así veo si algo se atasca».
- Aitor, 2026-11-03 ~23:55: «Vale, hay que revisar bien el switcher... es importante.»
- Encargo de la sesión que delega (Fable): test del estado exacto (cuenta A llena y agotada; hilo idle cuyo proyecto se pina a cuenta B con plazas libres; mensaje en cola → se entrega en B en ≤ 2 min) con mutante; una cuenta agotada para el modelo pedido deja de recibir plazas nuevas y sus hilos en espera se mueven solos; aviso cuando una cuenta retiene hilos más de 10 min con otra usable libre (log del plugin y Panel, o buzón del Panel si no tiene «Cola de trabajo»); auditoría de todos los caminos que deciden dónde corre un hilo, cada uno con test de estado real y mutante; canario cada 10 min en el servidor de bb (NUC).
- Decisión vigente: «Esperar siempre» (Aitor, 2026-11-03): Opus nunca gasta la semanal de una Max que conserva Fable; espera a la primera Team libre. Haiku no espera.
- No se tocan sin Aitor: capacidad de plazas (`seatsMax`, `seatsTeam`, techo de carga), logins, hilos activos de otros proyectos.

## Causa raíz medida (log del plugin, `list --json`, 2026-11-03 23:36 CET)

1. **Las Team ya informan de semanal.** `src/usage.ts:95` marcaba `weekly.absent` solo si `seven_day` era null (medido 2026-10-11). Hoy `list --json` da `weekly_all` en las cinco Team (team2 0 %, team3 13 %, team4 2 %, team1 37 %, team5 48 %). `spendsReservedWeekly` (`src/policy.ts:142`) usa `weekly.absent !== true` como «es una Max»: una Team con Fable por debajo de 100 % pasa a «conserva la reserva» y queda vetada para Opus. Solo quedan elegibles las Team con Fable al 100 % (team1, team5). Log: 48 movimientos por reserva a team2/3/4, el último 11-02 23:57; desde entonces 157 a team1/5 y ninguno a team2/3/4, aunque estuvieran 0/2.
2. **Por eso la cola no sigue a la cuenta del proyecto.** `reserveHold` (`server.ts:4217`) devuelve `seatOn` = la única elegible, y `beforeStart` (`server.ts:4565`) encola el hilo en la cola de plazas de esa cuenta, con el proyecto en otra. No depende de la última sesión del hilo: la hipótesis de la cola «atada a la última sesión» queda descartada por el log (hilos nuevos con el proyecto en ultra1 y ultra2 esperando en team5 a las 23:17-23:18; mismo camino).
3. **El «desatasco» por receta es un agujero.** `modelFamily` (`src/switch.ts:136`) solo entiende `claude-<familia>-…`. `bb thread tell --model opus` deja `model: "opus"` en la fila (medido en `bb thread queue list --json`) → `model = null` → no hay colocación por modelo ni `heldOff`, y con la cuenta por defecto sin login se coloca como si fuera Fable (`server.ts:4524`). Corre en la Ultra del proyecto y gasta la semanal que «Esperar siempre» protege. Log 23:20-23:35: filas borradas y reenviadas así corrieron en ultra2, ultra1 y team4.
4. **Un pin a una Ultra no decide un turno de Opus, y es correcto.** Con `use` a una Ultra que conserva Fable, el siguiente turno de Opus va a una Team o espera: lo manda «Esperar siempre». Se documenta; no se cambia.
5. **Tras un `use`, bb no vuelve a preguntar.** `recheck` solo tras admitir plaza: una fila en espera de reserva tarda hasta `RESERVE_RECHECK_MS` (5 min), y la de plazas `SEAT_RECHECK_MS` (30 s).
6. **El rebalanceo no «saltó» porque nunca salta solo**: `rebalance` solo se ejecuta por CLI (`server.ts:6471`), reparte proyectos entre Ultra y no toca los que tienen trabajo. El dato de partida «último movimiento automático a las 12:02» no casa con `history`: hay movimientos automáticos hasta las 21:32Z.
7. **La línea del log no decía por qué**: «Waiting for a seat on team5» oculta que es un turno de Opus retenido por la reserva.

## Fases

### C1 · Team es Team aunque informe de semanal (`src/policy.ts`, `measuredAccounts`)

`AccountUsage.team?: true`, puesto en `measuredAccounts` desde `planOf(cuenta, uso).plan === "team"`. `spendsReservedWeekly` es false para una Team; `spendsNoWeekly` trata la Team como la sin semanal, para que `rank` siga igual: Team sin Fable primero, luego Team con Fable por cuarto de sesión. Sigue valiendo `weekly.absent` por si una Team deja de informar. Coherente con el comentario de `reserveWait` («a Team seat; a Max account out of the reserved model») y con «espera a la primera Team libre». Ninguna Ultra entra en juego.

### C2 · Alias de modelo (`modelFamily`)

Además de `claude-<familia>-…`: `opus`, `sonnet`, `haiku`, `fable`, con sufijo opcional `[1m]`, sin distinguir mayúsculas. Lista medida con `bb provider models claude-code`. Otros (`default`, vacío) siguen siendo null.

### C3 · Cuenta agotada para el modelo: no da plazas nuevas (`decidePlacement`, `placeTurn`)

`decidePlacement` devuelve `keep` con `why: "current-blocked"` cuando la cuenta está medida sin poder correr el modelo y ninguna otra tiene plaza. Si hay otra cuenta que puede correrlo (`chooseAccount` sin mirar plazas, con la regla de reserva), `placeTurn` pone `turn.held` con `seatOn` = esa cuenta, y el hilo espera en su cola de plazas en vez de arrancar donde no puede correr. Es la misma máquina de `reserveHold`. Una espera admitida en una cuenta que después se agota se reevalúa igual al repreguntar: la reserva se pierde y sigue a la otra. La comprobación se repite en el checkpoint sobre la cuenta final, justo antes de reservar (junto a `heldOff`): un `use` que se cruza y la devuelve a una agotada, con alternativa, hace esperar y recolocar.

Si ninguna cuenta puede correr el modelo, sigue el camino de fallo actual: arranca, falla en segundos y `judge` decide la espera hasta el reset o el aviso «pasa este hilo a Opus». Lo mantengo a propósito: es lo que avisa al usuario y aplica `maximumWaitHours`. Retenerlo en la cola lo dejaría callado días. Sin plaza libre en la cuenta agotada ya espera; con plaza, la ocupa los segundos del fallo. Queda en `REVISION.md` como límite conocido.

### C3b · El modelo de cada proyecto sobrevive a una recarga

`projectModel` se guarda en KV (`project-models`) cada vez que cambia, en sus dos escritores (`message.dispatch`, `afterTurn`), con escrituras en orden y sin bloquear el despacho (como `storeHolds`), y se carga al arrancar con `at: 0`, de modo que cualquier turno nuevo manda. Sin esto, tras recargar `modelOfProject` vuelve a Fable y el rescate saca un proyecto de Opus de una Team sin Fable hacia una Ultra (medido: 7 movimientos a las 17:59Z). Un proyecto sin modelo guardado sigue juzgándose por el preferido, como hoy: lo pidió Aitor el 2026-10-30 para los proyectos con el compositor gris.

### C4 · Un `use` hace repreguntar

Con el pin aplicado (también si confirma la cuenta en la que ya está), fuera de la cola del proyecto: `recheck("message.dispatch")` para las filas retenidas por el plugin y `revisitWaits()` para los reintentos programados (`longWait`), que `recheck` no toca (contrato del SDK). Un `use` no cambia ninguna regla de reserva: una fila de Opus con el proyecto puesto a mano en una Ultra sale hacia una Team o espera.

### C5 · Línea de espera que dice el porqué

`seatWait` añade el motivo cuando la plaza es de otra cuenta: `Waiting for a seat on team5 for Opus: ultra2 keeps its weekly for Fable`. Mismo prefijo para no romper lectores.

### C6 · Aviso de atasco dentro del plugin (`src/atascos.ts`, puro)

Fuente: las filas de `bb.sdk.threads.queue.list()` con `waitingOn.kind === "plugin"`, `pluginId === "claude-switcher"` y sin `failureReason`. Cubre también las retenciones sin plaza (`reserveHold` sin `seatOn`, `heldOff`, lecturas), que no pasan por `Seats`. Fila con estado fallido (hilo archivado, medido: `failureReason: "Thread is archived"`): no cuenta.

Por fila: antigüedad desde que el plugin empezó a retenerla (`waitSince` por hilo: lo pone el checkpoint al responder `wait`, se conserva en las reevaluaciones, se borra al `proceed` o al soltarse; tras una recarga cuenta desde la primera repregunta; no `createdAt`, que incluye esperas previas ajenas); modelo `modelFamily(row.model) ?? preferido`; cuenta que retiene `seats.position(thread)?.account`, o la del proyecto si no está en una cola. Atasco si antigüedad ≥ `STUCK_WAIT_MS` (10 min) y hay otra cuenta que pasa `chooseAccount` con `freeSeats = seatRoom`, con la regla de reserva. `proyectoOcupado` si `projectSeated`.

`revisitWaits`, que ya corre en cada refresco, escribe una línea `warn` por hilo como mucho cada 10 min: `STUCK: team5 holds thread T (Opus) 12 min, team2 is free`. `health --json` y `seats` lo calculan al pedirlo: `atascos: [{hilo, cuenta, modelo, minutos, libres, proyectoOcupado}]`; si la cola no se pudo leer, `atascos: null`, nunca `[]`. Es un campo nuevo compatible con la versión 1.

El Panel no tiene «Cola de trabajo» (`grep` en `bb-plugin-panel`: solo la columna «En cola» del despachador): queda en su buzón `encargos/` la petición con las palabras de Aitor y el contrato `health.atascos`. Hueco declarado, no tapado.

### C7 · Canario independiente (`scripts/canario-cola.mjs`, `bb automation` cada 10 min en el servidor de bb)

No usa la lógica del plugin, porque el fallo de hoy fue justo que el plugin creía correcto su veto. Lee `bb thread queue list --json` y `bb claude-switcher health --json`:

- Filas con `waitingOn.pluginId === "claude-switcher"`; `primeraVez` por id de fila en un fichero de estado.
- Sin filas con `failureReason`. Por cada fila con ≥ 10 min: ¿hay una cuenta `usable` (leyendo `pctExacto`, campo nuevo de `health`: `pct` redondea y 99,6 no es 100), con plaza libre (`plazas.total === null` es sin límite) y compatible con su modelo? Compatible: la ventana de ese modelo, si la cuenta la tiene, < 100, para cualquier familia; y además, si no es Fable ni Haiku, `plan === "team"` o Fable ≥ 100.
- Sí → aviso (salida, fichero `avisos.log`, `bb plugin rpc call push-notifications notifications.send`), una vez por fila y hora. Opus con Team llenas y solo Ultra libres no avisa: es «Esperar siempre». Lectura fallida → exit 1, visible en `bb automation runs`, nunca «todo bien».
- `judge()` puro y exportado, probado en vitest. Canarios: incidente del 23:10 reconstruido debe avisar; 9:59 no; Team llenas con Ultra libre no; Team con Opus al 100 % no; `total: null` sí; fila de hilo archivado no; `bb` que falla sale 1.

### C8 · Auditoría: un test de estado real y un mutante por camino

Tests en `server.test.ts` (`describe("caminos 2026-11-04")`) con un helper que construye el estado de las 23:10 pasando por el `parseUsage` real, con la forma de la API medida en `list --json` (no de memoria), incluido `weekly_all` en Team.

| #   | Camino                 | Estado                                                         | Debe                                                                           | Mutante que debe morir                             |
| --- | ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| T1  | reserva                | Opus, proyecto en Ultra, team5 2/2, team2-4 libres con semanal | se mueve a Team con plaza, sin cola                                            | quitar `team` de `spendsReservedWeekly`            |
| T2  | pin a Team (encargo)   | fila esperando en team5; `use p team2`                         | `recheck`; al repreguntar corre en team2, en < 2 min de reloj                  | sin `recheck`                                      |
| T3 | pin a Ultra con Opus | fila esperando, `use p ultra1`, Team libres | Esperar siempre: corre en Team, no en ultra1; con Team llenas espera | quitar la reserva de `chooseAccount` |
| T4 | recarga | proyecto pasa de Fable a Opus en Team con Fable 100 y se recarga sin refresco de por medio | el rescate no lo mueve; proyecto sin modelo guardado sí se juzga por Fable | no cargar `project-models`; guardar solo en `recordSamples` |
| T5 | agotada para el modelo | Fable en cuenta con Fable 100 y plaza; otra con Fable llena | espera en la cola de la otra, no arranca; con plaza en otra, va; ninguna con Fable → camino de fallo con aviso; fila admitida y cuenta agotada después → sigue a la otra; `use` concurrente que la devuelve a la agotada (carrera de R4-001) → espera y recoloca | sin `current-blocked` en `keep`; sin la comprobación final antes de reservar |
| T6  | Esperar siempre        | Opus, todas las Team llenas, Ultra libres                      | espera; nunca a Ultra                                                          | Team/Ultra confundidas: `team` en todas            |
| T7  | Team con semanal 100   | semanal 100, Fable 0                                           | no es destino                                                                  | `isUsable` sin semanal                             |
| T8  | alias                  | fila con `opus`                                                | se trata como Opus (T1), no como Fable                                         | `modelFamily` sin alias                            |
| T9 | plazas llenas | Fable, Ultra llena, otra libre | `current-full` como en 0.2.37; con hilo trabajando se queda | `projectSeated` fuera |
| T9b | hermano activo y Opus | hilo Fable trabajando en Ultra y hermano pide Opus | se mueve a Team como desde 0.2.35, sin esperar al hermano | exigir `projectSeated` en `current-reserved` |
| T10 | cambio a Opus          | fallo por límite de Fable en Team; aviso «pasa a Opus»         | nombra Team con plaza                                                          | `opusInstead` sin `placedOn`                       |
| T11 | rebalance | proyecto en cola, proyecto con hilo trabajando | no se tocan | quitar `projectAtSeats` |
| T12 | reserve externa        | Team llena o con cola                                          | `no_free_seat`; el resto de esperas no se adelanta                             | `free <= queue` a `free <= 0`                      |
| T13 | atasco | espera de 9:59, 10:00; sin alternativa; proyecto ocupado; retención sin plaza (`heldOff`); fila fallida; fila creada hace 1 h que acaba de entrar en retención; cola ilegible | corte exacto desde la entrada en retención; `health.atascos`, `null` si ilegible; línea única | umbral a N+1; medir con `createdAt`; quitar deduplicado; `[]` al fallar |
| T14 | reintento programado tras `use` | fila `retry` con `sendAt` lejano en cuenta agotada; `use p team2` | `revisitWaits` la adelanta sin esperar al refresco | quitar `revisitWaits` de `pickAccount` |

`docs/revision-2026-11-04/mutantes.py` aplica cada mutante en un clon limpio, ejecuta su test y exige rojo; salida persistida. Baseline antes de empezar: suite completa.

### C9 · Limpieza mínima

Avisos de colisión de cuenta deduplicados (hoy 2.373 de las 10.000 líneas que guarda el log: borran la evidencia). Lo demás queda como límite conocido en `REVISION.md`:

- `seat-samples` excede el KV (571 fallos; muestras perdidas desde 2026-11-01).
- Un proyecto con un hilo trabajando no se mueve por plazas llenas (decisión 2026-11-03, solo para `current-full`). Para reserva o cuenta agotada sí se mueve, como desde 0.2.35: el turno en marcha sigue en su cuenta y el hermano sale.
- Un `use` a una Ultra no hace correr ahí un turno de Opus («Esperar siempre»).
- Si ninguna cuenta puede correr el modelo, el turno arranca y falla: así se avisa al usuario.
- Los turnos que se saltan el checkpoint de bb (217 líneas) cuentan sobre capacidad.
- `rebalance` sigue siendo manual.
- `reserve` no mira si la cuenta puede correr un modelo porque no se lo pasan.

## Fuera de alcance

Cambiar techos o logins. La rama `bb/rotador-fable-semanal…` (36 commits sin fusionar, pendiente de autorización de Aitor): no se fusiona ni se copia. Rebalanceo automático. Reiniciar hilos.

## Llegada

Versión 0.2.39, CHANGELOG, README y `CLAUDE.md` del repo; `dist` construido como en 0.2.38. Rondas: Codex Sol + `code-reviewer` a la vez, Astra tras un high y al final, parar a 2 sin high, tope 8. Fusión a `main` y tag por R-2026-11-01-5/6. Instalación en el servidor de bb con `bb plugin update claude-switcher` (fuente git; se vuelve con `bb plugin install git:…@v0.2.38`). Comprobación: `seats` con la cola de team5 vacía, filas reales en espera entregadas, canario ejecutado una vez a mano con `bb automation run`.

Evidencia externa de «hecho»: suite y mutantes en verde; veredicto de Astra; en producción, `bb thread queue list --json` sin filas retenidas con Team libre.

## Disposiciones de la revisión r1 de Astra

- **REV-001 (high), aceptado.** Fuera la excepción del pin: «Esperar siempre» no se toca sin Aitor. El atasco se arregla sin ella (C1). En `REVISION.md`, solo como límite y posible pregunta.
- **REV-002 (high), aceptado con un límite.** C3 lo cubre cuando otra cuenta puede correr el modelo. Si ninguna puede, se mantiene el camino de fallo: es el que avisa («pasa a Opus») y respeta `maximumWaitHours`; retener callado sería peor. Queda escrito arriba.
- **REV-003 (medium), caduca** al quitar el pin. Sí queda de él: un `use` también repasa los reintentos programados (C4).
- **REV-004 (high), rechazado con motivo.** Retener a Opus hasta que el hermano acabe crearía un bloqueo: la sesión orquestadora en Fable suele esperar a su hilo Opus del mismo proyecto, con su turno activo, y ese hilo esperaría a que ella acabe. Mover ya no corta el turno en marcha (bb lee la variable al empezar, y el reintento de gracia existe desde 0.2.1x). La decisión del 2026-11-03 sobre «no se mueve un proyecto con un hilo trabajando» se tomó para `current-full` (`CLAUDE.md`, `decidePlacement`). Se corrige la redacción de C9 y T9b fija el comportamiento.
- **REV-005 (high), aceptado:** C3b.
- **REV-006 (medium), aceptado:** C6 usa las filas de bb.
- **REV-007 (medium), aceptado:** C7.

## Disposiciones de la revisión r2 de Astra

- **R2-001, aceptado:** matriz corregida (el formateador había alineado la tabla y mi cambio anterior no entró); T9b y T14 añadidos.
- **R2-002, aceptado:** comprobación final en el checkpoint; se adapta el test de la carrera R4-001.
- **R2-003, aceptado:** se guarda en cada cambio.
- **R2-004, aceptado:** `waitSince`.
- **R2-005, aceptado:** `pctExacto`.

## Cambios sobre el plan aprobado (rondas 2 y 3)

- **C7, canario:** además de lo retenido con otra cuenta libre, avisa de lo retenido 2 horas sin ninguna (un aviso agrupado cada 6 horas) y de una fila que falla, salvo la de un hilo archivado, 10 minutos parada. Un aviso por hilo y tipo, no por fila. Cada llamada a `bb` tiene tiempo máximo; 30 minutos sin poder mirar avisan.
- **T15, nuevo:** una Max o Ultra sin leer, según su login, no corre Opus: va a una Team libre o espera.
- **C6:** `heldBy` solo descarta la fila de un hilo archivado.
- **T15, ampliado:** sin leer y con la Team llena entra en la cola; con todas las lecturas caídas va a una Team libre según su login.
- **T16, nuevo:** un hermano admitido en su Team y sin arrancar cierra la vuelta de la excursión hasta que arranca o caduca su plaza.
- **T16, ampliado (ronda 5):** la raíz de los tres high seguidos en `server.ts` es que la cuenta es de todo el proyecto y cada turno la lee al arrancar. El arreglo está en un solo punto, justo antes de escribir la variable (`applyAccount`), para todo movimiento automático; `placeTurn` hace esperar 30 s al turno que quería mover. Una plaza en otra cuenta no ata al proyecto, para que dos hermanos admitidos en cuentas distintas no se bloqueen entre sí.
- **T15, ampliado (ronda 5):** una Team sin leer también da cola y sirve con la Ultra leída; una Team leída o que rechazó no cuenta como sin leer; antes de las primeras lecturas no se usa ninguna a ciegas, y esas lecturas vuelven a preguntar.
