# Cachés que mata el cambio de cuenta (7 días)

Ventana: 10-28 11:10 a 11-04 11:10 (hora de Madrid), 2026. Encargo: Aitor, 2026-11-04, audio tareas-1, «vamos a valorar las cachés que se están matando por el cambio de cuenta». Todas las cifras son **cuenta nuestra**, recalculables con `python3 docs/cambios-caches-2026-11-04/informe.py` desde los ficheros de esa carpeta (se extraen con `rehacer.sh`). Los dólares son tarifa de API usada como proxy: las cuentas son suscripciones y nadie paga esa cantidad; lo que se gasta es cuota.

## Resultado

- **2069 movimientos** en el registro del plugin, pero solo **119 cambios reales** de cuenta en un hilo (el proceso de Claude arrancó en otra cuenta): la mayoría de los movimientos son de proyectos parados que no se notan hasta el siguiente turno, y muchos se pisan entre sí.
- **45 mataron una caché viva**: 10.494.769 tokens reescritos, ≈ 172,56 $ en la semana (≈ 24,65 $/día, proxy). Contexto de cada una: mediana 244.820, máximo 365.100 tokens.
- 21 cambios no perdieron nada porque fueron de una Team a otra: **team1 a team5 son la misma organización** (hash en `cuentas.json`, leído de `oauthAccount.organizationUuid` en las dos máquinas) y su caché se comparte. Con hueco de menos de 1 h, sin compactar ni cambiar de modelo: entre Team, 21 aciertos y 3 fallos; entre organizaciones distintas, 42 fallos y 2 aciertos. Esto corrige lo que dábamos por hecho («cada cuenta es su organización»): vale para las Max, no para las Team.
- 30 cambios llegaron con la caché ya caducada (pausa de más de 1 h antes del cambio): no mataron nada. 5 más estaban vivas al mover el proyecto, pero el siguiente turno llegó pasada la hora: sin tics habrían caducado igual.
- Proporción: de todo lo reescrito en estos 7 días por los hilos de bb (≈ 457,90 $, proxy), el cambio de cuenta con caché viva es el 38 %.

## Canario: el hilo de la mudanza al i9

| Hora | De → a | Hueco antes | Clase | Tokens escritos en la 1.ª petición | Motivo |
| --- | --- | --- | --- | --- | --- |
| 11-04 06:05 | joytorm → team5 | 130,90 min | fria | 256.177 | reserva |

Sale en la tabla y cambió a las ~06:05, como decía el encargo, pero **no mató una caché viva**: su última petición fue más de 2 h antes, la caché ya había caducado y esa reescritura se habría pagado sin cambiar de cuenta. Calor lo marca «fría: la cuenta del proyecto cambió»; la causa real es la pausa.

## Reparto por motivo

Cuántos cambios reales, y qué pasó con su caché. «Movimientos» son las líneas del registro, por eso no suman lo mismo.

| Motivo | Movimientos | Cambios reales | Mataron | Tokens | $ (proxy) | Caducó tras mover | Ya fría | Sin pérdida (Team) | Modelo o compactación |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cuota agotada (el turno falla o la cuenta ya no puede) | 277 | 40 | 24 | 5.628.818 | 106,26 | 0 | 4 | 10 | 2 |
| cuota casi agotada (cambio anticipado) | 35 | 2 | 1 | 176.508 | 1,41 | 0 | 0 | 0 | 0 |
| rescate de proyectos parados en una cuenta agotada | 842 | 14 | 6 | 1.520.655 | 25,03 | 3 | 2 | 0 | 3 |
| cuenta sin login | 122 | 4 | 0 | 0 | 0,00 | 0 | 1 | 0 | 3 |
| regla «Esperar siempre» (Opus sale de una Max) | 452 | 36 | 8 | 1.718.022 | 13,74 | 1 | 15 | 7 | 5 |
| vuelta tras esa excursión | 68 | 2 | 2 | 356.940 | 4,23 | 0 | 0 | 0 | 0 |
| plazas llenas | 3 | 2 | 1 | 314.820 | 6,30 | 0 | 0 | 1 | 0 |
| mover a mano (`use`) | 247 | 11 | 1 | 357.328 | 7,15 | 1 | 6 | 0 | 3 |
| `rebalance` | 23 | 0 | 0 | 0 | 0,00 | 0 | 0 | 0 | 0 |
| sin línea en el registro | 0 | 8 | 2 | 421.678 | 8,43 | 0 | 2 | 3 | 0 |
| **Total** | **2069** | **119** | **45** | **10.494.769** | **172,56** | **5** | **30** | **21** | **16** |

