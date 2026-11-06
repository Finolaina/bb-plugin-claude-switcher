# START · claude-switcher

- [ ] Tras reescribir el historial sin nombres de proyectos (Aitor, 2026-11-03 ~19:15: «Sí, borrarlos del historial»): confirmar que GitHub Support purgó las vistas en caché de los commits viejos (d01559a y los de la rama de 0.2.37). Estado en `docs/plazas-2026-11-03/START-preguntas-abiertas.md`.

## Estado de la 0.2.45 (2026-11-06): modelo de cada proyecto sembrado al cargar

Página de limpieza del 2026-11-06, punto 60 (Aitor, 12:25: «Puedes resolver hilos o decisiones de cosas que pueden estar pendientes, atascadas o ocupando hilos…»; Fable: «terminar tal como lo propone la página»). Cierra el medium de la pasada final de Fable sobre la 0.2.39 (más abajo).

- [x] Siembra al cargar, pruebas y mutantes (`docs/modelo-al-cargar-2026-11-06/`).
- [ ] Revisión Codex, fusión, etiqueta `v0.2.45` e instalación: ver el informe del encargo.
- [ ] Sin cubrir (low de la misma pasada): la primera colocación de un hilo nuevo (`placeProject`) juzga por el preferido; el modelo de ese hilo aún no se conoce.

## Estado de la 0.2.44 (2026-11-06): Opus y Sonnet solo por Team

Encargo de Aitor, 2026-11-06 09:33 (por Fable, hilo thr_vhyiv6cwdd): «el switcher sigue gastando más Opus que Fable y no tira de las cuentas Team… los Opus tienen que salir por Team sí o sí». Medida de antes: `docs/opus-por-team-2026-11-06.md`.

- [x] Regla, pruebas (1304) y 26 mutantes (`docs/opus-por-team-2026-11-06/mutantes.salida.txt`). Revisión Codex en el NUC, marcha normal, última ronda útil: 4 de 4. r1 (3 high) y r2 (1 high) arreglados con prueba y mutante; r3 y r4 sin high (`codex-r1.md` … `codex-r4.md`).
- [ ] Medios de r4 sin arreglar (ninguno mete Opus en una Max/Ultra): un reintento o fallo de Fable que mueve el proyecto puede borrar el pin; una espera de Opus no se suelta hacia una Team sin leer (se coloca al vencer); un login Team sin ventana de 5 h cuenta como Ultra (decisión del canario 1 de `src/accounts.test.ts`); con la cuenta del proyecto ilegible y solo Teams agotadas, el turno arranca al 4.º intento en una Team.
- [ ] [SUPUESTO] La espera en una Team agotada no tiene el tope de `maximumWaitHours`; PARA Y ESPERA 1 del encargo: si todas las Team se quedan sin cuota y hay más de 5 hilos de Opus esperando más de 30 min, avisar a Aitor.
- [ ] Hueco que el switcher no puede cerrar: los subagentes de Opus de un hilo de Fable corren en la cuenta del hilo (80 % de los tokens de Opus en las Ultra en la medida, cuenta nuestra).

## Estado de la 0.2.41 (2026-11-05 00:30): en rama `fix/atasco-noche`, en revisión

Encargo de Aitor, 2026-11-05 00:20 (por Fable, hilo thr_gar882gnyj): «hay demasiadas cosas atascadas … resuelve si es cosa de swicher … ponte loops … abre un poco la mano … Tenemos opus!». Causa y cifra: Optimizador `informes/2026-11-05/switcher-noche/CAUSA.md` (24 h de espera el 4-nov, cuenta nuestra; todas con un hermano del proyecto trabajando).

- [x] Reglas (a) espera > `stuckMoveMinutes`, (b) `use` aguanta, (c) más hilos que plazas, Opus en Ultra ≤ `otherModelUpTo`: código y pruebas en verde (1253) y 135 mutantes (`docs/revision-2026-11-04/mutantes.salida.txt`).
- [x] Revisión: Codex no disponible (sesión revocada en el NUC y el Mac, sin login en el i9), así que code-reviewer en sesión limpia con el mismo encargo (regla de Aitor, 2026-09-28). Marcha normal, última ronda útil: 4 de 4. r1 y r2 con high (Team primero, rebote, hilo atascado a la Ultra con una Team libre), arreglados con prueba y mutante; r3 y r4 sin high.
- [ ] Low de r3/r4 sin arreglar, a la espera de uso real: dos hilos del mismo proyecto pueden moverlo a la vez en la misma revisión de 30 s (dos líneas en el historial, nada roto); el adelanto por límite (`switchAhead*Percent`, a 0 de serie) no respeta un `use`; un `pins` guardado que no case con el esquema se pierde sin aviso y no hay prueba de recarga; tras el freno de `stuckMoveMinutes` un proyecto de muchos hilos puede volver a una Team y rebotar cada 10 min; el texto de «Team primero» en el camino `after` sale genérico.
- [ ] Fusión, etiqueta `v0.2.41`, `bb plugin update claude-switcher` en el NUC (arrastra la 0.2.40 sin instalar: se instala con cola porque deshacer esa cola es el encargo), 30 min de `seats` sin STUCK.
- [ ] Bucle temporal `switcher-desatasco` (systemd --user en el i9, cada 10 min, `scripts/desatasco-noche.py`): se apaga solo con la 0.2.41 instalada o a las 08:00. Registro: `~/.claude/state/switcher-desatasco.jsonl` y `…-pasadas.log` en el i9.
- [ ] [SUPUESTO] 10 min y 50 % son los valores por defecto que puso la sesión que delegó; no medidos. Cambiarlos es de Aitor.

