# Plazas 0.2.37-0.2.38: decisiones y estado

Encargo: «Qué tal va el sistema de carga, tengo mucha cola? necesitaría abrir
más hilos por favor» y «que se vayan balanceando, pero que no sea un "máximo
4"» (Aitor, 2026-11-03 ~12:55 y ~13:15, hilo thr_zudr84azva → thr_zf8ncnt6de).
Publicado como v0.2.37 (d01559a) e instalado en bb a las 13:56 CET
(`bb plugin source claude-switcher`).

## Decidido (Fable, hilo thr_zudr84azva, 2026-11-03 18:50; Aitor 19:15)

1. **No se mueve un proyecto con un hilo trabajando**: se queda como está.
2. **Techo**: no hay número fijo; manda la carga (Aitor, 2026-11-03: «que no
   sea un "máximo 4"»). Hoy la medida solo respalda un 5.º hilo (se vieron 5 a
   la vez sin cortes y nunca 6, `medir-techo.salida.txt`), así que el 6.º no
   se admite hasta que una medida lo respalde.
3. **Las Team siguen con 2 plazas fijas** (`seatsTeam`).
4. `~/.claude-cuentas/cuota.json` no está en la máquina Linux: la propuesta de
   techos salió del historial de plazas del plugin (`seats-semana.json.gz`).
5. **Nombres de proyectos fuera del repo público, también del historial**
   (Aitor, 2026-11-03 ~19:15: «Sí, borrarlos del historial»).

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
quita de `main`, y el historial se reescribió sin ellos (ver «Decidido», punto 5).