2 cambios entre organizaciones leyeron la caché y no sabemos por qué (fuera de la tabla: es el error del método). `reserva` incluye tiempo anterior a «Esperar siempre» (2026-11-03).

## De dónde sale cada reescritura de la semana

| Causa | Veces | Tokens | $ (proxy) |
| --- | ---: | ---: | ---: |
| cambio de cuenta con la caché viva | 45 | 10.494.769 | 172,56 |
| pausa de más de 1 h, misma cuenta | 37 | 7.156.273 | 102,63 |
| pausa de más de 1 h, cuenta cambiada después | 30 | 7.302.241 | 91,25 |
| otra, misma cuenta | 11 | 2.051.638 | 33,10 |
| cambio de modelo, cuenta cambiada | 6 | 1.619.916 | 16,61 |
| compactación, misma cuenta | 8 | 665.571 | 11,62 |
| compactación, cuenta cambiada | 10 | 785.836 | 10,82 |
| cambio de modelo, misma cuenta | 3 | 661.774 | 10,06 |
| pausa de más de 1 h, cuenta cambiada mientras | 5 | 1.155.726 | 9,25 |

## Calor frente a la medida

`bb calor list` da 18 hilos «fría: la cuenta del proyecto cambió» de 35, a la hora de la ventana. Medido con su última petición y la cuenta real de su proceso:

- caducada por tiempo: 17
- viva, pero el siguiente turno irá a otra organización: 1

Calor juzga por la variable del proyecto: no sabe que entre Team la caché sigue viva, ni que un proceso abierto sigue en su cuenta. Se pide aparte a su buzón; este encargo no lo toca.

## Las cachés matadas, una a una

