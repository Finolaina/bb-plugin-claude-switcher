# Claude Switcher (bb plugin)

Reglas de reparto que no se deducen del código; cada una con su procedencia.

- **Cuenta con las plazas llenas → el proyecto se mueve a otra con plaza** (0.2.37). Encargo de Aitor del 2026-11-03 («Qué tal va el sistema de carga, tengo mucha cola? necesitaría abrir más hilos por favor», hilo thr_zudr84azva → thr_zf8ncnt6de): con el cambio automático encendido, un turno que esperaría plaza mueve antes su proyecto a la mejor otra cuenta con plaza libre (más allá de las que deben a su cola), con el criterio de cualquier movimiento (`chooseAccount`); solo espera si ninguna tiene plaza. No se mueve un proyecto con otro hilo en marcha (perdería caché y podría cortar un turno). Código: `decidePlacement` (`seatsFull`, `src/switch.ts`) y `seatsFullFor` en `server.ts`.
- **Reparto de proyectos entre las Ultra** (`bb claude-switcher rebalance [--apply]`, 0.2.37; mismo encargo): por hueco semanal, ninguna Ultra usable más de 10 proyectos por encima de la que menos tiene; los proyectos con hilo trabajando (turno, cola, error, plaza o actividad en la última hora) no se tocan. Cada movimiento queda en `history` como «Rebalanced» y se deshace con `use <proyecto> <cuenta>`.
- **No se tocan sin preguntar a Aitor**: el tope de plazas por cuenta (`seatsMax` 4, `seatsTeam` 2) y los umbrales de cuota; los midió él con el freno de ritmo (encargo del 2026-11-03).
