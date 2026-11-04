# Cómo cambiar de cuenta sin perder la caché: opciones, simulación y qué se construye

Encargo (Aitor, 2026-11-04, audio tareas-1): «vamos a valorar las cachés que se están matando por el cambio de cuenta y vamos a ver cómo switchear sin perder la caché, pero entiendo que eso es complicado […] dale una oportunidad al plugin de ver qué opciones podríamos hacer sin machacar las otras, que ya sabemos que llevamos mucho invertido en ese plugin». Y antes: «si se quedan fríos por un cambio de cuenta, pues no queda otra».

Fase 1: `docs/cambios-y-caches.md`. Todas las cifras son **cuenta nuestra**: se recalculan con `/usr/bin/python3 docs/cambios-caches-2026-11-04/simular.py`, sobre los ficheros de esa carpeta (ventana de 7 días hasta `ahora.txt`, tarifa proxy de `analizar.py`).

## Recomendación

Construir solo la opción T, en su forma mínima: **un tic de Calor no mueve el proyecto de cuenta**. No se construye nada más. El grueso (cuota agotada, 24 cachés y 106 $ de 172 $) es «no queda otra»: la caché vive en la organización de la cuenta, y si esa cuenta no puede correr el turno no hay forma de llevársela.

T no salva una caché viva. Evita pagar una reescritura entera para un tic que nadie va a aprovechar. Se dice así porque es lo que hace.

## Lo que limita cualquier opción

- La caché es por organización. Entre Max no se conserva nunca (42 fallos, 2 aciertos); entre las cinco Team sí, salvo 3 de 24 (`comprobar.py`, `cuentas.json`).
- TTL 1 h, y la primera petición en la otra organización reescribe todo el contexto: mediana 244.820 tokens.
- La cuenta es una variable por proyecto, no por hilo: mover un proyecto afecta a todos sus hilos.

## Opciones y lo que habría salvado de las 45 cachés matadas (172,56 $)

| Opción                                                  | Salva |          $ | Regla que toca                                              | Veredicto                                            |
| ------------------------------------------------------- | ----: | ---------: | ----------------------------------------------------------- | ---------------------------------------------------- |
| **T** · un tic no cambia de cuenta                      |     3 |      12,44 | ninguna: rechaza un mensaje de mantenimiento antes de mover | **Se construye**                                     |
| A · saliendo de una Team, otra Team con plaza           |     1 |       6,68 | `rank` («lo que antes caduca se gasta antes»)               | No: una sola en la versión actual                    |
| B · volver a la cuenta con caché viva del hilo          |     3 |       8,97 | `rank` y memoria por hilo, con variable por proyecto        | No: mucha pieza nueva y riesgo para sus hermanos     |
| C · cambiar en una pausa anterior (la idea del encargo) |     0 |          0 | movimientos sin necesidad                                   | No: la simulación dice que no salva ninguna          |
| D · retrasar el cambio por plazas                       |     1 |       6,30 | «plazas por carga»                                          | No: es el mismo caso que ya recoge T                 |
| E · rescate solo si un turno lo necesita                |     2 |       3,59 | ya corregido en 0.2.39 (C3b)                                | No: anteriores a esa versión                         |
| F · esperar al reset en vez de cambiar                  |   2-5 | 9,70-25,47 | retiene hilos 30-120 min                                    | No: sin cola parada con ≤ 15 min salva 0             |
| G · elegir mejor el primero de dos cambios seguidos     |  ≤ 10 |    ≤ 30,29 | `rank`                                                      | No demostrable: oráculo, sin histórico de % de Fable |

Detalle de cada una:

- **C, cambiar en pausas.** De las 45: 27 no tuvieron una pausa de más de 1 h en las 48 h anteriores y otras 4 estaban bajo el umbral de cuota en la que hubo; con umbrales del 50 al 90 % salva 0. Y movería de 2 a 7 proyectos de los que de 2 a 5 no se habrían agotado en 48 h: reescrituras gratuitas y hueco gastado en otra cuenta.
- **A.** Team → Max son 8 (31,84 $). 5 no tenían ninguna Team libre (22,03 $). De las 3 con Team libre, 2 son Opus de la era anterior (hoy «Esperar siempre» ya los manda a Team) y queda una: `thr_5anipgjk2v`, team1 → aitor, 6,68 $.
- **G.** 21 cambios (85,69 $) llegan menos de 2 h después de otro cambio del mismo proyecto, y en 10 (30,29 $) el oráculo encuentra un destino libre mejor. Es la mayor palanca, pero sin saber el porcentaje de Fable de cada cuenta en cada momento (`usage-series` guarda 2 puntos) no se puede decir si esa cuenta habría aguantado más. No se toca el corazón del reparto con un oráculo.
- **Disponibilidad (A, B, F, G).** Reconstruida del registro de plazas y agotamientos, y conservadora: de 96 destinos reales salen 50 libres, 22 no libres y 24 sin dato; lo no libre o sin dato no cuenta como salvado.

