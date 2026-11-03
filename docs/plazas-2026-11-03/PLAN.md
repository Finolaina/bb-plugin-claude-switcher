# 0.2.37 — mover por plazas llenas y repartir proyectos (plan para la inspección)

Encargo literal de Aitor (2026-11-03 ~12:55): «Qué tal va el sistema de carga, tengo mucha cola? necesitaría abrir más hilos por favor».

Medido (2026-11-03 13:07, `bb claude-switcher seats`/`list`, ficheros `antes-*.txt` aquí): siloeads 4/4 con 1 hilo esperando mientras ganaresenas y joytorm estaban 0/4 con cuota. siloeads tiene 25 proyectos, aitor 27, ganaresenas 11, joytorm 9.

## Fase 1 — un turno que esperaría plaza mueve antes su proyecto
- Con `autoSwitch`, en `placeTurn` (antes del turno): si la cuenta del proyecto no tiene plaza para este hilo (`seats.free <= posición en su cola`) y NINGÚN otro hilo del proyecto tiene plaza (turno en marcha o reservado), `decidePlacement` recibe `seatsFull` y elige otra cuenta con `chooseAccount` (mismo criterio que cualquier movimiento: puede correr el modelo, no gasta la semanal de Fable para otro modelo, por debajo del umbral de switch-ahead del modelo si hay) entre las que tienen plaza libre más allá de su cola (`seatRoom`).
- Ninguna con plaza → espera donde está, como antes.
- Historia: `Moved to account X before the turn: Y seats full (n/n), X had N free`.
- Proyecto con otro hilo en marcha: no se mueve (lo pidió la sesión que delega: perdería caché / cortaría un turno).
- Fuera de alcance: cambiar topes de plazas o umbrales de cuota.

## Fase 2 — `bb claude-switcher rebalance [--apply] [--json]`
- Cuentas: las Ultra usables según `health` (plan ultra, usable). Carga = max(semana %, modelo preferido %).
- Proyectos: los de esas cuentas (el default sin variable cuenta en el default). Un proyecto "trabajando" no se mueve: hilo Claude Code en starting/active/stopping, en error, con `queuedWork` waiting/failed, actividad (`updatedAt`) en la última hora, o un hilo con plaza o en cola.
- Objetivo por cuenta ∝ hueco semanal (100 − carga), con banda: ninguna más de 10 proyectos por encima de la que menos (resuelto en reales con banda 8 y redondeado). Se mueven primero los menos recientes.
- Sin `--apply` solo plan. Con `--apply`, cada movimiento en la cola del proyecto, se revalida (cuenta igual, sin plaza tomada) y queda en history como `Rebalanced: …`.

Criterios de verde: tests que reproducen A 4/4 + B 0/4 → mueve; todas llenas → espera; proyecto con hilo activo → espera; rebalance deja spread ≤ 10 y no toca proyectos trabajando; suite completa verde.

## Fase 1b (añadido de Aitor, 2026-11-03 ~13:15: «que se vayan balanceando, pero que no sea un "máximo 4"»)
- `seatsFollowLoad` (por defecto sí): una Max/Ultra tiene `seatsMax`+1 con ritmo del día < 50 % y sesión de 5 h < 40 % (o sin ventana de 5 h); `seatsMax`−1 (mínimo 1) con ritmo > 90 %; si no, `seatsMax`. Team: `seatsTeam` siempre. Nunca más de +1.
- Medida: `medir-techo.py` sobre `seats-semana.json` (una semana de muestras): 4 hilos gastan 36-42 %/h de sesión; picos de 5 hilos sin corte.
- Cada cambio de techo, al medir la cuenta, va a history (`projectId` vacío, from=to=cuenta) con su motivo; un techo que sube deja entrar al siguiente en cola.