## Estado de la 0.2.40 (2026-11-05): fusionada, sin instalar

Encargo de Aitor, 2026-11-04, audio tareas-1: valorar las cachés que mata el cambio de cuenta y ver cómo cambiar sin perderlas, sin machacar lo demás. Informe: `docs/cambios-y-caches.md`. Opciones, simulación y veredictos: `docs/plan-cambio-en-pausas.md`.

- [x] Pasada final de Fable (2026-11-05 00:05, sobre 2721368): sin high; sus hallazgos, en `docs/plan-cambio-en-pausas.md` §Pasada final. Fusionada en `main` (486fae7) con la etiqueta `v0.2.40`; CI de `main` en verde.
- [ ] **PARA Y ESPERA 2:** sin instalar. A las 00:05-00:25 del 2026-11-05 seguía habiendo hilos de Opus retenidos esperando plaza en team2 y team5 (`bb thread queue list --json`). Instalar con la cola vacía (`bb plugin update claude-switcher`, que lleva a `v0.2.40`) o cuando Aitor diga. Vuelta atrás: la 0.2.39.
- [ ] 24 h en vivo, en el registro del plugin: `Calor's tick refused`; en `bb thread log` de esos hilos, que el rechazo no deje rastro; que Calor no reescriba en otra cuenta tras un rescate; el vigilante, sin avisos nuevos. Si en 24 h no sale ningún caso (son unos 5 a la semana, cuenta nuestra), mirarlo a la semana; no se da por probado.
- [ ] Los 3 tics que escribieron en otra cuenta sin moverla ellos y los falsos «fría» de Calor: petición en `Optimizador/encargos/2026-11-04-buzon-switcher-calor-cuenta-cambiada.md`. Este repo no toca Calor.
- [ ] Codex del i9 sin sesión («refresh token was already used», 2026-11-04 11:21): las revisiones corrieron en el NUC. Falta `codex login` en el i9.
- [ ] Sin arreglar y fuera del encargo (`docs/cambios-y-caches.md`): 11 reescrituras «otra, misma cuenta» sin explicar (33,10 $, cuenta nuestra); un proceso abierto sigue en su cuenta aunque el proyecto se mueva, y un hilo corrió 13 turnos de Opus en una Max así (medir desde la 0.2.39 antes de llamarlo fuga de «Esperar siempre»); `seat-samples` no cabe en el almacén desde el 2026-11-01.

## Estado de la 0.2.39 (2026-11-04)

Publicada e instalada en el servidor de bb a las 04:58 (`bb plugin list`). Marcha fino, última ronda útil: 10 de 10; las rondas 9 y 10 sin high. Lo arreglado tras la ronda 10 lleva prueba y mutante, no otra ronda.

- [x] Pasada final de Fable (hilo thr_7b3zi4mvnv, 2026-11-04): aprobada en lectura, sin bloqueantes. Hallazgos para seguimiento, sin encargo de código por ahora:
  - [x] medium: el rescate al recargar juzga por Fable a un proyecto sin modelo guardado (movimientos y caché perdida; fue lo que movió 4 proyectos al instalar). Arreglado en la 0.2.45.
  - [ ] low: la primera colocación de un proyecto hace la misma suposición.
  - [ ] low: el vigilante no cuenta la cola al medir las plazas libres.
  - [ ] low: el contador del vigilante incluye filas fallidas de otro origen.
- [ ] La cola en el Panel la lleva el hilo thr_am5p64w3pp (su fase 9); integración aún sin comprobar.
- [ ] Comparar con la medida de antes, cuando haya datos: 6 turnos Opus en una cuenta que guarda la reserva en 35 h (`docs/revision-2026-11-04/PLAN.md`, cuenta nuestra).
- [ ] Sin comprobar en producción: si `thread.active` llega antes de que el turno lea la variable; la vuelta atrás a la 0.2.38.
- [ ] El Panel aún no enseña la cola: encargo en el buzón del Optimizador, `encargos/2026-11-04-buzon-panel-cola-de-trabajo.md`.
- Vigilante: `scripts/canario-cola.mjs` corre cada 10 min como una automatización de bb, con copia propia del script: al cambiarlo, `bb automation update … --script-file …`.