## La opción T

Un tic es el mensaje con el que Calor mantiene viva una caché a los 24 min: `calor: tic de caché #<uuid>. Responde exactamente «calor ok»…` (`bb-plugin-calor/src/textos.ts:23`). Mover el proyecto para que corra un tic reescribe el contexto entero en la cuenta nueva a cambio de nada: su único fin es mantener una caché que, justo por moverse, ya no existe.

Medido en los 7 días (se identifica cada tic por su evento `client/turn/requested` en `bb.db`, `tics-bb.py`, y su envío por el registro de Calor):

- 8 cachés matadas (34,75 $) las pagó un tic.
- En 5 (21,05 $) el propio tic movió el proyecto, en el mismo segundo en que Calor lo envió: es lo que T evita.
  - 3 (12,44 $) sin ningún turno real que lo aprovechara después: **ahorro real**. `thr_cchh4yu89g` team5 → viaulab y viaulab → siloeads, `thr_z96afxbrbr` aitor → team5.
  - 2 (8,62 $) con un turno real después en esa cuenta antes de 6 h: T solo lo aplaza. Ese turno moverá y reescribirá igual (`thr_84p9cwbf9n` team4 → joytorm, `thr_aknxpzezuk` siloeads → aitor).
- En las otras 3 (13,70 $) el proyecto ya se había movido antes o el cambio vino de un reintento: T no las toca (ver Límites). Se pasa a Calor por su buzón.

Son unos 1,78 $/día de tarifa proxy y también 700.000 tokens escritos en cuentas de otros hilos que dejan de gastarse. Es poco; se construye porque cuesta unas 20 líneas, no toca ninguna regla de reparto y su fallo es volver a lo de hoy.

### Cómo se comporta

En el `message.dispatch` del plugin, solo si se cumplen las tres cosas: `attempt === "start-turn"`, `queuedMessages.length === 0` (el primer intento, sin fila en cola) y el texto casa la marca exacta del tic con su UUID.

- Si la colocación deja el proyecto donde está, y el turno puede correr ahí: como hoy, `proceed`. El tic mantiene la caché.
- Si la colocación movería el proyecto, o retendría el turno (plaza en otra cuenta, «Esperar siempre», un hermano a punto de arrancar): `{action: "reject"}`, sin escribir la variable, sin reservar plaza, sin entrar en la cola de plazas de ninguna cuenta y con una línea en el registro: `thread <id>: Calor's tick refused: <motivo>`.

Efecto de un rechazo, leído en el código y no probado todavía en un rechazo real:

- `bb` lanza `ApiError 409 dispatch_rejected` antes de que el mensaje pase al hilo (`bb-app 0.48.1, server/dist/start-server.js:65553` y `:97966`); nada se guarda ni se ve.
- Calor lo captura, lo registra («no se pudo enviar») y a los 5 min sin petición manda otro con opId nuevo (`bb-plugin-calor/server.ts:888-895`). Dejará de hacerlo cuando la caché caduque a la hora. Hasta unos 7 rechazos por caché, sin coste. Si entretanto la cuenta recupera plaza o cuota, el tic pasa y la caché se salva: una ganancia que la simulación no cuenta.
- El siguiente turno real se coloca como siempre.

### Lo que no cambia

- «Esperar siempre»: T no deja correr Opus en una Max. Rechaza donde hoy esperaría o movería a una Team, y nunca da paso. `decidePlacement` y `rank` no se tocan.
- Reparto entre Ultra y tope de plazas: sin cambios. Ni `seatsMax`, ni `seatsTeam`, ni `rebalance`.
- Vigilante de la cola: un rechazo en primer intento no deja fila, así que no hay nada que retener ni que falle. El cambio tras terminar un turno y la regla de no mover un proyecto con otro hilo trabajando siguen como están.
- Calor: no se toca. El cierre automático (`calor: cierre automático #…`) es trabajo real que guarda memoria, y se coloca y mueve como hoy.
- Con el cambio automático apagado (`autoSwitch: false`) no hay colocación: T no hace nada.

