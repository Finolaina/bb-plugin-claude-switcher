# Buzón del switcher: un 403 de Cloudflare vetó 6 h cinco cuentas con cuota y todo quedó esperando a una

Estado: atendido 2026-11-13 en la 0.2.53 y la 0.2.54 (de la sesión de terminal del Optimizador en el Mac, 13:05; llevado en el hilo thr_vhyiv6cwdd). La 0.2.53 (hilo thr_xvvd8n3mwn, publicada a las 13:29) cubre el punto 1 y la marca de límite del punto 5; la 0.2.54 cubre los puntos 2, 3 y 4. Cierre al final.

Palabras literales de Aitor (2026-11-13 ~12:50): «tengo problemas con el switcher y hay cuota pero todas esperan team3, fijame un hilo del switcher y podemos pasar hilos fallidos a otras cuentas ultra con cuota»

## Qué pasó (medido, no supuesto)

- Entre las 10:47 y las 11:17 (hora de Madrid) los turnos fallaron con `Failed to authenticate. API Error: 403 Attention Required! | Cloudflare` (texto literal del hilo thr_pgd7gxu6rs, `bb thread log thr_pgd7gxu6rs --limit 6`). Es un bloqueo de RED de Cloudflare a la máquina, no una cuenta sin login ni sin cuota.
- `markRefused` (server.ts) trató cada 403 como «la cuenta rechaza» y vetó la cuenta 6 h (`REFUSAL_MS`). Como cada reintento se iba a otra cuenta y volvía a dar 403, en 3 minutos quedaron vetadas viaulab, team1, team5, team2 y siloeads. Líneas del log (`bb plugin logs claude-switcher -n 60000`, buscar «refused a turn (HTTP 403)»): 30 entre las 10:47:07 y las 11:17:02.
- Solo quedó team3 sin veto: todos los proyectos se fueron a ella, llenó su sesión de 5 h a las ~12:30 y todo quedó esperando a team3 hasta las 17:00, con siloeads al 7 % de semana y 5 plazas libres y team1 al 69 % de sesión. Log: «its wait stays on team3: no other account can run Fable» y «left on siloeads (exhausted for Fable until unknown)».
- `health` lo escondía: siloeads y team1 salían «no usable: sin motivo» (`usable: false`, `problema: null`).
- Además, team1 llevaba una marca de límite hasta el 2026-11-19 12:00 con la semana al 33 % (log 10:47:28: «the reset its 429 reported (2026-11-18T01:00) matches none of its windows as read»): el reinicio de viaulab apuntado a team1.
- Arreglo de urgencia hecho por el Optimizador a las 12:58:55: `bb plugin reload claude-switcher` (los vetos viven en memoria). En 40 s arrancaron los 11 hilos de Fable (siloeads y viaulab) y los 7 de Opus/Sonnet que esperaban Team (team1, uno a siloeads).

## Qué se pide [PEDIDO, deducido de sus palabras: que no vuelva a pasar]

1. Un 403 que no es de la cuenta (HTML de Cloudflare «Attention Required», o cualquier fallo de red o del proveedor que no identifique a la cuenta) no veta ninguna cuenta. [SUPUESTO] El turno se reintenta en la misma cuenta con espera corta.
2. Cortacircuitos: si varias cuentas DISTINTAS «rechazan» en pocos minutos desde la misma máquina, el problema es la máquina o la red: no se veta ninguna, se levantan los vetos de esa racha y queda una línea STUCK en el historial que lo diga. [SUPUESTO] umbrales: 3 cuentas en 5 min.
3. `health` (texto y `--json`) dice el motivo cuando una cuenta está vetada por rechazo o marcada por límite: nunca «no usable: sin motivo». Con la hora a la que acaba.
4. Una orden para levantar a mano el veto de una cuenta sin recargar el plugin (o que `use <proyecto> <cuenta>` lo levante, como ya hace con la sesión perdida).
5. Mirar si la 0.2.52 («un reinicio que no es de la cuenta no la veta días») debía cubrir esto y por qué no lo cubrió.

## Qué se hizo, punto por punto

