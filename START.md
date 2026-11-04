# START · claude-switcher

- [ ] Tras reescribir el historial sin nombres de proyectos (Aitor, 2026-11-03 ~19:15: «Sí, borrarlos del historial»): confirmar que GitHub Support purgó las vistas en caché de los commits viejos (d01559a y los de la rama de 0.2.37). Estado en `docs/plazas-2026-11-03/START-preguntas-abiertas.md`.

## Estado de la 0.2.40 (2026-11-04): esperando la pasada final de Fable

Encargo de Aitor, 2026-11-04, audio tareas-1: valorar las cachés que mata el cambio de cuenta y ver cómo cambiar sin perderlas, sin machacar lo demás. Informe: `docs/cambios-y-caches.md`. Opciones, simulación y veredictos: `docs/plan-cambio-en-pausas.md`.

- [ ] Pasada final de Fable sobre la rama `fix/cambio-en-pausas`. Sin ella no se fusiona ni se instala (encargo, marcha fina).
- [ ] Al instalar en el servidor de bb: `bb thread queue list` sin hilos de Opus retenidos, o avisar (PARA Y ESPERA 2 del encargo). Vuelta atrás: la 0.2.39.
- [ ] 24 h en vivo, en el registro del plugin: `Calor's tick refused`; en `bb thread log` de esos hilos, que el rechazo no deje rastro; que Calor no reescriba en otra cuenta tras un rescate; el vigilante, sin avisos nuevos. Si en 24 h no sale ningún caso (son unos 5 a la semana, cuenta nuestra), mirarlo a la semana; no se da por probado.
- [ ] Los 3 tics que escribieron en otra cuenta sin moverla ellos y los falsos «fría» de Calor: petición en `Optimizador/encargos/2026-11-04-buzon-switcher-calor-cuenta-cambiada.md`. Este repo no toca Calor.
- [ ] Codex del i9 sin sesión («refresh token was already used», 2026-11-04 11:21): las revisiones corrieron en el NUC. Falta `codex login` en el i9.
- [ ] Sin arreglar y fuera del encargo (`docs/cambios-y-caches.md`): 11 reescrituras «otra, misma cuenta» sin explicar (33,10 $, cuenta nuestra); un proceso abierto sigue en su cuenta aunque el proyecto se mueva, y un hilo corrió 13 turnos de Opus en una Max así (medir desde la 0.2.39 antes de llamarlo fuga de «Esperar siempre»); `seat-samples` no cabe en el almacén desde el 2026-11-01.

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