### Riesgos y cómo se cubren

1. **La marca cambia en Calor.** T deja de saltar y todo sigue como hoy, sin avería. El test usa el texto literal de Calor.
2. **Un humano escribe el texto exacto con un UUID válido.** Se le rechaza con un mensaje que explica el motivo. No es un caso real.
3. **Reintento en cola.** Un tic ya encolado (`queuedMessages` no vacío) se trata como hoy, porque rechazarlo dejaría una fila fallida y el vigilante avisaría. Si su reintento mueve el proyecto, pagará igual que hoy. Queda como límite y sale en el registro como cualquier movimiento.
4. **Un tic rechazado no deja huella (Astra T-001).** Hoy `dispatchDecision` apunta el modelo del hilo y del proyecto (`threadModel`, `noteProjectModel`) y la actividad (`noteActivity`) antes de colocar el turno. Un tic rechazado no ha ocurrido: si dejara su modelo, el proyecto se juzgaría después por ese modelo y `rescueStranded` podría moverlo con todos sus hilos. Para un tic elegible, esas tres anotaciones se hacen solo cuando la decisión no es un rechazo. No se guarda ni se restaura nada, así que lo que apunte un mensaje real mientras tanto se conserva.
5. **Tampoco coloca un proyecto nuevo (Astra T-002).** `beforeStart` llama a `placeNewProject` antes de `placeTurn`, y esa colocación también escribe la cuenta: un proyecto que quedó sin colocar porque las lecturas fallaron podría moverse con su primer tic. Un tic elegible no la llama; el proyecto se coloca con su siguiente mensaje real.
6. **Espera ya en curso.** Las esperas que no vienen de la colocación (asientos sin contar tras una recarga, plaza llena en la propia cuenta, `heldOff`/`blockedOff` en el punto de control) quedan como hoy: el tic espera y luego pasa por el caso 3. Son del camino de plazas, y convertirlas en rechazo exigiría deshacer entradas de la cola de plazas por un ahorro que no está medido.
7. **Un tic que falla por límite.** El camino de `decideSwitch` no cambia: un tic que arranca y falla puede cambiar de cuenta como hoy. No hay caso medido en los 5 que T evita.

## Límites

- Lo no evitado es la inmensa mayoría: 160 $ de 172 $. De ellos, 3 (13,70 $) son de tics que T no alcanza, y Calor debería pararlos con su regla de «cuenta cambiada».
- 3 casos en 7 días: en las 24 h de prueba puede no salir ninguno. Si sale cero, se dice «no se vio ninguno» y se deja un recordatorio para mirarlo a la semana; no se da por probado.
- El ahorro de cada caso depende de que no hubo un turno real en 6 h, en esa cuenta. Es lo que hubo, no lo que habría pasado si la cuenta hubiera seguido ahí.

## Interfaces y pruebas (TDD)

Interfaces: `isCalorTick(text: string): boolean` (pura, `src/switch.ts`), que casa `/^\s*calor: tic de caché #<uuid>\./`; `placeTurn` recibe en su parámetro `turn` un `tick: boolean` y devuelve en él `refused?: string`; `beforeStart` lo convierte en `{action: "reject"}` y, con un tic elegible, no llama a `placeNewProject`; `dispatchDecision` calcula si el tic es elegible al principio y aplaza `noteActivity`, `threadModel.set` y `noteProjectModel` hasta saber que no se rechaza.

Costuras donde se prueba (ninguna más):

- **`message.dispatch` del plugin, en `server.test.ts`**, con el arnés que ya existe: comprueba la decisión, la variable del proyecto, el historial, las plazas. Caza el comportamiento entero; no ve lo que hace bb con el rechazo.
- **`isCalorTick`**, en `src/switch.test.ts`. Caza la marca: literal de Calor, sin UUID, mayúsculas, cierre. No ve el camino.

Pruebas, con el estado real de cada caso del registro:

