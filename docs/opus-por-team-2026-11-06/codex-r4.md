codex
1. **medium — [server.ts:6714](/tmp/rev-opus-team-r4/server.ts:6714): los reintentos Fable pueden borrar un pin válido.**  
   **Escenario reproducido:** pin a Max A disponible → excursión a Team B → B agotada y reintento Fable temporizado. `moveUpWait` elige C por sus mejores mediciones y `applyAccount` borra el pin de A. También ocurre desde `judge` al procesar un fallo Fable. El checkpoint posterior ya no puede recuperar el pin.  
   **Arreglo:** dar prioridad a `wayHome` también al elegir destino en estos caminos, comprobando cuota y plaza; recurrir a otra cuenta y retirar el pin cuando A no pueda recibir Fable.

2. **medium — [server.ts:6692](/tmp/rev-opus-team-r4/server.ts:6692): r3-3 sigue dejando esperas sin reactivar cuando la Team está sin leer.**  
   **Escenario reproducido:** reintento Opus para dentro de cuatro horas → Max actual sin medición → Team B identificada por login, libre, cuya consulta devuelve 429. La nueva condición evita el retorno temprano, pero `bestAccount` busca únicamente entre cuentas medidas. Los refrescos mantienen el reintento intacto. Con idéntico estado, la colocación normal sí mueve el proyecto a B y devuelve `proceed`.  
   **Arreglo:** incorporar `unreadTeamSeats` con los mismos vetos y comprobaciones de plazas que usa la colocación; liberar mediante `releaseWait`.

3. **medium — [src/accounts.ts:79](/tmp/rev-opus-team-r4/src/accounts.ts:79): la identificación explícita como Team sigue subordinada a la ventana de 5 h.**  
   **Escenario reproducido:** login Team, semanal disponible y `five_hour: null` sin límite de sesión → `planOf` devuelve `ultra` → Opus espera aunque esa Team tenga cuota y plaza. Afecta tanto a `organizationType` como a `planDisplayName: "Team"`. La regla solicitada da prioridad al login.  
   **Arreglo:** reconocer Team explícita antes de inferir Ultra por ausencia de sesión; usar las ventanas como identificación subsidiaria.

4. **medium — [server.ts:5663](/tmp/rev-opus-team-r4/server.ts:5663): el veto de Team agotada se elude cuando no puede leerse la cuenta del proyecto.**  
   **Escenario reproducido:** todas las cuentas descubiertas son Team agotadas y `machineEnvironment` del proyecto devuelve 503 → `at` queda en `null`, se omite `teamOut` y `mayBeHeld` resulta falso → el cuarto intento devuelve `proceed` sin comprobar cuota ni plaza. Debería seguir esperando. Con una Max en el inventario, esa misma rama espera indefinidamente por el error de lectura.  
   **Arreglo:** tratar explícitamente la cuenta ilegible: impedir `proceed` para Opus/Sonnet sin verificar destino Team y disponibilidad, y distinguir el fallo persistente de lectura de una espera por cuota.

Validación dirigida en memoria, sin editar archivos ni revisar `dist/`. Sin suite completa.

SIN HIGH
