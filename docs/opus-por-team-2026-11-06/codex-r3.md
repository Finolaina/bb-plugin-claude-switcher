codex
1. **medium — [server.ts:5058](/tmp/rev-opus-team-r3/server.ts:5058): Haiku puede borrar el pin reservado para Fable.**  
   **Escenario reproducido:** `use` a Max A → Opus sale a Team B conservando el pin → B agota su sesión → Haiku mueve el proyecto a Team C. `keepPin: heldModel(model)` vale `false` para Haiku y borra el pin de A, aunque A sigue pudiendo ejecutar Fable. Tras recargar, Fable pierde su destino fijado.  
   **Arreglo:** conservar el pin durante las excursiones de otros modelos, incluido Haiku, sin cambiar su margen `otherModelUpTo`. Aplicarlo también en ahead, rescates y movimientos de reintentos.

2. **medium — [server.ts:4404](/tmp/rev-opus-team-r3/server.ts:4404): el rescate del refresco ignora un pin válido y lo elimina.**  
   **Escenario reproducido:** pin a Max A disponible → Opus se coloca en Team B, agotada para Fable → un hilo Fable espera a que Opus termine de arrancar → comienza Opus y pasa el refresco. `rescue` decide para Fable sin pasar `wayHome`; escoge C por sus mejores mediciones y borra el pin. Debería regresar directamente a A.  
   **Arreglo:** incorporar el destino de `wayHome` a la colocación del rescate. Elegir otra cuenta y retirar el pin cuando A no pueda recibir Fable.

3. **medium — [server.ts:6656](/tmp/rev-opus-team-r3/server.ts:6656): un reintento sobre una Max sin medición no aprovecha una Team libre.**  
   **Escenario reproducido:** reintento Opus persistido para dentro de cuatro horas, proyecto en Max A cuya consulta devuelve 429 y Team B con cuota y plaza. `moveUpWait` entra por `here === undefined` y retorna sin mover ni liberar el reintento. Los refrescos mantienen la espera hasta su vencimiento.  
   **Arreglo:** impedir esa salida temprana cuando `heldOff(fromName, model)` sea verdadero; buscar una Team y liberar mediante `releaseWait`, conservando el paso por el checkpoint.

4. **medium — [src/policy.ts:174](/tmp/rev-opus-team-r3/src/policy.ts:174), [src/accounts.ts:78](/tmp/rev-opus-team-r3/src/accounts.ts:78): una Team identificada mediante `planDisplayName` queda excluida.**  
   **Escenario reproducido:** login con `planDisplayName: "Team"` y sin `organizationType`, medición completa con semanal general y cuota disponible. `planOf` devuelve `unknown`; la nueva política la veta y Opus espera aunque esa Team tenga plaza.  
   **Arreglo:** reconocer también la identificación explícita `"Team"` del nombre de plan y compartir esa clasificación entre cuentas medidas y cuentas sin leer.

Validación: 27 comprobaciones dirigidas y reproducciones en memoria; sin suite completa. Sin cambios y sin revisar `dist/`.

SIN HIGH