1. `thr_cchh4yu89g`: Fable, viaulab agotada, siloeads libre, tic en primer intento → rechazo; variable sin escribir, historial vacío, sin plaza reservada.
2. `thr_z96afxbrbr`: Opus en aitor (Ultra con reserva), team5 libre → rechazo; la variable sigue en aitor; Opus no corrió.
3. `thr_aknxpzezuk`: siloeads 3/3, aitor con 1 libre → rechazo; ninguna reserva en aitor.
4. Opus en una Max sin ninguna Team libre (la noche del 3 de noviembre, `docs/revision-2026-11-04/PLAN.md`) → rechazo, no espera; no entra en cola.
5. Fable en una cuenta que puede correrlo → `proceed`, sin cambios: el tic mantiene la caché.
6. Los mismos estados 1 a 3 con un mensaje normal → mueve como hoy (canario de que T no ha tocado lo real).
7. Los mismos estados con `calor: cierre automático #<uuid> (…` → mueve como hoy.
8. Tic con `queuedMessages` no vacío → como hoy, sin rechazo.
9. Tic con `attempt: "join-turn"` → `proceed`.
10. `autoSwitch: false` → `proceed`.
11. Rechazado un tic, el siguiente mensaje normal se coloca y mueve sin arrastrar nada.
12. Proyecto de Opus en una Team con Fable agotada; un tic de Fable de otro hilo parado se rechaza; tras refrescar la cuota (`rescueStranded`) el modelo guardado sigue siendo Opus, la cuenta no cambia y el historial está vacío.
13. Proyecto sin colocar, con un hilo con caché en la cuenta por defecto y las lecturas ya recuperadas a favor de otra cuenta: su tic no escribe la variable. El siguiente mensaje real sí coloca el proyecto.

Mutantes (al estilo de `docs/revision-2026-11-04/mutantes.py`; cada uno debe romper una prueba): quitar el flag al llamar a `placeTurn`, quitar la guarda de `queuedMessages`, quitar la de `attempt`, relajar la marca para que case el cierre, rechazar también cuando no movería, mover antes de comprobar el flag, no convertir `turn.held` en rechazo, anotar el modelo antes de decidir, llamar a `placeNewProject` también con un tic.

## Llegada

- `npm run check` (ahora 1210 pruebas), `tsc`, `oxlint`, mutantes todos cazados y `dist` con `bb plugin build`, versión 0.2.40.
- Codex en cada ronda hasta dos sin `high`, tope 8; pasada final de Fable antes de fusionar.
- Se instala en el servidor de bb con la cola de Opus vacía, o se avisa (PARA Y ESPERA 2 del encargo). Vuelta atrás: reinstalar 0.2.39.
- 24 h en vivo: `grep "Calor's tick refused"` en el registro del plugin, comprobar en `bb thread log` que el rechazo no deja rastro visible en el hilo y que su caché no se escribió en otra cuenta, y que el vigilante no avisó de ninguna retención nueva.
- Lo de Calor (los 3 tics que T no alcanza y sus 18 falsos «fría») va a su buzón en el Optimizador. No se toca aquí.
<!-- fin del plan revisado -->

## Veredicto de Astra

**APPROVED**, sin hallazgos, en la ronda 2 (`gpt-6-astra`, esfuerzo alto), sobre el SHA256 `e94d7198ac6a4418bf0cf0499120a7a4583cad303496f9540c390c5678f9f805` de todo lo que hay por encima de la marca de fin. Se comprueba con:

```
sed '/^<!-- fin del plan revisado -->$/,$d' docs/plan-cambio-en-pausas.md | sha256sum
```

- Ronda 1, `REVISE`, dos hallazgos medios: `T-001` (un tic rechazado dejaba su modelo apuntado) y `T-002` (un tic podía colocar un proyecto nuevo). Los dos entraron en el plan, en sus riesgos 4 y 5.
- Respuestas íntegras: `docs/cambios-caches-2026-11-04/astra-plan-r1.json` y `astra-plan-r2.json`.
- Corrió en el NUC porque la sesión de Codex del i9 está caducada («refresh token was already used», 2026-11-04 11:21).
- Astra lo dice en sus límites y aquí se repite: la aprobación es del plan, por lectura estática. Ni el rechazo en vivo ni el ahorro se han comprobado ejecutándolos.

## Cambios sobre el plan aprobado, al construir

