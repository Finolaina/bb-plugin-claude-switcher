# Opus por Team: la medida de antes (2026-11-06)

Encargo de Aitor del 2026-11-06 09:33: «el switcher sigue gastando más Opus que Fable y no tira de las cuentas Team… los Opus tienen que salir por Team sí o sí». Esta es la medida de la fase 1. La regla que la sigue es la 0.2.44 (`CHANGELOG.md`).

Todas las cifras son cuenta nuestra. Se recalculan con `scripts/opus-por-cuenta.py`.

## Ventana y fuentes

- **Ventana:** 7 días, del 2026-10-30 09:37 al 2026-11-06 09:37 (hora de Madrid). En epoch, de `1793349448` a `1793954248`.
- **Máquinas:** se leyeron los transcripts de las tres en las que corren hilos:
  - linux-i9: 1047 transcripts.
  - linux-nuc: 930 transcripts.
  - Mac: 1529 transcripts.
- **De dónde sale cada dato:**
  - Modelo y tokens: `~/.claude/projects/**/*.jsonl` de cada máquina. Los transcripts de subagentes se cuentan aparte.
  - Cuenta de cada momento: `~/.claude/state/sesiones-cuenta.jsonl`, que escribe el hook SessionStart con una línea por arranque, resume o compactación. La cuenta que vale es la del último arranque anterior al mensaje.
  - Tipo de cuenta: `bb claude-switcher health --json` a las 09:33.
  - Movimientos: `bb claude-switcher history`.
- **Cómo se cuenta:**
  - Un turno es un mensaje escrito en el hilo principal. Su modelo es el que más tokens de salida dio hasta el siguiente turno.
  - «Mtok» son millones de tokens de salida. Entre paréntesis va la parte de subagentes.
- **Comando:**
  ```
  opus-por-cuenta.py --desde 1793349448 --hasta 1793954248 > <máquina>.json
  opus-por-cuenta.py --juntar health.json i9.json nuc.json mac.json
  ```
- El detalle por proyecto y los JSON crudos no están en este repo porque es público. Están en el almacenamiento del hilo de bb que hizo la medida.

## Por tipo de cuenta

| tipo                | turnos Fable | turnos Opus | turnos Sonnet | turnos Haiku | Mtok Fable | Mtok Opus (subag.) |
| ------------------- | ------------ | ----------- | ------------- | ------------ | ---------- | ------------------ |
| Team (5)            | 365          | 1647        | 20            | 268          | 1.99       | 48.75 (25.66)      |
| Ultra (6)           | 1714         | 1740        | 23            | 245          | 9.18       | 79.01 (62.82)      |
| sin cuenta conocida | 328          | 96          | 30            | 207          | 2.84       | 4.64 (3.76)        |

«Sin cuenta conocida» agrupa dos casos:

- la base `~/.claude`;
- sesiones que arrancaron antes de que existiera el registro de arranques.

## Por cuenta

| cuenta      | tipo  | turnos Fable | turnos Opus | Mtok Fable | Mtok Opus (subag.) |
| ----------- | ----- | ------------ | ----------- | ---------- | ------------------ |
| team1       | Team  | 44           | 278         | 0.25       | 10.58 (5.82)       |
| team2       | Team  | 35           | 430         | 0.12       | 9.53 (5.02)        |
| team3       | Team  | 33           | 357         | 0.13       | 12.30 (6.54)       |
| team4       | Team  | 205          | 208         | 0.82       | 6.96 (3.50)        |
| team5       | Team  | 48           | 374         | 0.66       | 9.38 (4.79)        |
| aitor       | Ultra | 449          | 183         | 1.31       | 16.94 (13.93)      |
| ganaresenas | Ultra | 464          | 81          | 2.00       | 13.71 (12.56)      |
| joytorm     | Ultra | 397          | 641         | 2.79       | 21.42 (17.35)      |
| mariscal    | Ultra | 0            | 0           | 0.00       | 0.00               |
| siloeads    | Ultra | 281          | 273         | 2.27       | 13.16 (10.91)      |
| viaulab     | Ultra | 123          | 562         | 0.82       | 13.79 (8.06)       |

## Por qué Opus acabó en una Ultra

**Dos causas distintas.**

### 1. Subagentes de Opus dentro de hilos de Fable

Son 62.82 de los 79.01 Mtok de Opus en las Ultra, el 80 %.

Un hilo de Fable que lanza un subagente de Opus (`encargar.sh`, la herramienta Agent) lo ejecuta dentro de su propio proceso y con la cuenta del hilo. El switcher solo coloca turnos de hilos y no ve esos subagentes, así que esta regla no los mueve.

Para mandarlos a una Team hay dos vías, y las dos quedan fuera de este plugin:

- que el hilo de Fable encargue el trabajo a otro hilo;
- que el lanzador de subagentes use una cuenta Team.

### 2. Turnos de Opus de hilos colocados en una Ultra

Son 1740 turnos y 16.19 Mtok. Por periodo de versión del plugin:

| periodo                                        | turnos | Mtok  | causa                                                                                                                                                                                         |
| ---------------------------------------------- | ------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hasta 0.2.38 (antes del 2026-11-04 04:58)      | 1111   | 10.91 | Las reglas de entonces dejaban a Opus en una Max/Ultra con margen. Antes de la 0.2.39, además, una Team que informaba de semanal contaba como Max. Este periodo no se desglosa turno a turno. |
| 0.2.39-0.2.40                                  | 104    | 1.33  | Una Ultra que no podía correr Fable quedaba libre para Opus («sin Fable, no hay reserva que guardar»). Fueron 2 cuentas y 3 proyectos.                                                        |
| 0.2.41 en adelante (desde el 2026-11-05 01:47) | 525    | 3.97  | Desglose en la tabla siguiente.                                                                                                                                                               |

Desglose de la 0.2.41 en adelante:

| motivo                                                                                                                                                                                                                      | turnos | Mtok |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| Ajuste del proyecto: un proyecto fijado a mano (`use`) en una Ultra al reinstalar el 2026-11-05. La regla de la 0.2.41 hacía que un `use` aguantara a Opus.                                                                 | 121    | 1.38 |
| Movimiento por margen: «le queda margen de Fable (tope 50 %)». Hubo 4 movimientos en el historial (2026-11-05 12:06, 12:45 y 17:07; 2026-11-06 08:24). Uno de los hilos siguió en la Ultra, sesión tras sesión, del 2026-11-05 13:22 al 2026-11-06 06:04. | 135    | 0.78 |
| Carga de prueba fuera de bb: `claude -p` de un solo turno con la cuenta puesta a mano, para la medida de asientos del 2026-11-05. No pasa por el switcher.                                                                  | 269    | 1.81 |

No se encontró ningún turno de Opus en una Ultra por estos motivos: «Team sin plaza» sin más, «Team sin cuota» o «movimiento por atasco» de noche. El atasco movía a una Team primero; si caía en una Ultra, lo hacía por el margen de Fable, y está contado en la fila del margen.

## Qué cambia la 0.2.44 y qué no

| causa                                       | Mtok en 7 días | ¿lo arregla la 0.2.44?                                        |
| ------------------------------------------- | -------------- | ------------------------------------------------------------- |
| margen de Fable ≤ 50 %                      | 0.78           | sí: ninguna Max/Ultra recibe Opus ni Sonnet                   |
| `use` que aguanta a Opus                    | 1.38           | sí: el `use` vale para Fable y el turno de Opus va a una Team |
| Ultra sin Fable                             | 1.33           | sí                                                            |
| subagentes de Opus dentro de hilos de Fable | 62.82          | no, el switcher no los ve                                     |
| carga de prueba fuera de bb                 | 1.81           | no, no pasa por el switcher                                   |

## Para Flota

`bb claude-switcher health --json` trae ahora `esperandoTeam`: una lista con `{hilo, modelo, minutos}` de cada turno de Opus o Sonnet que espera plaza en una Team. Vale `null` si no se pudo leer la cola. La salida de texto muestra cada caso como «esperando Team: …».

## La medida de después (0.2.44 en el NUC)

- **Ventana:** de la instalación, 2026-11-06 11:08:06, a las 13:31 (hora de Madrid). En epoch, de `1793959686` a `1793968276`. Mismo comando y mismas fuentes que arriba.
- **Turnos:** 132 transcripts leídos (19 del i9, 38 del NUC y 75 del Mac).

| tipo                | turnos Fable | turnos Opus | turnos Haiku | Mtok Fable | Mtok Opus (subag.) |
| ------------------- | ------------ | ----------- | ------------ | ---------- | ------------------ |
| Team (5)            | 14           | 98          | 0            | 0.11       | 2.27 (0.62)        |
| Ultra (6)           | 15           | 0           | 0            | 0.14       | 1.32 (1.32)        |
| sin cuenta conocida | 17           | 0           | 46           | 0.30       | 0.35 (0.35)        |

- **Ningún turno de Opus ni de Sonnet en una Max o una Ultra.** Los 1.32 Mtok de Opus en las Ultra son todos de subagentes dentro de hilos de Fable, de una sola cuenta: el hueco de la causa 1, que esta regla no cubre.
- **El límite pasa a ser las plazas.** A las 13:31 las 5 Team estaban llenas (3 de 3) y `esperandoTeam` daba 6 turnos, el más largo de 18 min; en el registro hubo esperas de 25 a 29 min, con 24 plazas libres en las Ultra. Ninguna Team se quedó sin cuota (sesión entre el 17 % y el 66 %), así que el PARA Y ESPERA 1 del encargo no saltó.
- **Lo siguiente, medir 5 plazas por Team** (Aitor, 2026-11-06: «Medir 5 por team necesitamos más flujo»): `seatsTeam` 3 → 5 a las 13:38, ya con la 0.2.45 instalada (otro encargo, que no toca las plazas ni esta regla), con la vigilancia de errores de API de `scripts/errores-api.py`. El resultado está en `CLAUDE.md`, regla «Asientos subidos».
