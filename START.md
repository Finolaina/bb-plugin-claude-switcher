# START · claude-switcher

- [ ] Tras reescribir el historial sin nombres de proyectos (Aitor, 2026-11-03 ~19:15: «Sí, borrarlos del historial»): confirmar que GitHub Support purgó las vistas en caché de los commits viejos (d01559a y los de la rama de 0.2.37). Estado en `docs/plazas-2026-11-03/START-preguntas-abiertas.md`.

## Estado de la 0.2.39 (2026-11-04)

Publicada e instalada en el servidor de bb a las 04:58 (`bb plugin list`). Marcha fino, última ronda útil: 10 de 10; las rondas 9 y 10 sin high. Lo arreglado tras la ronda 10 lleva prueba y mutante, no otra ronda.

- [x] Pasada final de Fable (hilo thr_7b3zi4mvnv, 2026-11-04): aprobada en lectura, sin bloqueantes. Hallazgos para seguimiento, sin encargo de código por ahora:
  - [ ] medium: el rescate al recargar juzga por Fable a un proyecto sin modelo guardado (movimientos y caché perdida; fue lo que movió 4 proyectos al instalar).
  - [ ] low: la primera colocación de un proyecto hace la misma suposición.
  - [ ] low: el vigilante no cuenta la cola al medir las plazas libres.
  - [ ] low: el contador del vigilante incluye filas fallidas de otro origen.
- [ ] La cola en el Panel la lleva el hilo thr_am5p64w3pp (su fase 9); integración aún sin comprobar.
- [ ] Comparar con la medida de antes, cuando haya datos: 6 turnos Opus en una cuenta que guarda la reserva en 35 h (`docs/revision-2026-11-04/PLAN.md`, cuenta nuestra).
- [ ] Sin comprobar en producción: si `thread.active` llega antes de que el turno lea la variable; la vuelta atrás a la 0.2.38.
- [ ] El Panel aún no enseña la cola: encargo en el buzón del Optimizador, `encargos/2026-11-04-buzon-panel-cola-de-trabajo.md`.
- Vigilante: `scripts/canario-cola.mjs` corre cada 10 min como una automatización de bb, con copia propia del script: al cambiarlo, `bb automation update … --script-file …`.

## Rebote de la reserva (2026-11-04, sin publicar)

Rama `despacho/switcher-reserva-rebote-limpia`, que sale de main limpio 4a53435. Encargo de Codex desde thr_zudr84azva: «prepara arreglo de regresión de reserva con prueba… solo código/revisión en rama». Marcha fino, rondas 1 y 2 sin high; última ronda útil: 2 de 2. Lo de después de la ronda 2 lleva prueba y mutante (125 mutantes, todos mueren).

- [ ] Integrar: fusión y publicación, solo con el OK de quien encargó (el mensaje lo prohíbe por ahora).
- [ ] La rama remota vieja `despacho/switcher-reserva-rebote` (bb05702) lleva el historial anterior a la limpieza. Retirarla espera al OK de Aitor (Inbox #237, lo lleva thr_zf8ncnt6de, que la tiene copiada en un bundle).
- [ ] Límite: los turnos que arranca el proveedor (una tarea en segundo plano que termina) no pasan por el punto de control. Pueden pasar de plazas, como el 3/2 de las 10:50 que dejó un hermano despertado tras mover su proyecto, o gastar la reserva. Este plugin no tiene gancho para frenarlos.
- [ ] Límite aceptado: un turno Fable espera la plaza Team de su hermano aunque casa tenga sitio (prueba R6). El canario lo puede ver como «retenido con otra libre».