| Hora | Hilo | De → a | Motivo | Hueco (min) | Contexto (tokens) | $ (proxy) | Modelo |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 10-29 15:50 | thr_cchh4yu89g | team1 → team2 | sin-registro | 11,30 | 110.703 | 2,21 | fable-5-1 |
| 10-29 16:35 | thr_cchh4yu89g | team4 → team5 | cuota | 24,00 | 257.657 | 5,15 | fable-5-1 |
| 10-29 17:30 | thr_cqb2ts9i5z | team5 → viaulab | cuota | 5,30 | 150.828 | 3,02 | fable-5-1 |
| 10-29 17:30 | thr_84p9cwbf9n | team5 → viaulab | cuota | 5,50 | 159.749 | 3,19 | fable-5-1 |
| 10-29 17:48 | thr_cchh4yu89g | team5 → viaulab | cuota | 27,00 | 276.256 | 5,53 | fable-5-1 |
| 10-29 17:50 | thr_84p9cwbf9n | viaulab → siloeads | cuota | 8,30 | 240.712 | 4,81 | fable-5-1 |
| 10-29 17:51 | thr_cqb2ts9i5z | viaulab → siloeads | cuota | 0,20 | 276.099 | 5,52 | fable-5-1 |
| 10-29 18:13 | thr_cchh4yu89g | viaulab → siloeads | cuota | 24,00 | 292.502 | 5,85 | fable-5-1 |
| 10-29 18:37 | thr_cchh4yu89g | siloeads → team3 | sin-registro | 24,00 | 310.975 | 6,22 | fable-5-1 |
| 10-29 22:35 | thr_84p9cwbf9n | team5 → viaulab | cuota | 4,40 | 271.928 | 5,44 | fable-5-1 |
| 10-29 23:43 | thr_84p9cwbf9n | viaulab → siloeads | cuota | 0,10 | 133.078 | 2,66 | fable-5-1 |
| 10-29 23:43 | thr_axt5mng92e | viaulab → siloeads | cuota | 6,70 | 244.820 | 4,90 | fable-5-1 |
| 10-30 01:20 | thr_axt5mng92e | siloeads → team3 | a-mano | 35,70 | 357.328 | 7,15 | fable-5-1 |
| 10-30 05:03 | thr_axt5mng92e | team2 → viaulab | cuota | 0,10 | 242.737 | 4,86 | fable-5-1 |
| 10-30 21:09 | thr_a85gd6ivby | aitor → team2 | rescate-cuota | 28,20 | 290.323 | 2,32 | opus-5-5 |
| 10-31 17:43 | thr_axt5mng92e | team2 → joytorm | cuota | 34,30 | 100.655 | 0,81 | opus-5-5 |
| 10-31 17:47 | thr_84p9cwbf9n | team4 → joytorm | cuota | 39,10 | 290.356 | 2,32 | opus-5-5 |
| 10-31 18:04 | thr_czjftgsdij | viaulab → joytorm | rescate-cuota | 0,20 | 157.992 | 1,26 | opus-5-5 |
| 11-01 17:04 | thr_9biibrdste | joytorm → viaulab | cuota-previa | 0,40 | 176.508 | 1,41 | opus-5-5 |
| 11-01 17:23 | thr_bhr5kxmtd7 | joytorm → ganaresenas | reserva | 16,80 | 145.733 | 1,17 | opus-5-5 |
| 11-01 17:52 | thr_9biibrdste | viaulab → joytorm | reserva-vuelta | 15,90 | 242.181 | 1,94 | opus-5-5 |
| 11-01 17:55 | thr_9biibrdste | joytorm → ganaresenas | reserva | 1,60 | 255.149 | 2,04 | opus-5-5 |
| 11-02 14:21 | thr_7z6auanpxm | joytorm → siloeads | cuota | 14,10 | 332.385 | 6,65 | fable-5-1 |
| 11-02 14:23 | thr_sn2epw86qf | joytorm → siloeads | cuota | 10,60 | 152.574 | 3,05 | fable-5-1 |
| 11-02 14:56 | thr_jwz544abwe | joytorm → siloeads | cuota | 46,90 | 234.213 | 4,68 | fable-5-1 |
| 11-02 18:21 | thr_am5p64w3pp | siloeads → aitor | rescate-cuota | 1,00 | 326.145 | 6,52 | fable-5-1 |
| 11-02 18:33 | thr_sn2epw86qf | siloeads → ganaresenas | cuota | 0,40 | 310.182 | 6,20 | fable-5-1 |
| 11-02 18:34 | thr_ga83w92hzp | siloeads → ganaresenas | cuota | 0,00 | 170.957 | 3,42 | fable-5-1 |
| 11-02 18:45 | thr_am5p64w3pp | aitor → ganaresenas | rescate-cuota | 15,60 | 365.100 | 7,30 | fable-5-1 |
| 11-02 18:55 | thr_jwz544abwe | siloeads → aitor | cuota | 36,80 | 307.226 | 6,14 | fable-5-1 |
| 11-02 19:46 | thr_6nn396b2dz | viaulab → team1 | reserva | 1,10 | 285.814 | 2,29 | opus-5-5 |
| 11-02 21:25 | thr_akbr5rgp42 | aitor → ganaresenas | rescate-cuota | 7,00 | 211.402 | 4,23 | fable-5-1 |
| 11-02 21:30 | thr_svtdz736gf | viaulab → team1 | cuota | 0,10 | 135.484 | 1,08 | opus-5-5 |
| 11-02 22:55 | thr_z96afxbrbr | aitor → team5 | reserva | 24,00 | 132.591 | 1,06 | opus-5-5 |
| 11-03 09:50 | thr_8qm6u8sjya | siloeads → team1 | reserva | 0,10 | 154.410 | 1,24 | opus-5-5 |
| 11-03 18:22 | thr_8y3tvh8gqa | aitor → team5 | reserva | 0,00 | 355.912 | 2,85 | opus-5-5 |
| 11-03 19:00 | thr_5anipgjk2v | joytorm → siloeads | rescate-cuota | 8,10 | 169.693 | 3,39 | fable-5-1 |
| 11-03 19:37 | thr_akbr5rgp42 | joytorm → siloeads | reserva-vuelta | 55,10 | 114.759 | 2,29 | fable-5-1 |
| 11-03 19:43 | thr_5anipgjk2v | siloeads → ganaresenas | cuota | 22,50 | 249.864 | 5,00 | fable-5-1 |
| 11-03 19:58 | thr_i7ssiv8nxa | team1 → team5 | reserva | 4,40 | 105.960 | 0,85 | opus-5-5 |
| 11-03 21:08 | thr_sq9iuikj6x | siloeads → aitor | cuota | 11,80 | 301.532 | 6,03 | fable-5-1 |
| 11-03 21:15 | thr_aknxpzezuk | siloeads → aitor | plazas | 24,00 | 314.820 | 6,30 | fable-5-1 |
| 11-04 00:04 | thr_pf5wnyyu4p | siloeads → aitor | cuota | 0,10 | 163.232 | 3,27 | fable-5-1 |
| 11-04 00:05 | thr_5anipgjk2v | team1 → aitor | cuota | 0,10 | 333.792 | 6,68 | fable-5-1 |
| 11-04 05:21 | thr_q35zzqi62x | siloeads → team5 | reserva | 10,20 | 282.453 | 2,26 | opus-5-5 |

