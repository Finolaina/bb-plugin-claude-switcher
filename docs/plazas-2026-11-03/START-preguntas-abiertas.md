# Plazas 0.2.37: lo que queda para Aitor

Encargo: «Qué tal va el sistema de carga, tengo mucha cola? necesitaría abrir
más hilos por favor» y «que se vayan balanceando, pero que no sea un "máximo
4"» (Aitor, 2026-11-03 ~12:55 y ~13:15, hilo thr_zudr84azva → thr_zf8ncnt6de).
Publicado como v0.2.37 (d01559a) e instalado en bb a las 13:56 CET
(`bb plugin source claude-switcher`).

## Preguntas abiertas (ninguna bloquea lo publicado)

1. **¿Mover también un proyecto que tiene otro hilo trabajando cuando su cuenta
   está llena?** Hoy no se mueve: ese hilo perdería la caché y podría cortarse
   su turno, así que el mensaje nuevo espera plaza. Recomendación: dejarlo así.
2. **¿Techo por encima de 5 hilos por cuenta?** No está medido: se vieron 5 a
   la vez sin cortes y nunca 6 (`medir-techo.salida.txt`). Se queda en «4 de
   base, 5 con carga baja, 3 con ritmo por encima del 90 %» mientras no haya
   medida. Subirlo es decisión tuya (`CLAUDE.md`).
3. [SUPUESTO] **Las Team siguen con 2 plazas fijas** (`seatsTeam`): el encargo
   habla de las Ultra y no hay medida de las Team con más hilos.
4. **`~/.claude-cuentas/cuota.json` no está en la máquina Linux** donde se hizo
   esto: la propuesta de techos salió del historial de plazas del propio plugin
   de la última semana (`seats-semana.json.gz`, `medir-techo.py`). Si quieres
   contrastarla con `cuota.json`, se repite `medir-techo.py` en el Mac.

## Estado al cerrar (13:58 CET, `cierre-seats.txt`)

- 0 mensajes esperando plaza. Techos por carga: joytorm 5 (ritmo 8 %), aitor 3
  (ritmo 96 %), viaulab 3 (ritmo 100 %), ganaresenas y siloeads 4.
- Reparto de proyectos (`verificar-reparto.salida.txt`): aitor 17, ganaresenas
  18, joytorm 27, siloeads 17 (antes 28/16/9/26); 20 movidos, ningún hilo vivo
  movido. Se deshace uno con `bb claude-switcher use <proyecto> <cuenta>`.

## Dónde está cada cosa

Este repo es público: la lista de proyectos, los títulos de hilos y la salida
de `rebalance` con nombres están fuera, en el almacenamiento del hilo
thr_zf8ncnt6de (`/home/aitor/.bb-machines/macbook-pro-de-aitor.tail81fad6.ts.net/thread-storage/thr_zf8ncnt6de/plazas-2026-11-03`). La primera publicación de 0.2.37 (d01559a) sí llevaba
los nombres de 79 proyectos y dos títulos de hilos; el commit siguiente los
quita de `main`, pero siguen en el historial de git (ver la pregunta 5).

5. **¿Borrar esos nombres también del historial público?** Exige reescribir
   la historia de `main` y subirla con `--force`, que solo se hace si tú lo
   pides, y también rehacer la etiqueta v0.2.37 y su release, que los llevan.
   Si no, se quedan en d01559a, visibles para quien lo busque.
