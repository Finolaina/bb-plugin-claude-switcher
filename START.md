# START · claude-switcher

- [ ] Tras reescribir el historial sin nombres de proyectos (Aitor, 2026-11-03 ~19:15: «Sí, borrarlos del historial»): confirmar que GitHub Support purgó las vistas en caché de los commits viejos (d01559a y los de la rama de 0.2.37). Estado en `docs/plazas-2026-11-03/START-preguntas-abiertas.md`.

## Estado de la 0.2.39 (2026-11-04)

Publicada e instalada en el servidor de bb a las 04:58 (`bb plugin list`). Marcha fino, última ronda útil: 10 de 10; las rondas 9 y 10 sin high. Lo arreglado tras la ronda 10 lleva prueba y mutante, no otra ronda.

- [ ] Pasada final de Fable, que anota hallazgos (encargo de Aitor del 2026-11-03).
- [ ] Comparar con la medida de antes, cuando haya datos: 6 turnos Opus en una cuenta que guarda la reserva en 35 h (`docs/revision-2026-11-04/PLAN.md`, cuenta nuestra).
- [ ] Sin comprobar en producción: si `thread.active` llega antes de que el turno lea la variable; la vuelta atrás a la 0.2.38.
- [ ] El Panel aún no enseña la cola: encargo en el buzón del Optimizador, `encargos/2026-11-04-buzon-panel-cola-de-trabajo.md`.
- Vigilante: `scripts/canario-cola.mjs` corre cada 10 min como una automatización de bb, con copia propia del script: al cambiarlo, `bb automation update … --script-file …`.