## Cómo se mide

- **Unidad**: la tanda, un mensaje procesado, de `thread/tokenUsage/updated` en `bb.db` (leída en solo lectura, `extraer.py`): 1964 tandas de 434 hilos de Claude Code. Cada una lleva {'3600000': 1964} como `promptCacheTtlMs`, de ahí 1 h.
- **Cuenta real de cada tanda**: el `provider.env-resolved` que arrancó el proceso, el que llega pegado a `turn/started` o con el hilo parado. El que llega con un turno abierto no cambia nada (un `tell` que entra en un turno en marcha), y el «running on» del registro del plugin dice dónde está el proyecto, no dónde corre el proceso. Prueba: con esa regla, 2 sin explicar; sin ella salían 17 en esta misma semana (medido antes de añadirla).
- **¿Se perdió la caché?** Primera petición de la tanda, de la transcripción de Claude Code de su máquina (`primeras.py`, en el NUC, el Mac y el i9; 0 tandas sin encontrar): perdida si escribe al menos la mitad de lo que lee y escribe, en un contexto de 1.000 tokens o más.
- **Clases**: `mata` hueco < 1 h y perdida; `caduca-tras-mover` hueco ≥ 1 h, viva al escribirse el movimiento; `fria` caducada antes de moverse; `misma-org` hueco < 1 h entre Team, sin pérdida; `cambia-modelo` y `compacta` son reescrituras que habrían ocurrido igual.
- **Coste** (misma fórmula que `Optimizador/informes/2026-11-04/friki/cache-viva.md` §Procedencia): tokens × precio de escritura de 1 h, por modelo (Fable 20, Opus 8, Sonnet 4, Haiku 0,2 $/M, tabla de `Optimizador/informes/2026-10-14/cache/medir-cache.py:20-26`). La doc oficial da 5 $/M de entrada para Opus 5 (Context7, `platform.claude.com/docs/pt-BR/models/opus-5/overview`), que con escritura de 1 h al doble serían 10 en vez de 8: el total subiría 6,22 $.
- **Motivo**: la última línea del registro con movimiento del proyecto hacia esa cuenta. Registro: `plugin.log` del NUC desde el 2026-10-29 01:08 UTC y el del Mac hasta entonces, con 50 líneas de proyectos ya borrados sin resolver a un id.
- **Calor**: `bb calor list --json` a la hora de la extracción (motivo y fin del último turno). Sus tics se identifican por `calor/logs/plugin.log`.

## Lo que este informe no ve

- Las sesiones interactivas del Mac y los subagentes: solo hilos de bb. Por eso 24,65 $/día no es comparable con los ~73 $/día de la remedición del 2026-10-26 (`cache-prompts.md:16`), que medía transcripciones de todas las sesiones y tiempos anteriores a las reglas de hoy.
- Las plazas y la sesión de cada cuenta tienen un agujero de unos 2 días en las muestras del plugin (10-31 a 11-03): el almacén de muestras dejó de caber en el KV el 2026-11-01 y una recarga se lleva lo no guardado. Las plazas se reconstruyen del registro; el porcentaje de Fable de cada cuenta en el pasado no se guarda en ninguna parte.
- Una versión instalada nueva (0.2.39, 2026-11-04 04:58) solo lleva horas: casi todo el registro es de versiones anteriores, con otras reglas.