1. **Hecho en la 0.2.53** (`isNetworkBlock`, `networkBlocked`): la página de Cloudflare no marca cuenta ni mueve el proyecto; el turno se reintenta en la misma a los 2 min. Además, un turno que acaba bien 60 s después de un veto lo levanta (`refusalBack`).
2. **Hecho en la 0.2.54** (`stormFrom`, `stormBack`): 3 cuentas distintas en la misma máquina en 5 min abren la racha, se levantan sus vetos y queda una línea STUCK. Los umbrales salen del registro de ese día (las tres primeras en 32 s, las cinco en 2 min 47 s). Añadido sobre lo pedido [SUPUESTO de quien llevó el hilo]: la racha se cierra cuando un turno arrancado después acaba bien en esa máquina y dura 15 min como mucho; no cuentan las negativas con el cuerpo de error de la API ni las de sesión perdida (son de la cuenta); una máquina sin leer no abre racha.
3. **Hecho en la 0.2.54**: `problema` nombra el rechazo con su HTTP y su hora de fin, la marca de límite o la sesión perdida; «sin motivo» ya no puede salir. `health --json` gana `rechazos` y `red`.
4. **Hecho en la 0.2.54**: `bb claude-switcher unblock <cuenta>` quita el veto, las marcas de límite y las de sesión perdida de esa cuenta y vuelve a preguntar en el acto a los que esperan. `use` NO lo levanta: se mantiene la decisión de la 0.2.53.
5. **Mirado**: la 0.2.52 no podía cubrirlo. Su regla coteja el reinicio de un 429 con las ventanas de la cuenta antes de poner una marca de LÍMITE (`limitedAt`); el veto de 6 h es otra marca (`refusedAt`) que se ponía con solo ver `unauthorized`, sin leer el texto. La marca de team1 hasta el 19 es otra cosa: el juicio de una negativa ponía además una marca de límite con el informe de cuota guardado del hilo, que era de un 429 anterior. El registro enseña 12 de esas marcas esa mañana (cuenta nuestra) recortadas a 30 min por la regla de la 0.2.52 («matches none of its windows as read»); la de team1 no se recortó porque el reinicio del informe (2026-11-19 12:00) es el de su propia ventana semanal (`health` de las 13:09) y la regla lo dio por bueno. Esto último es deducción de esos dos datos: ninguna línea del registro lo dice. Arreglado en la 0.2.53: una negativa ya no deja marca de límite.

## Cierre

0.2.54 publicada (main 4870a4d, etiqueta v0.2.54, integración continua 43433503080 en verde) e instalada el 2026-11-13 a las 14:28 con `bb plugin update claude-switcher --yes` (el primer intento dio «HTTP 502: Bad Gateway»; el segundo, a los 7 s, entró). 1.614 pruebas, 38 mutantes de 38 muertos (`docs/veto-403-2026-11-13/mutantes.py`). Revisión: Codex sin cuota hasta el 2026-11-18, así que tres rondas de `code-reviewer` en sesión fresca con ángulos distintos: r1 REVISE con un high (cinco fallos a la vez dejaban dos cuentas vetadas; arreglado), r2 y r3 APPROVED sin high ni medium. `health` leído después de instalar: `rechazos`, `red`, `limites`, `sinSesion`, `atascos` y `esperandoTeam` vacíos; siloeads, team1, team5 y viaulab usables. `unblock` probado en producción sin efecto (`team5: nothing set aside`; cuenta desconocida, rechazada).

Qué queda:

- Sin probar con un caso real: el cortacircuitos (las pruebas reproducen la mañana del 13; no ha habido otro bloqueo) y `unblock` sobre una cuenta vetada de verdad.
- Techos escritos en `CLAUDE.md`: con la máquina del hilo sin leer y el texto del fallo ilegible se veta como antes (lo saca `unblock`); una racha dura 15 min como mucho y, si el bloqueo sigue, dos cuentas se vetan un momento hasta que la tercera la reabre; el rescate de un hilo en error no lee el texto del fallo; `problema` da la primera causa, no todas.
- Los valores [SUPUESTO] (3 cuentas, 5 min, 15 min, 10 min de racha de bloqueos; 2 min y 60 s de la 0.2.53) salen de un solo incidente.
