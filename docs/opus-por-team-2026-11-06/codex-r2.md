codex
1. **high — [src/policy.ts:168](/tmp/rev-opus-team-r2/src/policy.ts:168): sigue entrando Opus en Max/Ultra identificadas por el login.**  
   **Escenario:** login sin `organizationType`, pero con `planDisplayName: "Max"`/`"Ultra"` o tier `max_20x`; medición con ventana de 5 h y sin semanal general. `planOf` infiere Team antes de comprobar esos campos y `measuredAccounts` añade `team: true`, eludiendo el veto. **Reproducido:** `proceed` sobre esa cuenta; también la seleccionan colocación, switch, ahead y D3. Debería esperar si ninguna Team real está disponible. **Arreglo:** resolver primero toda identificación explícita del login; inferir Team por ventanas únicamente cuando el login no indique plan. El arreglo r1-3 está incompleto.

2. **medium — [server.ts:4863](/tmp/rev-opus-team-r2/server.ts:4863): una Team agotada todavía permite arrancar el turno.**  
   **Escenario:** proyecto en Team con sesión al 100 % y todas las demás Team agotadas. La colocación devuelve `current-blocked`, `otherThatRuns` devuelve `null` y el veto final exime a la Team. **Reproducido con Opus y Sonnet:** `{ action: "proceed" }`. Debería esperar, conforme a «sin plaza ni cuota, ESPERA, sin excepciones». **Arreglo:** retener también los modelos restringidos cuando la Team actual está medida como incapaz de ejecutarlos; programar la revisión considerando su propio reset.

3. **medium — [server.ts:3712](/tmp/rev-opus-team-r2/server.ts:3712): una nueva excursión tras recargar oculta el pin persistido.**  
   **Escenario:** pin a Max A, proyecto en Team B tras recargar; Opus sale de B agotada hacia Team C. `noteMove` registra B como origen. Si B recupera cuota, el siguiente Fable usa ese origen y vuelve a B, aunque A tiene cuota y plaza. **Reproducido:** C → B para el primer Fable; B → A para el segundo. Debería regresar directamente a A. **Arreglo:** dar prioridad al pin válido para Fable, aunque exista una excursión cuyo origen sea otra Team. El arreglo r1-5 cubre solo la vuelta inmediata tras recargar.

4. **medium — [dist/server.js:101](/tmp/rev-opus-team-r2/dist/server.js:101): el artefacto conserva los fallos de r1.**  
   **Escenario:** se ejecuta el `dist` comprometido, que mantiene las versiones anteriores de `heldOff`, `unreadKeepsReserve`, `wayHome` y borrado del pin; también conserva la exención por `weekly.absent`. **Reproducido usando ese artefacto:** Opus recibe `proceed` en una Max agotada. Además, la comprobación de sincronía de CI fallará al reconstruirlo. **Arreglo:** reconstruir y comprometer `dist` con bb 0.45.0 después de los arreglos.

Siete comprobaciones dirigidas de los casos nominales de r1 y de reactivación al liberarse una Team pasaron. Reproducciones en memoria; sin editar archivos. No ejecuté la suite completa.
