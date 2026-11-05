# Buzón desde Optimizador → switcher, 2026-11-05: guardar 7 días de asientos ocupados

Origen: propuesta 7 del cierre de capacidad (`Optimizador/encargos/2026-11-05-buzon-capacidad-cierre.md`, informe `informes/2026-11-05/capacidad/INFORME.md` §Propuestas). Aitor, 2026-11-05 20:15: «decide tú y me dices conclusión» → Fable: SÍ a la 7 (sin riesgo, sin dinero).

Estado: pendiente. Al atenderlo, deja «Estado: atendido AAAA-MM-DD» al final.

## Qué se pide

1. Que `bb claude-switcher seats` (o un fichero que escriba el switcher) conserve 7 días de ocupación de asientos por cuenta (muestras cada pocos minutos: running, reserved, waiting), para que la medición de capacidad se haga sola cada semana y no a mano como el 2026-11-05.
2. Que la pieza `uso-modelos` o `subagentes-cuenta` del repaso del viernes (`Optimizador/scripts/repaso.sh`) pueda leer ese historial y sacar «pico de hilos a la vez» y «horas con cola» por cuenta. Solo lectura desde el Optimizador: el formato lo decide el switcher y lo documenta en su LEEME.
3. Tamaño acotado: 7 días rotando; nunca más de unos MB.

## Lo que NO se pide

Nada del resto de propuestas de capacidad: la 3 (freno del NUC) queda en no (el NUC sigue a 90 °C con la pasta nueva, remedir el 12-nov), la 5 (hilos paralelos) sigue aparcada, la 6 (más cuota) es de Aitor.

## Procedencia

Cierre de capacidad 7d796c7b; `bb claude-switcher seats` leído por Fable el 2026-11-05 20:15 (43 asientos usables en 11 cuentas).
