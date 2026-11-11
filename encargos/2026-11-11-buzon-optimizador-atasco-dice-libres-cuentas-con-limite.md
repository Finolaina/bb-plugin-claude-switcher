# Buzón del switcher: «atasco … libres: team2, viaulab» nombra cuentas que el propio plugin sabe limitadas para ese modelo

Estado: EN EL BUZÓN (2026-11-11, de thr_z5m6f8ct5r, Optimizador · continuación)

## Qué vi (2026-11-11 10:14-10:24; salida guardada en `Optimizador/informes/2026-11-11/switcher-atasco/estado-1024.out.txt`)

- `bb claude-switcher health` y `seats` listaban 5-7 hilos atascados 15-26 min con «libres: team2, viaulab» (11 plazas vacías), casi todos de Fable, y ninguno se movía pese a `stuckMoveMinutes` (10; `CHANGELOG.md:109`).
- El `history` del mismo momento dice por qué no valen: «viaulab answered Fable with a usage limit until 2026-11-16 08:00» (09:14:09Z) y, al fijar yo a mano «Sistema Claude · guardrails» en team2, «team2 answered Opus with a usage limit that has not reset yet» → movido a joytorm antes del turno (09:19:20Z).
- `health` daba a la vez team2 «ses 0% · sem 35% · usable» y viaulab «Fable 26% · usable».
- thr_395w2paadw (Opus) llevaba 20 min esperando plaza en team3 (5/5) con «libres: joytorm, team2, viaulab»; solo arrancó cuando fijé el proyecto a mano (fijación quitada después, a las 10:25).

## Qué se pide [SUPUESTO: lo propone el Optimizador; no es encargo literal de Aitor]

1. Que «libres» en las líneas de atasco y «usable» en `health` descuenten, por modelo, las cuentas con un límite conocido sin reponer (lo que ya usa el movimiento «before the turn»). Si no queda ninguna, que la línea lo diga: «sin cuenta con <modelo> libre hasta <hora>».
2. Mirar por qué un hilo de Opus con joytorm libre (1/4) no se movió solo en 20 min.
3. Dato para el reparto: a las 10:14 Fable solo tenía plaza en mariscal y aitor (8 plazas, las 8 ocupadas); viaulab, ganaresenas, joytorm y siloeads estaban sin Fable.