- La guarda es `queuedMessages` vacío y la marca. Para `attempt`, basta con que `beforeStart` solo corre en `start-turn`; un tic que se une a un turno o con el cambio automático apagado anota su modelo como cualquier mensaje. Dos pruebas más que las 13 del plan lo fijan.
- La «actualización de cuota» de la prueba 12 tiene que ser una pasada real del servicio `usage-refresh`: la RPC `accounts_refresh` no ejecuta `rescueStranded` y la prueba pasaba sin comprobar nada. Corregida antes de confiar en ella; su mutante muere.
- Encontrado al implementar, sin cambio de código: con la cuota agotada, la siguiente pasada de `rescueStranded` mueve el proyecto parado aunque el tic se haya rechazado. La caché se pierde igual, pero el reintento del tic no reescribe en la cuenta nueva si Calor lo frena con su regla de cuenta distinta (`bb-plugin-calor/src/decisor.ts:354-364`, leído). De ese freno depende el ahorro en los casos de cuota. En los 7 días hubo 3 tics que escribieron en otra cuenta sin que los moviera el propio tic, sin causa aclarada: se comprueba en vivo.
- Corregido tras la inspección de código (`T-004`): `parsear-registro.py` leía como hora de Madrid las fechas de agotamiento, que el plugin escribe en UTC. Recalculado sobre los mismos registros, solo cambia F: con 30 min salva 0 (no 2/9,70 $), con 60 min 1/4,68 $ (no 3/15,84 $) y con 120 min 4/20,53 $ (no 5/25,47 $). T, A, B, C, D, E y G quedan iguales, y el veredicto de cada opción también; F sale aún peor. La tabla de arriba es la que revisó Astra y no se reescribe.
- Corregido tras la inspección final (`CACHE-F-001`): F contaba como salvadas cachés que habrían caducado antes del reset. Exigiendo que el turno vuelva con la caché viva, F salva 0 con cualquier espera de 5 a 120 min (las cifras de la línea anterior quedan sustituidas). `comprobar.py` lleva ese caso como canario. Esto refuerza el descarte de F.
- El historial de `main` se reescribió durante este trabajo (484 commits, `origin/main` 4a53435 en vez de dbc8053). Los commits se pasaron a un clon nuevo, como pide el encargo.

## Inspección del código

Cuatro rondas, ninguna con `high`. Respuestas: `docs/cambios-caches-2026-11-04/astra-inspect-r1.json` a `r4`.

| Ronda | Modelo | Veredicto | Hallazgos |
| --- | --- | --- | --- |
| 1 | gpt-6.1-sol | REVISE | medios: `dist` sin construir (T-003), fechas UTC leídas como hora de Madrid (T-004) |
| 2 | gpt-6.1-sol | APPROVED | ninguno |
| 3 | gpt-6-astra | REVISE | medio: la opción F contaba cachés ya caducadas (CACHE-F-001); ninguno en el código del plugin |
| 4 | gpt-6-astra | APPROVED | ninguno |

Las cuatro son lectura estática. Falta la pasada final de Fable y todo lo que solo se ve en vivo: que un rechazo no deje rastro en el hilo, que Calor frene su reintento tras un rescate y el ahorro real.

## Pasada final de Fable (2026-11-05 00:05, sobre 2721368): sin high

- **medium, atendido:** `isCalorTick` solo reconoce el texto del tic de `bb-plugin-calor`. Si Calor lo cambia, el switcher vuelve a mover proyectos por un tic sin que nadie lo vea. Ahora `src/switch.test.ts` lee `textoTic` del propio `bb-plugin-calor/src/textos.ts` y falla si deja de casar; se comprobó cambiando el texto en una copia. Límite: la prueba solo corre donde está el repo de Calor (`CALOR_REPO`, el directorio vecino o `~/Desarrollo/bb-plugins/`). En la CI de GitHub se salta, y si Calor cambia su texto no salta hasta que se pasen las pruebas del switcher. El tic de las sesiones interactivas («calor v2: tic de caché (sesión …)») no pasa por bb y no hace falta reconocerlo.
- **low, se aclara:** rechazar un tic no deshace nada. `placeTurn` devuelve lo mismo que cuando el proyecto se queda (`{ account: fromName, writes }`): un cambio de cuenta ya escrito antes de ese punto por otro camino sigue escrito. Lo que el rechazo garantiza es que el tic no escribe ninguno nuevo, no reserva plaza y no entra en cola.
- **low, se aclara:** un tic con mensajes en cola detrás (`queuedMessages` no vacío) se trata como un turno real y puede mover el proyecto. Es a propósito: rechazarlo dejaría filas fallidas en la cola y el vigilante avisaría (riesgo 3).
- **nota de Fable, comprobada en el diff:** `noteTurn()` solo corre cuando el tic no se rechaza, en las tres ramas.
