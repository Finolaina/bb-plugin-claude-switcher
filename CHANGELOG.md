# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [0.2.48] - 2026-11-07

### Cambiado

Encargo de Aitor del 2026-11-07: «la cuenta de viaulab, se sigue disparando el
tema la cuenta semanal y fable se queda sin gastar» y «tampoco quiero que hilos
se queden parados, si una cuenta se queda sin cuota tiene que saltar a otra, el
trabajo prima ... se trata de tenerlo todo optimizado con lo que tenemos». Plan
y medidas: reparto-fable, PLAN §0, §A y §B (almacenamiento del hilo).

- **Hueco de Opus por cuenta** (`opusRoom`, B1): en una Max o Ultra,
  `(100 − semanal) − reserveShare × (100 − Fable)`. Positivo: semanal general
  que otro modelo puede gastar sin quitarle nada a Fable. Negativo: la cuenta
  llegará al 100 % de la semanal con Fable sin gastar. Ejemplos medidos el
  2026-11-07 con 0,5: semanal 86 y Fable 53 da −9,5; 100 y 65, −17,5; 10 y 12,
  46. Nulo en una Team, en una lectura incompleta y sin ventana de Fable.
- **Fable va a la cuenta con más hueco** (B2): en tramos de 10 puntos, antes
  del cuarto de sesión y de la fecha de corte, y a una Team la última. Vale
  para proyectos nuevos, rescates, cambios tras un fallo y el elegido de la
  cabecera. Con las tres Ultra del plan (−9,5, 46 y 45,5), un proyecto nuevo
  va a la de 46 o la de 45,5 según la fecha de corte; antes iba a la que
  renovaba antes aunque tuviera −9,5. Opus entre las Ultra que ya puede usar
  (0.2.47 y B5) también va a la de más hueco.
- **Un turno de Fable se mueve por hueco** (B3, `why: "fable-room"`): con su
  cuenta en hueco negativo y otra Max/Ultra con al menos `roomMoveGap` (20)
  puntos más y plaza, el proyecto se mueve antes del turno. Con −9,5 y otra a
  10,5 se mueve; a 10,4 no. Con otro hilo del proyecto trabajando, solo por
  debajo de −10 y no dentro de `stuckMoveMinutes` desde su último movimiento.
  Nunca a una Team, nunca por un tic de Calor, nunca con el proyecto elegido a
  mano.
- **Fable con plazas llenas y un hermano trabajando también se mueve** (B4):
  como Opus desde la 0.2.43, a la primera consulta, a una Max/Ultra con plaza
  antes que a una Team. Antes esperaba en la cola (92 min de hilo medidos con
  5-6 cuentas libres).
- **[SUPUESTO] Opus y Sonnet sin ninguna Team capaz van a la Ultra con más
  hueco** (B5): si ninguna Team, leída o conocida por su login, tiene cuota y
  plaza para el turno, este va a la Max/Ultra con más hueco siempre que sea
  de al menos `opusOverflowRoom` (15), detrás de cualquier Team. Si ninguna
  llega, espera como en la 0.2.44; y si un turno lleva retenido más de
  `maximumWaitHours`, va a la Max/Ultra de más hueco sea cual sea. Cómo
  encajan las tres frases de Aitor (decisión de la sesión que delegó, no de
  Aitor): «los Opus tienen que salir por Team sí o sí» (2026-11-06) es el
  orden, Team siempre antes; «el trabajo prima» (2026-11-07) es no esperar
  mientras haya semanal que Fable no va a usar; «Esperar siempre»
  (2026-11-03) queda para las Ultra sin hueco y hasta el tope de espera.
  `opusOverflowRoom` a 100 lo apaga entero, también la salida por el tope.
  Una Ultra sin leer nunca recibe así un turno.
- **`health --json`**: cada cuenta lleva `huecoOpus` (el hueco con un
  decimal) y `fablePerdida`: los puntos de la ventana de Fable que quedarían
  sin gastar si la cuenta sigue así, `−huecoOpus / reserveShare` con hueco
  negativo y 0 si no. Nulos en una Team o en una cuenta sin leer entera.
  Ejemplo: semanal 86 y Fable 53 dan −9,5 y 19. Los campos de antes no
  cambian. En el texto: «hueco Opus −9.5 (Fable perdida 19)».
- **Historial** (B6): cada muestra guarda también el % de la ventana de Fable
  (`preferred_weekly`), para medir la Fable perdida en cada renovación.
- **Ajustes nuevos**: `reserveShare` (0,5), `roomMoveGap` (20) y
  `opusOverflowRoom` (15). Los tres valores son cuenta nuestra (una regresión
  de las lecturas de la semana, ±40 %), no medidas hechas para esto; se
  afinarán con datos reales.

Límites conocidos: los subagentes de Opus dentro de un hilo de Fable siguen
sin verse (corren en la cuenta del hilo); un Opus llevado a una Ultra por B5
queda anotado como excursión, y el siguiente turno de Fable puede volver a la
Team de la que salió; la plaza de destino de B3 es
una plaza libre, no una por delante de la cola; los relojes de B3 y del tope
de espera de B5 viven en memoria y una recarga los pone a cero.

Revisión (Codex r1: 1 high y 4 medium, `docs/reparto-por-hueco-2026-11-07/codex-r1.txt`):

- Un reintento de Opus programado (a 120 min, con todas las Team al 100 % de
  sesión) se suelta en la Ultra con hueco en el siguiente refresco: la espera
  adelantada (`moveUpWait`) elige con las mismas opciones que cualquier
  movimiento, B5 incluido (high 1).
- Un solo descanso entre movimientos de un proyecto con hilos trabajando,
  lo haga la regla que lo haga: tras moverse por hueco, `crowded` tampoco lo
  mueve dentro de `stuckMoveMinutes` (medium 3).
- Un movimiento por hueco reserva su plaza en el destino y ata el proyecto
  mientras se escribe, como uno por plaza: un hermano de Opus que decide con
  la misma lectura espera y vuelve a preguntar, en vez de escribir otro
  destino a la vez (medium 2).
- Una lectura que no está fresca (de más de dos refrescos, es decir, con las
  consultas fallando desde entonces) no da hueco: ni para B5, ni para los tramos de Fable, ni en
  `health` (`huecoOpus` nulo). Antes, con el endpoint de uso caído 31 min
  tras una lectura buena, la Ultra seguía dando hueco 46 y Opus iba a ella;
  ahora espera una Team (medium 4).
- La Team que acaba de rechazar un turno de Opus no cuenta como Team capaz,
  aunque su lectura diga que sí: con la única Team devolviendo un 429
  bloqueado dos horas y su lectura en 20 % de sesión con plaza libre, el
  turno pasa a la Ultra con hueco 46 en el acto, en vez de reintentarse a las
  dos horas. Un hilo que se quedó en error se sigue juzgando con las
  lecturas (medium 5).

Revisión (Codex r2: 1 high y 1 medium, `docs/reparto-por-hueco-2026-11-07/codex-r2.txt`):

- El descarte de la Team que acaba de fallar ya no termina con el juicio:
  esa Team no cuenta como capaz hasta el reinicio que dice el propio 429
  (desde Astra r4, ninguna lectura la levanta: ver abajo). Antes, el despacho del reintento
  devolvía el proyecto a la Team, que seguía leyendo 20 % de sesión: cuatro
  idas y vueltas y el quinto fallo en `attempts-exhausted`, con la Ultra con
  hueco 46 libre. La prueba recorre ahora la cadena entera: fallo, reintento,
  despacho y turno en la Ultra (high 1). La marca vive en memoria (una
  recarga la olvida) y solo cuenta para «ninguna Team capaz»: otro proyecto
  que ya está en esa Team puede fallar allí una vez, como antes.
- Con `stuckMoveMinutes` a 0, B3 tampoco mueve un proyecto con hilos
  trabajando, como ya no lo movía `crowded`: con un hermano activo y hueco
  −13,5 frente a 46, el siguiente turno de Fable se queda donde está. Sin
  hermanos trabajando, el 0 no lo frena (medium 2).

Revisión (Astra r3: 1 high y 3 medium, `docs/reparto-por-hueco-2026-11-07/astra-r3.txt`):

- Una cuenta marcada por un fallo anterior tampoco es destino del reintento
  de otro fallo, y no se la espera antes de lo que dijo su 429. Con dos Team
  que leen 20 % de sesión pero devuelven 429 dos horas, el reintento va de
  work a spare y de spare a la Ultra con hueco 46, donde corre el turno.
  Antes iba de work a spare y de spare a work hasta agotar los intentos
  (high 1). Vale para los turnos que guardan la reserva (Opus, Sonnet); uno
  de Fable se juzga con los números, como antes de la 0.2.48.
- La marca es del modelo que falló cuando la lectura de la cuenta lo explica
  por la ventana propia de ese modelo (Fable al 100 % con sesión y semanal
  general por debajo): un Opus de otro proyecto sigue yendo a esa Team, Team
  primero. Si la sesión o la semanal general también están llenas, o la
  lectura no explica el 429, la marca es de toda la cuenta (medium 2).
- La salida por `maximumWaitHours` se mantiene hasta que el turno arranca: si
  otro plugin retiene el mensaje y bb vuelve a preguntar 1 ms después, el
  turno sigue saliendo hacia la Ultra en vez de empezar otra hora de espera.
  Cuando un turno suyo ha corrido, el siguiente cuenta desde cero (medium 3).
- Todo movimiento automático antes o después de un turno ata el proyecto
  mientras se escribe, no solo los de plaza y hueco: si un Opus está
  escribiendo su traslado a una Team, un hermano de Fable que lo movería por
  hueco espera y vuelve a preguntar, en vez de escribir otra Ultra en medio.
  El texto de esa espera ya no dice «for a seat» (medium 4).

Revisión (Astra r4: 1 high y 3 medium, `docs/reparto-por-hueco-2026-11-07/astra-r4.txt`):

- La marca de una cuenta que acaba de dar un 429 ya no la levanta ninguna
  lectura: el endpoint de uso va por detrás del 429, y cada fallo vuelve a
  leer las cuentas antes de juzgar, así que una lectura con los mismos
  números quitaba la marca. Con dos Team en 429 dos horas y el reloj
  avanzando 1 s entre fallos, el reintento volvía a ir de work a spare y de
  spare a work hasta agotar los intentos. Ahora la marca dura hasta el
  reinicio que dice el 429 y, sin reinicio, 30 min (`LIMIT_NO_RESET_MS`,
  [SUPUESTO]: no había un retraso de bb ni nuestro que encajara). Fuera el
  código de «una lectura posterior la desmiente» y el de la marca sin fin
  (high 1).
- Cada cuenta guarda una marca de la cuenta entera y una por modelo, cada
  una con su vencimiento: un fallo de Fable por su ventana ya no pisa la
  marca de cuenta que dejó antes un Opus, y el reintento de Opus no vuelve a
  esa Team (medium 3).
- El atado de un movimiento antes de un turno dura hasta que termina su
  despacho, cuando el hilo ya está «dicho que arranque» y lo protege
  `siblingAdmitted`. Antes se soltaba al escribir la variable, mientras aún
  se guardaba el historial, y un hermano de Opus podía mover el proyecto a
  una Team en esa ventana (medium 2).
- Un mensaje dejado salir por `maximumWaitHours` y cancelado a mano antes de
  arrancar ya no deja la salida al siguiente mensaje del hilo, que espera
  desde cero (medium 4).

## [0.2.47] - 2026-11-06

### Changed

- **Opus and Sonnet may use a Max or Ultra account out of Fable until its
  weekly resets.** Aitor, 2026-11-06: «si fable llega al 100 se abre opus en
  esa cuenta». With Fable's own window at 100 % and the general weekly
  resetting with it (no more than 10 min later), what is left of the weekly
  is lost at that reset, so a turn in another model spends nothing Fable
  needs. Such an account takes Opus and Sonnet after every Team seat with
  room (a Team seat runs both models, so a project with threads in each
  stays put), and is a wait for a turn that failed when it frees sooner.
  Measured that day on the 6 Ultra accounts: Fable's window and the weekly
  reset at the same moment on every one (one a second apart). Fable at
  99 %, a weekly that outlives Fable's window, or either reset unknown:
  the account stays Fable's, as in 0.2.44. Haiku keeps its order.
- Reviewed in three rounds (Codex Sol r1-r2, Astra final r3, no high). Known
  limits: a project already on such an account stays there (no move, the
  cache is kept); `esperandoTeam` labels by model; failure recovery, the
  refresh rescue and wait release do not look at unread Team seats, and the
  switch-ahead threshold sets a nearly spent Team aside before the order
  (R047-R3-001/002).

## [0.2.46] - 2026-11-06

### Fixed

- **A reload counts each running turn where it started.** A turn reads its
  account when it starts, and keeps running there if its project moves
  meanwhile; a reload counted it on the project's new account. On
  2026-11-05 a Team showed 5 threads on 3 seats after an update, and the
  accounts they really ran on looked freer than they were. Each running
  turn's seat is now stored as it starts (`running-seats`) and a reload
  counts it there; a stored account no longer found counts it on its
  project's account, as before.
- The stored seat follows its account when the account's login becomes
  known, a count that could not read every thread keeps what it stored, and
  the seat's key is decided after the count's reads (Codex RS-001 to
  RS-006). Known limit: the entry names the thread, not the turn (RS-005).

## [0.2.45] - 2026-11-06

### Fixed

- **A reload no longer moves a project for want of its model.** A project
  with no model stored (no turn since the store began, or the store not
  read) was judged by the first refresh's rescue for the preferred model:
  on installing 0.2.39, four projects whose threads ran Opus on Team seats
  out of Fable went to an Ultra, losing their prompt cache, and the same
  happened on every reload to any project with no turn since. At load,
  each such project now takes the model of the latest turn of its latest
  Claude Code thread, archived ones included, from the list of threads
  the seat count reads anyway plus the archived ones (one log read per
  project with no model, none for the others). Any turn beats it, and it is not stored until a turn names it.
  A project with no thread, or whose latest turn names no model, is judged
  for the preferred model as before; a read that fails is said once in the
  log and that project is judged as before. The rescue waits for these
  reads at most 30 s; turns never wait for them. The log says, once per
  load, how many projects took a model, had no thread, had a turn with no
  model or could not be read.

## [0.2.44] - 2026-11-06

### Changed

- **Opus and Sonnet run on Team seats only** (Aitor 2026-11-06: «los Opus
  tienen que salir por Team sí o sí»). While Fable is the preferred model,
  no Max or Ultra account takes an Opus or Sonnet turn: not with margin
  (`otherModelUpTo` now applies to Haiku only), not when it is out of
  Fable, not when the project was picked by hand for it. With no Team seat
  free the turn waits, and takes the first one that frees. Measured in the
  7 days before (`docs/opus-por-team-2026-11-06.md`): 1,740 Opus turns on
  Ultra accounts.
- **A pick by hand of a Max or Ultra is for Fable.** An Opus turn of such a
  project goes to a Team seat and the pick stays: the next Fable turn goes
  back to the account picked, also after a reload, and the pick stays while
  the Opus turns move between Team seats.
- **Known as a Team seat, or no target.** An Opus or Sonnet turn waits
  rather than start on a Max or Ultra that is out (it used to start there
  to fail), on an account not read yet whose login does not say Team, or on
  a Max login that reports no weekly, or one whose plan name or tier says
  Max or Ultra (reviews r1 and r2, `docs/opus-por-team-2026-11-06/`). On a
  Team seat out of its session with no other Team able to take it, the
  turn waits there too: it no longer starts to fail.
- **The pick by hand is the way home for Fable** before any excursion noted
  since (r2), also for the refresh's rescue; a Haiku turn that moves the
  project keeps it too (r3).
- An Opus retry waiting on an account not read yet is moved by the refresh
  to a free Team seat; a login whose plan name says Team is a Team seat (r3).

### Added

- **`health` lists the turns waiting for a Team seat** (`esperandoTeam`:
  thread, model, minutes), for Flota.

## [0.2.43] - 2026-11-05

### Changed

- **A thread that would wait for a seat no longer waits 10 minutes first.**
  With a sibling of its project at work, a turn in another model that
  finds its account full moves the project at its first ask: to an account
  with seats for all of the project's threads when it asks for more than
  its account has, else to a seat for the thread (Team first, then an
  Ultra at or under `otherModelUpTo`). Measured before (2026-11-05 13:22):
  a thread waited 10 min 24 s on a full Ultra with four other accounts
  free. `stuckMoveMinutes` (10) is now how long a project so moved stays
  where it went before it moves again that way; 0 still turns it off.
- **A seat that ends asks the waiting threads again at once**, also those
  waiting on other accounts: one whose project can move to it goes now,
  not at its next 30-second ask.
- **`bb claude-switcher seats` lists the last day's samples**; the week is
  in `history --dias N`.

### Added

- **A week of seat history** (`bb claude-switcher history --dias N`, 1 to
  7): per hour and account, the seats taken and the threads waiting at
  most and the session and weekly %; every stuck thread with its why; and
  the moves of those days. Kept in the plugin's own SQLite database, one
  row per account and measurement.

### Fixed

- **The seat samples were not kept past two days.** They went to one
  key-value row, and from about the third day it passed bb's 256 KB limit:
  every store failed (662 times in the log from 2026-11-03 to 2026-11-05)
  and a reload lost them. The samples kept there move to the database once;
  if the database cannot take them they stay in memory, and in key-value
  storage for the next load, and a failed delete does not stop the week
  being read back.
- **A seat held with `reserve` and moved to another account frees its old
  seat at once**: the threads waiting for it are asked again then, not at
  their next 30-second ask.
- **A seat a thread gives up when its move fails goes at once to the
  threads waiting for it**, and reservations whose turn never started are
  freed before a turn with siblings at work is judged: a seat that is in
  fact free does not move the project. A turn sent now, past the checkpoint,
  on another account than its seat also frees that seat at once, and two
  threads of a project that decide on the same read move it once for a seat,
  not twice: while a move for a seat is written and recorded no other move
  of the project starts (Team first included); the thread held waits and is
  asked again as it ends.

## [0.2.42] - 2026-11-05

### Fixed

- **A pick by hand also holds against a switch ahead of the limit.** With
  `switchAheadOtherPercent` on, an Opus turn on a picked account at 95 %
  of its session moved the project away; now the pick holds until the
  account cannot run the turn, as 0.2.41 promised.

## [0.2.41] - 2026-11-05

### Changed

- **A busy project no longer keeps its waiting thread for hours.** On
  2026-11-04 twelve threads waited 24 hours in all (our own count, from
  the plugin's STUCK lines) in full Team seats while Ultras sat idle: a
  project with another thread at work was never moved for seats, and a
  turn in another model never ran on an account that keeps the preferred
  model. Now a thread in another model that has waited more than
  `stuckMoveMinutes` (10) moves its project to an account with a seat,
  other threads at work or not; a project asking for more seats than its
  account has moves at once to one with seats for all of them.
- **A turn in another model may run on a Max or Ultra account with room**
  (`otherModelUpTo`, 50 %): while the account's weekly and its
  preferred-model window are both at or under it, after every Team seat
  with a free seat. 0 restores «wait for a Team seat».
- **A pick by hand holds** for turns in another model until the account
  cannot run them; until 0.2.40 an Opus turn moved the project off a
  picked Max account within a second. A thread left in error on a picked
  account retries there; `release` forgets every pick.
- The history says the new moves in Spanish, with how long the thread
  waited or how many seats the project asked for, and the margin of the
  account it went to.
- **Team first, without bouncing.** A stuck thread takes a free Team seat
  before an Ultra with room; a project on an Ultra with room goes to a
  Team seat with room for all its threads there, but not within
  `stuckMoveMinutes` of a move for seats.

## [0.2.40] - 2026-11-04

### Changed

- **A Calor tick no longer moves its project.** A tick only keeps a prompt
  cache alive, and moving the project to run it rewrote the whole context on
  the new account, for a cache that was left behind by that same move. In its
  first attempt, a tick that would move its project, or wait for a seat or a
  Team, is refused: nothing is written, no seat is taken, no queue row is left
  and Calor tries again 5 minutes later. It leaves no mark either: neither its
  model nor its activity count for the project, and it does not place a new
  project. A real message, Calor's closing message and a tick already queued
  behave as before. Measured over 7 days (our own count, at proxy prices,
  `docs/plan-cambio-en-pausas.md`): 5 of 45 cache rewrites caused by account
  changes were moved by the tick itself, and 3 of them (12.44 $) were not used
  by any real turn afterwards.

## [0.2.39] - 2026-11-04

### Fixed

- **A Team seat is a Team seat also once it reports a weekly.** Team seats
  report a general weekly since November 2026, and the rule that keeps a
  Max account's weekly for Fable took that as «this is a Max account»: only
  the Team seats already out of Fable could take an Opus turn, and one of
  them held up to 8 threads while the others stood free (2026-11-03,
  `docs/revision-2026-11-04/PLAN.md`).
- **A turn told to start keeps its project where it is until it starts.** A
  turn reads the project's account as it starts, and the account belongs to
  the whole project: a sibling's move in between could start an Opus turn on
  an Ultra. No automatic move is written during that time (90 s from the
  first answer and, for a turn another plugin holds and that is asked again,
  10 s from each answer); the turn that wanted to move waits 30 s. A move by
  hand is not held back.
- **An incomplete usage answer that measured a window full is out.** It used
  to read as unknown: a turn stayed on an account known to fail, a stuck
  project was not rescued, and the veto on what only the clock frees did not
  reach it. What is merely missing still says nothing.
- **`--model opus` is an Opus turn.** A model named by its alias (`opus`,
  `fable`, `sonnet`, `haiku`, with or without `[1m]`) was read as no model:
  it skipped the reserve and, with the default account without a login, was
  placed as Fable.
- **An account out of the model takes no new turn while another can run
  it.** The turn used to start there and fail; now it waits in the seat
  queue of the account that can run it, and the checkpoint looks again just
  before reserving. With no account able to run it the turn still starts
  and fails: that failure is what tells the user and applies the longest
  wait.
- **A pick by hand takes effect at once**: bb is asked again for the
  messages the plugin holds (up to 5 minutes otherwise), and the retries
  with a far time are looked at without waiting for the refresh. A pick of
  an Ultra still does not run Opus there («Esperar siempre», Aitor,
  2026-11-03).
- **A reload does not forget the model of a project's latest turn**
  (`project-models` in storage): the rescue took a project working in Opus
  off a Team seat out of Fable, for a Fable it did not need.

### Added

- **A thread held 10 minutes with another account free is said to be
  stuck**: a `STUCK:` line in the log at most every 10 minutes per thread,
  and `atascos` in `health --json` and `seats --json` (`null` when bb's
  queue could not be read, never an empty list). `health` also gives
  `pctExacto`, the unrounded percentage (99.6 % rounds to 100 and still
  runs).
- **`scripts/canario-cola.mjs`**, a canary from outside the plugin, every
  10 minutes as a `bb automation` on bb's server. It warns when the plugin
  holds a message 10 minutes with a usable account with a free seat that
  could run it, seen in two looks in a row (a seat just freed is taken within
  30 s); when it holds one 2 hours with none that could (one grouped
  warning every 6 hours: the rule still waits, not in silence); and when a
  failed message has been stopped 10 minutes. A failed read, or a `bb` that
  hangs, exits 1, and warns after 30 minutes in a row.
- **An account not read yet, whose login says Max or Ultra, runs no Opus**:
  just after a reload, or with its reads failing, the turn goes to a free
  Team seat or waits.
- **The wait says why**: `Waiting for a seat on team5 for Opus: main keeps
  its weekly for Fable; 2/2 threads running, 0 ahead in the queue`.

### Changed

- An account directory named as the default account is said once per load:
  that line was 2373 of the 10000 the log keeps, and erased the evidence.

## [0.2.38] - 2026-11-03

### Changed

- **The measurements of 0.2.37 no longer carry project names or thread
  titles** (this repository is public): `docs/plazas-2026-11-03/` keeps
  the counts only, and the history was rewritten without them, by Aitor's
  request of 2026-11-03. The decisions on the open questions are in
  `docs/plazas-2026-11-03/START-preguntas-abiertas.md`. No change to the
  plugin's behaviour.

## [0.2.37] - 2026-11-03

### Changed

- **A thread no longer waits for a seat while another account has one.**
  By Aitor's request of 2026-11-03 («necesitaría abrir más hilos»):
  siloeads ran 4/4 with a thread waiting 17 minutes while joytorm had
  0/4. With the automatic choice on, a turn that would wait for a seat
  moves its project first to the best other account with a seat free
  (beyond those owed to its queue), chosen as every move chooses; the
  history says `Moved to account joytorm before the turn: siloeads seats
  full (4/4), joytorm had 4 free`. A project with another thread's turn
  under way stays and waits, as before; so does every project when no
  account has a seat.

### Added

- **Seats follow each account's load** (`seatsFollowLoad`, on). By
  Aitor's request of 2026-11-03 («que no sea un "máximo 4"»): a Max or
  Ultra account takes a fifth thread while its day's pace is under 50 %
  and its 5-hour session under 40 %, and drops to three once its pace
  passes 90 %; each change is in the history with why.
- **`bb claude-switcher rebalance [--apply]`**: one pass that spreads the
  projects with no thread at work over the usable Ultra accounts by the
  room in their weekly, none more than 10 projects above the one with
  fewest; each move is in the history as `Rebalanced`.

## [0.2.36] - 2026-11-03

### Fixed

- **A rescue no longer lands an Opus project on a Max account that keeps
  Fable when its turn ends during the move.** A turn that skipped the
  checkpoint (a Send now) and ended while the refresh was moving its
  project, decided for Fable, let the move finish onto that Max account.
  The move is now dropped when a turn of the project ends meanwhile, and
  no rescue decides while the model of a turn that ended is being read.
- **A Codex or hidden thread no longer stops an Opus project from moving
  off a Max account after its turn.** Their turns counted as newer
  activity of the project, so the move after an Opus turn was skipped.

## [0.2.35] - 2026-11-03

### Changed

- **An Opus turn waits instead of spending a Max account's weekly.** By
  Aitor's decision of 2026-11-03 («Esperar siempre»): when no Team seat
  (or Max account out of Fable) can take an Opus turn, it no longer runs
  on the Max account that keeps Fable where its project sits. bb holds
  the message, the user's own threads too, with the seat it waits for
  and from when (`Waiting for Opus on team3, free from 2026-11-03 14:00:
  aitor keeps its weekly for Fable`), and asks again within 5 minutes.
  Fable, and the Opus subagents inside Fable threads, keep the Max
  weekly. A Haiku turn is not held.

### Fixed

- **A project working in Opus is no longer rescued onto a Max account
  that keeps Fable.** The refresh that moves projects off an account out
  of the preferred model judged every project for Fable, so a project
  whose threads run Opus left a Team seat (or a Max account out of
  Fable) that still ran Opus for a Max account that keeps Fable
  (measured 2026-11-02 18:23). It now judges each
  project for the model of its latest turn, and moves one in Opus only
  where Opus spends no weekly Fable needs.
- **After a turn in Opus that ran on a Max account that keeps Fable, the
  project moves off it at once.** Turns that skip bb's dispatch check (a
  message from a child thread, a Send now) run where the project sits:
  this repository's own Opus thread ran on aitor that way from 21:04 on
  2 Nov to 09:41 on 3 Nov, and aitor's weekly reached 48 % with Fable at
  24 %. Now, when such a turn ends, the project goes to a Team seat with
  room, as the check would have sent it (`Moved to account … after a turn
  in Opus: … would spend Fable's weekly`).

## [0.2.34] - 2026-11-02

### Changed

- **The panel's bars show what is spent, one thin bar per window.** By
  Aitor's decision of 2026-11-02 (and his request of 2026-10-31: what is
  spent, 0 to 100, green amber red, for the session, the week and
  Fable). Each account row in Settings and the account card in a
  thread's menu draw a bar per window the account has, all visible at
  once: «5 h» (none on an Ultra without the 5-hour window), «Semana»
  (never on a Team seat) and the preferred model's own window (e.g.
  «Fable») when the account's usage has it. Each bar fills left to right
  with what is spent, its short name on the left and the spent percent
  on the right; the colour follows the same rule on every bar: green,
  amber from 70 %, red from 90 % (full and red at 100 %). A window whose
  reset has passed shows an empty bar at 0 %, never hidden. A thin
  mark on the week's bar shows where today's share ends (Aitor's choice
  of 2026-11-02: a lighter band read as spending at 0 %). Bars
  are 4 px and the rows tighter. Each bar is read out as «Ha gastado el
  64 % de la semana» / «Used 64 % of the week», and each window's reset
  is in the row's tooltip.
- **The texts follow the new meaning.** The group headings say «Ultra ·
  lo gastado» and «Team · lo gastado» (no longer «lo que queda»); the
  sentence on top names the free account that has spent least of its
  week («La que menos semana ha gastado es agency (0 %)»); the list is
  ordered by week spent, least first. The account line in the menu says
  «Semana 40 % · vuelve lun 09:00» («5 h 49 %» on a Team seat), the
  header's line «ha gastado el 40 % de la semana», and the card under
  its bars only the plan and when it is back. A Team row no longer says
  «Fable al 89 %» in its line: Fable has its own bar.

### Fixed

- **A Team seat no longer shows a 7-day bar in bb's Provider usage
  panel.** The plugin published a «Weekly limit» window at 0 % for every
  Team seat, which has no general weekly; now a Team seat publishes its
  5 hours and its per-model windows only.

## [0.2.33] - 2026-10-31

### Changed

- **The day's pace no longer holds background work back by default.** A
  new setting, `paceHoldsBackground`, off by default by Aitor's decision
  of 2026-10-31, turns on the brake 0.2.32 added. Off, no account is
  saved for the user in any choice (a new project, a move off an account
  that cannot run before a turn, the way back from an excursion, the
  switch after a failed turn, a waiting turn moved to a free account, the
  move ahead of the limit): background work is placed as in 0.2.31. The
  pace is still measured and stored (`pace-day`) and shown: today's share
  in the panel, `ritmo` in `health`. On, everything is as in 0.2.32.
- **The panel only says «Guardada para ti» when something keeps it.**
  With the brake off no row is «Kept for you» and the sentence on top
  names none: an account past its day's share is Working, Free or Out,
  and its line still says it spent today's share. The state the app
  receives carries `paceHoldsBackground`.
- **`health --json` says the brake.** A new top-level field, `freno`
  (the setting), and `ritmo.fondo` keeps its meaning, «it may take
  background work»: always `true` with the brake off. Still version 1:
  a field added, none changed in meaning. The text form says «freno de
  fondo encendido/apagado» after the day's start.

## [0.2.32] - 2026-10-30

### Fixed

- **An Ultra account freed of the 5-hour window was «blocked + unknown».**
  Anthropic renamed Max 20x to Ultra and drops its 5-hour window account
  by account (2026-10-30). The usage endpoint then answers `five_hour:
null`, no `session` limit and a `weekly_all`: the plugin read the
  missing session as an incomplete answer, so the account was never
  chosen and `list` said `ses 100% LOCKED`. Such an answer now reads a
  session absent at 0 % that never binds (the pattern of a Team seat's
  absent weekly); without the `five_hour` key it is still incomplete. bb's
  usage panel shows no 5-hour window for it, the account menu no
  session, and `list` no `ses` column.

### Added

- **The plan behind each login: Ultra, Max, Team.** Read from
  `oauthAccount.organizationRateLimitTier` and `planDisplayName` and the
  windows (an account without a session is Ultra, never Team; a Team
  seat is Team by its profile or, without one, by having no general
  weekly). The state the app receives carries `plan`, `planLabel`
  («Ultra · sin tope de 5 h», «Ultra · 5 h hasta que Anthropic la
  verifique», «Max», «Team»), `planShort`, `fiveHour` and `pace`; `list`
  shows the plan under each account. Ultra has the Max seats.
- **The day's pace: background work does not eat the user's day.** Without
  the 5-hour window, a night of background work could spend two days of
  the week. Each day (from `dayStartHour`, 09:00 Europe/Madrid, to the
  next) gets an even share of what is left of the account's weekly
  window, from the day's first reading (kept in storage, `pace-day`). At
  90 % of it the account is saved for the user: for a thread with a
  parent thread or an origin plugin, every choice of another account (a
  new project, a move off an account that cannot run before a turn, the
  way back from an excursion, the switch after a failed turn, a waiting
  turn moved to a free account, the move ahead of the limit) puts it
  behind every other usable account, never left without one. A project
  whose account can run is not moved for the pace. The user's own
  threads are not affected. Unknown (no weekly reset) counts as saved; a
  Team seat has no pace.
- **`bb claude-switcher health [--json]`:** a stable read for other
  threads and scripts, version 1, the same schema as the Mac's
  `claude-cuentas.py salud --json`: per account `nombre`, `plan`,
  `planTexto`, `cincoHoras`, `sesion`, `semana`, `modelos` (only those the
  usage API reports), `ritmo`, `plazas` (with `externas`), `usable` and
  `problema`; times ISO 8601 with Madrid's offset. `usable` is what the
  automatic choice may pick, whatever the model: an account out at its
  last good read, whose reset passed while the queries kept failing, is
  not usable («reset sin confirmar…»).
- **`bb claude-switcher reserve <account> --id <x> --until <ISO>` and
  `unreserve --id <x>`:** a seat held for a run outside bb (`claude -p`
  with the account's `CLAUDE_CONFIG_DIR`, which bb does not see), so bb
  does not put more threads on it than its seats. Checked and taken in
  one synchronous step; fails (exit 1) with no free seat beyond those
  owed to threads already waiting, or for an unknown account. Right after
  a reload it first waits, up to 5 s, for the threads already running to
  be counted; not counted by then, it holds nothing and fails with exit
  75 (`seats_counting`: ask again in a moment). It fails the same way
  when that count left a running thread unread, and counts them again.
  The same
  id renews it. It ends at `until`, never more than 12 h after it was
  asked for, and is kept in storage (`external-seats`) across reloads:
  a hold that cannot be stored is undone and `reserve` fails (exit 1,
  `not_stored`); an end that cannot be stored leaves the hold and
  `unreserve` fails the same way. Counted in `list`, `seats` and `health`.

### Changed

- **Settings → Claude Switcher reads at a glance (design B).** On top, one
  sentence: which accounts work now, which are kept for you (their day's
  share is spent) and which free one has most of its week left. Below,
  the Ultra and Max accounts by what is left of their week, most first,
  then the Team seats by name; one row each with the plan («Ultra · con
  5 h», «Ultra · sin tope de 5 h», «Team»), one bar of what is LEFT (of
  the week, or of the 5 hours on a Team seat) with today's share striped
  at its end, the state as an icon and a word (Out, Kept for you,
  Working, Free; «No data» for a failed read), today's line or the
  seat's threads, and when it is back («lun 09:00», «mañana 11:00»).
  Working = it holds a seat, also one held from outside bb. Spanish for a
  browser set to Spanish, English otherwise. The cards with one bar per
  window and their «ses/sem» text are gone; the pace of the window that
  matters is now in each row's tooltip and in the thread's menu, in the
  same two languages.
- **The thread's account in its header** shows its state as an icon, and
  its menu opens on a small card with what is left in large type, the
  bar and its line; every account of the menu, and every account
  heading of Projects, says its state and what is left in one line.
- **bb's usage panel** labels each card with the account's name and its
  plan («aitor · Ultra · sin tope de 5 h», Codex ULTRA-R05). `plan` stays
  null: bb 0.46 puts its own word («Max», «Team») in place of the label
  for a plan id it knows, and the account's name would be lost.
- **Every date in the panel, its rows and the menus is Madrid's**, not
  the browser's zone (a reset at 09:00 in Madrid read «03:00» in New
  York); so are the history's times and the «agotada hasta» of `list`.

### Known limits

- Two choices of another account have no thread behind them and treat
  the work as the user's: the refresh's move of a project off an account
  that cannot run, and the account the Opus advice in a declined
  thread's banner names.
- The day's first reading is kept by account name (Codex ULTRA-R2-001):
  renaming the default account, or a second directory logged into the
  same account found during the day, starts the day's pace again from
  its next reading, which gives that day's spending back to background
  work. Seats keep the login's identity; the pace does not yet.
- `planOf` without a profile tier cannot tell an Ultra still on the
  5-hour window from a Max: it says «sin datos de plan» until the login's
  profile carries `organizationRateLimitTier` or `planDisplayName`.
- Left open by the final inspection (Codex Astra r3, no high; for 0.2.33):
  the refresh's rescue of a project off an account that cannot run does
  not know whether its threads are background work, so it may move a
  background-only project to an account kept for the user (ULTRA-R3-001);
  moving an external hold to another account frees its old seat before the
  hold is stored, so a thread admitted in that moment and a failed write
  can leave two on one seat (ULTRA-R3-002); and a failed read of the
  stored external holds at load starts with none, so their seats can be
  granted again until they are reserved anew (ULTRA-R3-003).

## [0.2.31] - 2026-10-30

### Added

- **Seats per account: threads wait their turn instead of emptying one
  account.** With many threads open, they all ran on the account with the
  most room and emptied its 5-hour window in minutes (2026-10-29: 7 of 8
  accounts at 100 % at once). Each account now has seats, threads running
  turns on it at once: `seatsMax` (default 4) on a Max account, `seatsTeam`
  (default 2) on a Team account, 0 = no limit. The kind comes from
  `oauthAccount.organizationType` (`claude_max`, `claude_team`); unknown,
  an account without a general weekly window is Team. At the dispatch
  checkpoint, after the turn is placed, a thread whose account is full
  waits («Waiting for a seat on <account>: 2/2 threads running, 1 ahead in
  the queue», asked again every 30 s, not counted against the 3 waits of a
  new project's placement); a turn that ends, fails or whose thread goes
  frees its seat for the first in line and bb is asked again at once. A
  reservation whose turn does not start within 90 s is freed. Every turn
  is checked, placed by the plugin or not: when its project's account
  cannot be read, the message waits up to three times, then goes with a
  warning. A started turn keeps the seat its dispatch reserved, even when
  the project moved before bb announced it. The seats are the login's
  (`accountUuid`): two directories of one account share them, and a
  renamed default keeps them. The seats are kept in memory; after a
  reload the threads bb reports active are counted before any turn starts
  (a message waits meanwhile, at once, and bb asks again as soon as they
  are counted); a read that fails or
  gives no answer within 3 s is tried three times, 2 s apart, after which
  turns go with what was counted, and a thread that ends while counted is
  not counted. A project on an account the plugin no longer finds waits
  like one whose account cannot be read, also when the plugin places the
  turn; it never takes the default's seat, and its running threads are
  counted on nobody's. A project moved (picked by hand, rescued) while its
  turn was being placed takes its seat where it is now, never where the
  placement left it; while a write of its account is under way, also one
  that confirms the account it is on, the turn waits. The whole dispatch
  checkpoint answers within 8 s, every read in it together (bb fails the
  message at 10 s): out of time, the message waits and is asked again in
  5 s. A turn that starts without a reservation and whose account cannot
  be read within 3 s keeps the seat it held, or is counted on the next
  refresh. Cancelling the last message of a thread waiting for a seat
  gives its place, or the seat reserved for it, to the next in line,
  unless a new message of the thread took it meanwhile.
- **A project is never moved to find a seat.** Seats only steer moves made
  for other reasons, and those go only to an account with a free seat (a
  new project, a move before a turn, a move off a long wait, a move ahead
  of the limit); with none free anywhere the project stays and its
  threads wait. The one exception is the switch after a turn failed on a
  limit, which picks by quota among the others when none has a seat. A
  pick by hand waits for a seat like any.
- `bb claude-switcher list` shows `seats 3/4` under each limited account
  and a «Waiting for a seat:» section; each account card in Settings shows
  `seats 3/4 · 2 waiting`, updated as seats change.
- Each measurement of an account stores a sample whole in itself
  (`seat-samples`, a week, one per account and measurement): seats
  running and reserved then, session and weekly %, and their resets.
  `bb claude-switcher seats [--json]` prints them with the session % spent
  per hour and seat, to set the defaults from data (they are a guess).
- No project stays on an account out of the preferred model or without a
  login: after every refresh the plugin moves each one it manages to the
  best account with a free seat, whatever `switchAheadPercent` says (bb
  greys out the composer of a project on an account at its limit, so no
  turn reached the checkpoint that moves it); a project whose account
  cannot be read within 3 s, read again or moved within 10 s, is skipped
  with a warning and the others are still looked at. An account left without a
  login now logs why, once: nothing in the store, a stored login it cannot
  parse, a refused refresh, or the usage endpoint's 401 with its answer.

### Known limits (Codex Astra, final inspection; left for 0.2.32)

- Cancelling a second message queued on a thread whose first message was
  just let through (between the dispatch and `thread.active`) releases the
  seat the first one reserved, and another thread may take it before the
  first turn is counted (SEATS-R5-001).
- The rescue after a refresh takes a project whose variable names an
  account the plugin no longer finds for one on the default account, and
  judges it by the default's usage (SEATS-R5-002); the dispatch itself
  already tells such an account apart and waits.

## [0.2.30] - 2026-10-29

### Fixed

- **A thread keeps its conversation when its project moves to another
  account.** bb resumes a thread with `claude --resume <session>` under the
  project's new `CLAUDE_CONFIG_DIR`, and Claude Code looks for the session
  in that account's `projects/`. Where the accounts do not share that
  directory (Linux, an account made without the link), the thread failed
  with «No conversation found with session ID …». Before the project is
  pointed at the new account, the plugin links into it every session of
  the project it lacks, for each of the project's paths on this machine
  (worktrees included, and the resolved path): a hard link to each
  `<session>.jsonl` (a symbolic link across filesystems: both accounts
  always read one transcript) and a symbolic link to its folder. Nothing
  is removed or overwritten; accounts that already share `projects/` are
  left alone; a project of another machine is skipped and logged once; a
  failure is logged and never stops the move, and after 2 s the move goes
  on without waiting for the rest. A move just before a turn (the
  message's checkpoint) starts the links and does not wait for them.
  Known limit (Codex E46-R7-001, left open on purpose): on a machine whose
  accounts do not share `projects/`, a thread whose project is moved by
  that checkpoint can still be resumed before its links land. Waiting
  there reopened a family of races between placements (rounds 2 to 6), so
  the real fix is the shared `projects/` directory on every machine
  (the Mac has it; the Linux hosts get it with the cerebro-linux E46
  migration); this plugin's links are the second line of defence.

### Changed

- **`bb claude-switcher list` is one short line per account.** At most 60
  characters, in aligned columns: `ses` (session), `sem` (weekly, not on a
  Team seat, which has none), the preferred model, `agotada hasta HH:MM`
  (or the date, a day or more away) when a window is full, `LOCKED`. The
  pace of each window is no longer in the text (it stays in `--json`).
  The projects are listed by account: `team3: Ads · Bots · Infra`, then
  those set outside the plugin and those of an account that is gone.
- **The panel is compact.** Each account is one card with its windows in
  one line of text (`ses 10% · sem 40% · Fable 20%`) and a thin bar per
  window side by side; under them, in small text, when each window
  resets and the pace of the window that matters.
  A Team seat shows no «Weekly (all models)» bar, and the account menu of
  a thread shows no weekly for it. The projects are grouped under their
  account, each group headed by the account's usage, with the account
  picker of each project as before.

## [0.2.29] - 2026-10-29

### Fixed

- **A new project's first thread starts on the account chosen for it.**
  The project was placed when bb announced the thread, which comes after
  its first turn has started: that turn ran on the default account. On a
  machine whose `~/.claude` has no login (bb's server moved to a new
  machine), it failed with «Not logged in», and so did its retries. bb
  asks the plugin before a thread's first message is sent; a new project
  with no account of its own is placed then, and the message waits once,
  up to 5 s, while the accounts are measured.
- **A turn no longer starts on a default account without a login.** A
  project left on the default account moves, before the turn, to the
  best account that can run it, even one that keeps its weekly for the
  preferred model (`… before the turn: <old> is not logged in`), whatever
  model the message names. While the placement, the write of the account
  or the first measure after a reload is under way or has failed, the
  message waits, up to three times 5 s per message; the default's login
  is looked at even when the accounts directory cannot be read, and one
  that cannot be checked counts as missing, also when its check failed (the
  store could not be read, the refresh failed); a usage query that fails
  after the login was read still counts as a login. A project with an
  account of its own, or one set outside the plugin, is never held: when
  the accounts directory cannot be read, its turn runs on that variable and
  the log says so. When no account can take it, bb
  refuses the message with the command that fixes it
  (`bb claude-switcher use <project id> <account>`) instead of starting a
  turn that fails.

## [0.2.28] - 2026-10-17

### Changed

- **The advice to switch to Opus is in Spanish.** The retry reason, the
  composer's banner, the history and the log now say `Sin <model> en
ninguna cuenta: pasa este hilo a Opus con el selector de modelo; irá a
<name>`. Only the text changes: when it is said, and the account it
  names, stay as they were. The rest of the plugin stays in English.

## [0.2.27] - 2026-10-17

### Fixed

- **A judgment that lands while the pass checks what was read back
  keeps its banner.** After a restart, the banners' pass checks against
  bb what a banner was asked on, then asks the banner. A judgment of the
  thread could land between the two, and the pass went on with what it
  had checked: it could take away the banner the judgment had just shown
  (when the account the turn failed on had room for the preferred model
  on its numbers). The pass now goes on only while what it checked is
  still the thread's.
- **Five refreshes in a row are five refreshes.** A check of what was
  read back that could not tell counted once per pass, and the pass runs
  again within a refresh (once a move is over, or after a read that a
  move crossed), so what was kept could be dropped within one refresh.
  Such a check now counts at most once per refresh.

### Changed

- **Log.** A check of what was read back that fails says "the thread or
  its log could not be read"; what is dropped after 5 checks in a row
  that could not tell is said at info.
- **README.** The paragraph on the banner after a usage refresh is split
  into shorter sentences, and says that dropping what was kept writes
  the storage again, that after a restart the pass reads the thread and
  its log in bb, and that the seven days count from when the decline was
  first judged.

## [0.2.26] - 2026-10-17

### Fixed

- **A banner read back after a restart stands only on what bb logged of
  the retry that followed.** After a restart, a declined thread's banner
  came back when bb said its latest turn was the one judged or any later
  retry of its chain. With the plugin running, that retry's start ends
  the banner, and only its failure's judgment brings one back. A later
  retry now counts only when bb's log says it was sent in the model
  judged and failed on a limit or was refused; another failure or
  another model drops what was kept, and a failure not yet in the log
  keeps it, unshown, until the log says it.
- **The banners' pass does not trust a read that a move crossed.** The
  pass could read a project's account while another thread's failure
  was moving it, and name the account the project was leaving. It no
  longer reads a project whose move is being written (it runs again
  once the move is over) and drops a read that a move crossed, running
  again at once; the banners stay as they were meanwhile.
- **Fable back takes the banner away without reading the project.** A
  banner went only once the project's account was read, and a read that
  failed left it up. It now goes before that read whenever nothing is to
  be told wherever the project sits (the preferred model back on an
  account, a read that says nothing, the model no longer preferred), and
  also when the project's account cannot be read. What it is asked on
  stays for the reads to come back, and a judgment of the thread made
  meanwhile keeps its own banner.
- **A queued retry's reason is asked as the retry is queued.** A wait's
  or a leftover's retry took its reason before the look at the queue and
  the removal of the row it replaces: with the automatic choice switched
  off meanwhile, the reason still named where an Opus turn would go. It
  is now asked right before the retry is queued.
- **No account found, no read counts.** After the accounts directory
  changed to one that cannot be read, the readings in memory of the
  accounts found before still counted, and never grew old. With no
  account found, none counts: the banner goes (what it is asked on
  stays), and a judgment says nothing.
- **What a banner is asked on, read back after a restart, does not stay
  forever.** It was skipped unchecked while the preferred model was
  another or an account was never read, and a thread that could not be
  read was warned about at every refresh. It is now checked against bb
  before anything else, and only for so long: one whose decline was
  first judged more than 7 days before is dropped without reading its
  thread (every window of a limit has reset since), and one that 5
  refreshes in a row could not check (the thread could not be read, or
  bb's log does not say how its retry failed) is dropped at the fifth.
- **Storage of a shape that cannot be read is written again.** It was
  said in the log at every start.
- **The same decline judged again writes nothing.** A thread left in
  error and judged at every refresh had what its banner is asked on
  written each time, though only the time had changed. When the decline
  was first judged now stays, and nothing is written.

### Changed

- **README.** The table of bb surfaces lists the composer banner,
  `thread.active`, `thread.archived`, `thread.deleted` and
  `message.cancelled`, and says the storage keeps what each banner is
  asked on and the retries cancelled by hand. Known limitations: the
  banner also comes back at the refresh whose reads show the preferred
  model out again; the write of what a banner is asked on is not waited
  for, so a restart before it lands loses it with no line in the log;
  and what was read back is checked for 7 days and up to 5 refreshes.
- **The 0.2.25 entry** says the pass keeps a basis only for the declines
  a banner can follow, and that the banner also comes back at the
  refresh whose reads show it out again.

## [0.2.25] - 2026-10-17

### Fixed

- **The banners' pass holds nothing up.** Since 0.2.24 every usage
  refresh waited for the banners to be asked again, one read of the
  project's account per declined thread, one after another, and a
  failure's judgment, a new project's placement and the periodic look
  at the waiting turns waited for that refresh: twenty declined threads
  of one project with two-second reads held another project's failure
  for forty seconds. The pass now runs after the refresh without being
  waited for, reads each project's account once, keeps a basis only for
  the declines a banner can follow (in the preferred model, beyond the
  maximum wait or with no account usable), and a refresh that ends
  while it runs gets one more pass after it, not a second one at once.
  A refresh asked by hand (the section's refresh, `bb claude-switcher
refresh`) still answers once the banners are asked.
- **A refresh that fails still asks the banners.** When the accounts
  directory could not be read, the refresh stopped before the banners
  were asked, and a thread with provider-retry's retry queued (not
  judged again until it runs) kept a banner on reads hours old. The
  banners are now asked after every refresh, one that failed included:
  a banner goes when the reads are older than two refreshes, and comes
  back with them.
- **A declined thread's banner survives a restart.** What a banner is
  asked on was kept in memory only: after a restart or a reload, a
  thread with a retry queued hours ahead lost its banner until the
  retry ran. It is now kept in the plugin's storage, and the usage
  refresh at start asks it again if bb says the thread still waits on
  the turn it was judged on; a thread that moved on meanwhile keeps
  nothing. The queue is left as it is.
- **A deleted thread is treated as an archived one.** Its banner and
  what it is asked on go, and the model last seen in it and a retry
  cancelled by hand are forgotten: they were kept until a restart, and
  its project was read again at every refresh.
- **A queued retry tells only while its judgment holds.** With the
  automatic choice switched off during a failure's judgment, the queued
  retry's card still named the account an Opus turn would go to; it now
  gives its own reason, as the history row does since 0.2.24.

### Changed

- **README, Known limitations.** The banner follows the numbers of the
  account the turn failed on: when they show room for the preferred
  model again, it goes at the next usage refresh, while provider-retry
  still waits, and comes back with the turn's next failure or at the
  refresh whose reads show it out again. And a banner after a restart
  comes from the plugin's storage.
- **The 0.2.24 and 0.2.23 entries** say which judgment ends a banner and
  what a switch-off leaves to be made, and no line is cut short.

## [0.2.24] - 2026-10-17

### Fixed

- **The banner follows the usage reads.** A declined thread's banner
  named the account an Opus turn would go to when its failure was
  judged, and kept it: a thread with a retry queued (bb's provider-retry
  queues one for the session's reset) is not judged again until it runs,
  while the numbers change. After every usage refresh the banner is now
  asked again on the new reads, as a later judgment would ask it: it
  names the account an Opus turn would go to now, goes when the
  preferred model is back, no account can run Opus, a read failed or the
  project's account was set outside the plugin, and comes back with the
  reads. Nothing is sent, retried, moved or written for it. A turn of
  the thread, its archiving, a later judgment that retries, waits or
  switches (no decline) and the automatic choice switched off end it,
  also while a refresh reads.
- **A move's history row tells the thread only while its judgment
  holds.** A wait that moved the project wrote the advice to switch to
  Opus in the move's row, and took the turn for told, even when the
  automatic choice was switched off, a turn of the thread started or the
  thread was archived while the move was made. The row now asks, as it
  is added after the move and its store, whether the judgment still
  holds: otherwise it records the move with its own reason, and the turn
  is told by a later judgment. The project's latest move (kept for views
  older than the history) records the move's own reason, without the
  advice.
- **Switched off during a failure's judgment, or a move already under
  way, the move is still made and recorded,** as such a judgment always
  did: now tested, and the README and the 0.2.23 entry say so.

### Changed

- **One read of bb's log per failure.** A failed turn's model and its
  retry chain come from the same read of bb's log, made before anything
  is checked (a retry's failure read it twice).
- **README, Known limitations: where the account named for Opus
  holds.** For a message sent in Opus through bb's dispatch checkpoint,
  on the reads of that moment. Send now on a queued retry's card skips
  the checkpoint (by bb's design), and the queued card and the history
  row keep the name they were written with.

## [0.2.23] - 2026-10-17

### Removed

- **The veto of a blocked report.** Since 0.2.21 a failure's blocked
  limit report put its account out of every turn until the reset it
  reported, and 0.2.22 extended that to every choice and read bb's log to
  tell whose report a failure carried. It changed how every thread's
  turns were placed, waited for and released, for an advice that only
  tells, and each review found new ways it crossed the waits, the grace
  after a move, the filter of old measurements and the report's date.
  Every choice judges each account on its own numbers again, as in
  0.2.20, and the plugin no longer reads bb's log to tell whose report it
  is.

### Changed

- **The account named for Opus is where the placement would run the
  Opus turn.** The advice asks the same function the placement before a
  turn uses, with the same usage reads, from where the decision leaves
  the project (the account waited for, or the one it sits on), so a new
  message sent in Opus on those reads runs where the advice said (not
  Send now on a queued retry, which skips the placement: README, Known
  limitations, since 0.2.24). When that placement would keep the
  project where Opus cannot run, nothing is said. The account the turn
  just failed on is judged there on its numbers like any other: when the
  provider's report is ahead of them, the advice and the placement both
  name it, and the Opus turn may fail there once, then goes through the
  failure path like any Opus turn. The README lists it under Known
  limitations, with a wait that can follow another account's report
  (older than the advice, not fixed yet).

### Fixed

- **Switched off during a rescue, the project stays.** The retry chain
  the advice is told once for was read after a rescue checked that the
  automatic choice was still on, and before it moved the project:
  switched off meanwhile, the project still moved (no retry was queued).
  A failure now reads the chain before anything is checked, and a rescue
  takes it from the turn it had already read.
- **Switched off during a judgment, no history row for the advice.** A
  failure judged while the automatic choice was switched off, a turn of
  the thread started or the thread was archived still wrote the row
  telling the thread to switch to Opus. As with the banner, the row is
  only written when none of those happened since the judgment began.
  (Not yet in the row of a move the judgment still made: fixed in
  0.2.24.)

## [0.2.22] - 2026-10-17

### Fixed

- **An account a blocked report put out is out of every choice, until
  its reset.** (Removed in 0.2.23, with the next item.) In 0.2.21 only
  the placement before a turn and the Opus advice left it out: the
  choice after another thread's failure, a thread left in error, the
  release of a wait and a move ahead of the limit still judged it on its
  numbers read before the report, and could send a turn straight back to
  it. They all leave it out now, and a wait for it lands on the reset it
  reported (or later, when its own numbers say so).
- **A report puts out only the account it came from.** (Removed in
  0.2.23.) bb sends a thread's latest limit report with each failure,
  whichever turn it came from: after a move from one account to another,
  a failure on the second
  could carry the first one's report and put the second out, and the
  Opus advice then named an account other than the one the Opus turn
  stayed on. A report now puts its account out only when bb's log shows
  it came while the failed turn ran (the first report or request after
  that turn's request is a report). Otherwise, or when the log cannot be
  read, no account is put out and the account is judged on its numbers.
  A read of the account made after the report decides from then on.
- **A judgment still reading does not put the banner back.** A failure
  being judged when the automatic choice was switched off, when a turn of
  the thread started or when the thread was archived could put the banner
  back once its reads ended. A judgment now shows or takes away the
  banner only if none of those happened since it began, and no banner
  shows with the automatic choice off.
- **The banner reads again when bb's connection comes back.** bb does not
  replay its realtime signals: one that added or took away the advice
  while the connection was down was lost, and the banner kept what it
  showed until the next one. It now reads the thread's advice again when
  the connection is back.

## [0.2.21] - 2026-10-17

### Added

- **The thread shows the advice to switch to Opus when nothing is
  queued.** Beyond `maximumWaitHours`, or when no account will free, a
  thread told to switch to Opus had the text only in the history and the
  log. It now shows in a banner over the thread's composer (bb's composer
  banner, scoped to threads), which schedules nothing and changes no
  model: the switch stays yours. The banner goes when a turn of the thread
  starts, when a later failure of it is judged without the advice, when
  the thread is archived and when the automatic choice is switched off. A
  wait still says it in its queued retry and shows no banner.

### Fixed

- **The account named for Opus is the one the Opus turn runs on.** (The
  report's veto below was removed in 0.2.23: the advice now asks the
  placement itself.) The advice left out the account the turn failed on
  when its report blocked
  a window, while the placement before the next turn judged that account
  on its own numbers, which can still show room: the thread was told one
  account and its Opus turn stayed on the other. A blocked report now puts
  its account out of every turn until the reset it reported (for two
  refreshes when it names none), for the advice and for the placement
  alike, also when the failure is a leftover's. A warning report puts no
  account out. A turn in the preferred model does not go back to such an
  account before that reset either.
- **Another thread that follows the wait is told what the latest reads
  say.** It used to copy the wait's text, so after a refresh that found
  the account named out of Opus, or failed to read one (a 429), it named
  that account or said the model was gone on a failed read. The advice is
  now judged again on the measurements as they stand, and a failed, missing
  or old read says nothing.
- **One history row per turn, its retries included, also in a move.** A
  retry was taken for the turn told before whatever turn it belonged to,
  so a new turn told only at its second attempt got no row; and a retry
  whose wait moved the project wrote the text again in the move's row. The
  turn is now its retry chain, as bb's log names it, and a move of a turn
  already told is recorded without the text.
- **A thread whose preferred model is Opus is never told to switch to
  Opus.** Under a warning report the account it failed on could still be
  named by its numbers.

## [0.2.20] - 2026-10-17

### Added

- **A thread told to switch to Opus when no account has the preferred
  model left.** bb gives a plugin no way to send a retry in another model,
  so a turn in the preferred model (Fable) that no account can run now
  says what to do: when it waits, when the wait would be beyond
  `maximumWaitHours` and when no account will free, as long as an account
  can run Opus without spending the preferred model's weekly. A wait's
  retry reason ends with `. No Fable on any account: switch this thread to
Opus with the model picker; it will go to <name>`, naming the account
  the project's next Opus turn would run on, and so does the retry of
  another thread of the project that follows the wait; the history gets
  the text once per turn sent (from the project's account to itself when
  nothing moved; its retries add none), and the log every time. With
  nothing queued (beyond the maximum, or no account will free) only the
  history and the log say it. "No account can run it" means none
  unlocked with its session, weekly and the model's window all under
  100 %, the account the turn just failed on never counting; a usage
  read that failed (a 429), was never made or is older than two
  refreshes is no proof of it, and then nothing is said. Once the model
  is back the queued wait runs as before. Measured over 9-16 October 2026
  with the author's usage history: 12 h in which every account was out of
  Fable while Team seats still had Opus. The plugin still never changes a
  thread's model.

## [0.2.19] - 2026-10-17

### Changed

- **The session quarter goes before the deadline.** Usable accounts are
  ranked by the quarter their 5-hour session is in (0-24 %, 25-49 %,
  50-74 %, 75-99 %), then by the closest deadline for the model, then by
  the exact session use and the name. Ordering by the deadline alone sent
  every new session to the account whose window ends first until its
  5-hour session burned, while other accounts able to run the same model
  sat idle. Over the week of 9-16 October 2026 the author's usage history
  (measured with the author's `medir-reparto.py`) showed 52 h with one
  account holding the preferred model at 80 % session or more while
  another one sat under 20 %, and 7 h in which the preferred model was
  left only on accounts whose session was at 100 %. Within a quarter what
  runs out first is still spent first. For another model the reserve
  rules stay in front: an account out of the preferred model goes first,
  then a Team seat that keeps it, and a Max account that keeps it is still
  never chosen; among the accounts out of the preferred model, a Max
  account whose weekly resets soon no longer beats a seat whose session
  sits in a lower quarter.

## [0.2.18] - 2026-10-14

### Fixed

- **Recovery of a retry that fails twice.** When provider-retry's row has
  been replaced and the plugin's own retry then fails (a 5xx), the row is
  queued again as it was; that recovery now holds in the cases 0.2.17 left
  open. A failed second look at the queue no longer escapes before the row
  is put back. A retry bb refuses because it already has one of the turn,
  or because the turn is no longer the failed one, is no failure, before
  and after the restore. A restore whose answer bb lost is looked for in
  the queue instead of being reported as failed. The row put back is
  marked, so a later refresh releases it as soon as its account is
  measured able to run the turn (never on an account that cannot be
  measured), like a wait the refresh released that bb did not take; a mark
  is set only for a row found queued, and marks made while a refresh was
  reading the queue survive it. The log names the row that could not be
  removed instead of calling it another retry.

## [0.2.17] - 2026-10-13

### Changed

- **A Max account that keeps the preferred model is no target for another
  model.** Measured 2026-10-13: on a Max account the general weekly window
  and Fable's reset together, so an Opus turn there spends what Fable
  needs. Such an account is never chosen for an Opus turn, not even as the
  last resort (`spendsReservedWeekly` in the policy): a known project on
  one moves to a Team seat, or to an account out of Fable, before the turn
  (`current-reserved`), and when no account spares Fable the turn stays
  where the project is and the log says so (`Opus turn stays on …: no
account spares Fable`). A failed Opus turn waits only for an account
  that will spare Fable when the retry is sent (each account projected to
  the latest possible send, from now at the earliest), or is left alone
  with the new reason `reserved-for-preferred-model`; a leftover Opus turn
  is never retried on such an account by the grace shortcuts, and a
  waiting Opus retry is never released on one by the refresh.

### Added

- **Excursions.** The plugin remembers, in memory, the account a project
  left for a turn in another model, and takes the project back there
  before its next turn in the preferred model (`back-from-excursion`), as
  soon as that account can run it and the project did not leave it ahead
  of the limit. A later move for the other model keeps the first origin;
  a move for the preferred model, a pick by hand (also one that confirms
  the account) and `release` forget it (`release` also for a project on
  the default account with no variable of its own); a move that crossed
  another move, a read of the project's account that did, or a pick by
  hand while the move's answer was pending, notes nothing. The way home
  depends on home's measurement alone, not on the seat's. A reload
  forgets it too: the project stays where it is.
- **A leftover turn follows the recorded move only while the project
  still sits where that move put it** and no move is under way; and a
  failed turn is judged on the clock after the accounts were re-read, so a
  Max account whose Fable reset passed meanwhile keeps Fable again.
- **The retry provider-retry queued is never sent as it is.** An explicit
  send skips bb's dispatch checkpoint, where the turn is placed: the retry
  ran where the project stood when the row was found, not when it was
  sent, so an Opus retry could start on a Max account a Fable turn had
  taken the project back to meanwhile. The row is replaced by a retry of
  this plugin's, which bb dispatches through the checkpoint at once. If
  ours cannot be queued, the row is put back as it was; if the row cannot
  be removed, ours is queued anyway and bb keeps whichever it has: the turn
  is never left without a retry.
- **A new thread of a project on an excursion goes home too**: the
  placement a new thread causes takes the way back like a turn's does.

## [0.2.16] - 2026-10-12

### Added

- **`switchAheadOtherPercent`.** A second ahead-of-the-limit percentage
  for threads sent with a model other than `preferredModel`. An Opus
  thread on a Team seat at 95 % of its session moves to the Team seat
  with room before its next turn fails, while Fable threads keep
  `switchAheadPercent` (0 = never moved ahead). The move is measured on
  the thread's own model and the destination is chosen for that model.
  The thread's model is the one bb logged for its latest turn, so a Send
  now or an edited message that skipped the plugin's checkpoint counts;
  a failed turn is judged by the model bb logged for that very turn. The
  account a project left ahead of the limit is not a target for it again
  while that account is still at or above the share that moved it away,
  so a project with a Fable thread and an Opus thread does not move back
  and forth between two accounts.

### Changed

- **An Opus turn goes to a Team seat before a Max account.** Among the
  accounts that still keep the preferred model, a Team seat without a
  window of its own for the turn's model spends only its 5-hour session,
  so it comes before a Max account, whose Opus turn would spend the
  weekly window Fable needs. Accounts already out of the preferred model
  still come first, and the seat preference never reorders them.
- **A Team seat's missing weekly window is marked, not guessed.** The
  usage answer with `seven_day: null` sets an explicit mark on the
  account, so the expired weekly window of a Max account (settled to 0 %
  with no reset) is never taken for a Team seat.
- **A thread in another model no longer moves ahead on
  `switchAheadPercent`.** That setting now covers threads in the preferred
  model only (before, it measured the preferred model's window for every
  thread). To keep moving the other threads ahead, set
  `switchAheadOtherPercent`.

## [0.2.15] - 2026-10-11

### Changed

- **What runs out first is spent first.** Accounts are ranked by the
  closest deadline for the model the turn runs with: the earlier of the
  weekly reset and the model's own window reset. A Team seat has no
  general weekly window, only a per-model one with its own reset; ranked
  by the weekly reset alone, every seat looked the same and the name
  decided, so a seat whose Fable window ended in a day lost it while a
  seat with four days left was spent.
- **An Opus turn keeps Fable for Fable.** When a thread is sent with a
  model other than the preferred one, accounts that can no longer run the
  preferred model come first. The reserve only orders; it never leaves a
  turn without an account it would have had.

## [0.2.14] - 2026-10-11

### Fixed

- **Team plan accounts are usable.** A Team seat answers the usage API
  with a 5-hour session and per-model weekly windows, no general weekly
  window and `seven_day: null`. The plugin read that as an incomplete
  answer and showed the account as `LOCKED`, so it was never chosen. A
  missing general weekly window now counts as 0 % with no reset when the
  answer says `seven_day: null` and has a session window. An answer that
  carries `seven_day` but no general weekly window is still unknown.

## [0.2.13] - 2026-10-04

### Fixed

- **A leftover's limit report is the old account's.** A turn that started
  before its project moved runs on the old account, and its failure, however
  long after the move, carries that account's reset. When the project's new
  account could not run it either, the plugin read the report as the new
  account's and waited for the later of the two resets, on the new account,
  with the new account free an hour before (a thread of 2026-10-04 waited
  from 3 am to its old account's reset while its project's account freed at
  2 am). The report now belongs to the account the turn ran on: that account
  is never switched to (a wait may still move the project there when its
  reported reset is the earliest), its refusal (no login) marks it and not
  the project's account, and the project's account is judged on its
  measurements alone.
- Where a turn ran is forgotten once it ends (`thread.idle`) or fails,
  whatever the plugin makes of the failure: a later failure that no new turn
  announced (a turn refused at the door) is the project's account's. A start
  read that outlives its turn, or that a newer turn's read overtakes, writes
  nothing.
- A leftover refused (no login) by the account it ran on marks that account,
  also when the leftover is retried on the project's account: before, the
  refusing account stayed eligible for other projects.
- Where a turn started is read when bb announces it, and bb announces it
  after reading the account for it: a move of the project completed in
  between made the start the new account's, and a refusal of that turn set
  a healthy account aside for 6 hours. The project's state is now anchored
  when bb asks to send the message; a start read across a move since, or
  while the project moves, or that could not be read, is unknown: its
  failure's report belongs to nobody, its refusal marks no account, and
  such a refusal is retried as many times as any other failure, then left
  for the periodic rescue. A turn that bb sends past that checkpoint (a
  queued message sent by hand with "Send now") is unknown too; the retries
  the plugin sends itself anchor the project's state right before sending.

## [0.2.12] - 2026-10-04

### Fixed

- **A thread left in error is looked at again.** bb's provider-retry gives
  up after five attempts and so did this plugin, so a thread whose attempts
  were burnt in minutes (a retry of every failed turn was on its way seconds
  after the failure, before this plugin judged it) sat in error for good,
  with accounts free. On every refresh, each of the user's threads in error
  with nothing queued is judged from bb's log, as bb's own failure event
  reads it (the failure of its latest turn, a turn refused at the door
  included): retried on the project's own account when that has room now,
  moved to an account that can run it, or queued to wait for the earliest
  measured reset. The attempt cap does not apply there (the refresh paces
  it), a log with no limit report is judged on the measurements alone, and
  the thread is read again when its project's turn comes (archived, running
  again or retried meanwhile: left alone; a retry another plugin queued
  meanwhile is left to it). A refusal found there (no login) marks no
  account: bb's log does not say which account ran the turn, so the thread
  is retried where the project sits and the account marks itself if it
  refuses again. A retry the user cancelled by hand (bb's queued card,
  `bb thread queue`) is not queued again: the thread is left alone until a
  new turn of it (bb's own Retry included), across restarts.
- A refusal (no login) marks the account whatever the attempt: at the fifth
  it was declined before the mark, and a thread left in error was retried
  on the same account on every refresh.
- bb's 409 on a retry it already has (`retry_already_queued`,
  `no_failed_turn`) is logged, not thrown as a failed handler.
- The retry already queued for a failed turn is named in the log (its reason
  and time): the trace of whoever retries ahead of this plugin.
- A thread whose wait was released on another account is judged afresh if
  it fails there, instead of being retried at once as a leftover of the
  account its turn started on.

## [0.2.11] - 2026-10-04

### Fixed

- **A turn no longer waits hours for a reset when another account can run
  it.** A wait is chosen with the measurements at hand, and an account
  that could not be measured then may have room soon after. Every queued
  wait is now looked at again after each usage refresh: when the
  project's account is measured unable to run the waiting turn's model,
  has no login, or refused a turn in the last six hours, and another
  account can run it, the project moves there and bb retries the turn at
  once, through the same checks as any message, other plugins' included.
  A wait queued before the project last changed account is retried the
  same way. Left as they are: a wait due within two minutes, one another
  plugin holds, a retry of an earlier turn, one of an archived or deleted
  thread, and one whose account may still run it. If bb does not take the
  retry, the wait is queued again as it was and looked at again in the
  next pass; if that fails too, the plugin's log says so as an error.

## [0.2.10] - 2026-10-03

### Changed

- **Needs bb 0.45 or later** (plugin SDK 0.6.15). The new-thread control
  now reads the composer bb 0.45 gives plugins, and hides while another
  provider is picked. On bb 0.44, `bb plugin update` keeps 0.2.9 and lists
  this release as blocked until bb is updated.
- The listing and the overview mention the account control in the
  new-thread composer.
- `@types/better-sqlite3` back to 7.x, the range the plugin SDK declares.

## [0.2.9] - 2026-10-03

### Added

- **The account is in the new-thread composer too.** Before the first
  message, the composer shows the account the picked project is on, with
  the same coloured dot as a thread's header, the best account beside it
  when it is another one, and the same menu to switch to it or to any
  other. Picking an account there before you send, even the one shown,
  keeps the project on it from the first message, unless that account is
  out of your preferred model when the thread is created; without a pick,
  a new project still moves to the best account after its first turn.
  A message sent while a pick is still being saved can start on the old
  account, and that turn's own placement can then write over the pick. On bb 0.45 and later it shows
  only when Claude Code is the picked provider; bb 0.44 does not tell
  plugins which provider is picked, so there it shows for every provider.
  On a phone it shows once the composer is open. A project made a moment ago shows at once: a view that needs a project
  missing from the list the views share reads it again.

## [0.2.8] - 2026-10-02

### Fixed

- **The account control in a thread's header no longer comes and goes.**
  It drew nothing until two reads answered (is this a Claude Code thread,
  and the list of accounts and projects), again on every thread switch,
  and a failed read was never tried again. With bb busy on 2026-10-02 each
  list took 3-10 s (measured), so the control appeared on some threads and not on others. A
  header now starts from the last list any view received, asks once per
  thread whether it is a Claude Code thread, and retries a failed read (2,
  5, 15 and 30 s, then once a minute) while it is open.
- **Listing the accounts costs bb far less.** Each list read every
  project's machine environment, one bb call per project, and every open
  view listed again on the same event. On 2026-10-02 bb's server stalled
  over half a second 556 times in 3 h, with this list in flight in about
  140 of them. The views now share one read for 30 s; a change made by the
  plugin, or in the accounts it finds, drops it; one made in bb's own
  settings shows within that time.
  The Refresh button, the account menu, logins and the CLI still read
  fresh, and decisions still read each project directly.
- **A retry refused because a newer turn replaced the failed one is not an
  error.** When a message sent after the failure has started a newer turn,
  bb refuses the retry ("is not the failed turn"); that newer turn runs on
  the project's account and its own failure is handled apart. The plugin
  logs it and moves on instead of reporting a failed handler.

### Changed

- `@types/node`, `hono` and `vitest` updated to their latest patches.

## [0.2.7] - 2026-10-02

### Fixed

- **A long turn is judged by its own model after a reload.** The model a
  thread was sent with was only kept in memory, so a turn that outlived a
  reload or a restart of the plugin was judged against `preferredModel`.
  On 2026-10-02 an Opus turn that had run for 2 h 40 min hit its account's
  weekly limit half an hour after a reload; judged against Fable, which no
  account had left, it was given up (`no switch (beyond-maximum-wait)`)
  while two other accounts still had a quarter of their week left. Now a
  thread the plugin has not seen sent is judged by the model of its latest
  message in bb's log; the preferred model decides only when the log names
  none.
- **A limit enforced before bb reported it blocked is acted on.** bb sends
  a failed turn with the thread's latest stored rate-limit report; when
  the provider refuses the turn before reporting the limit reached
  ("rate limit rejected; type seven_day_overage_included"), that report is
  still a warning and the plugin left the turn failed (`ignored
(no-rate-limit-state)`). A `rate-limit` failure under a `warning` report
  is now judged like one under `blocked`; when no other account can run
  the turn, the failed account is waited for until the window that
  warned resets, not the one that resets last.

## [0.2.6] - 2026-10-02

### Fixed

- **An account that refuses the turn is left like one at its limit.** On
  2026-09-30 an account whose organization had turned off subscription
  access answered every turn with "Your organization has disabled Claude
  subscription access for Claude Code" (HTTP 403) while its usage still
  measured fine; the plugin took it for an error that was not its business
  and left the turn failed. Now a refused turn (`unauthorized`, in a Claude
  Code thread) moves the project to another account and runs again there,
  as after a limit, and the account that refused is chosen for nothing for
  6 hours: no new project is placed on it, a project still on it leaves at
  its next thread, and a switch never goes back to it. The retry says which
  account refused (`Switched to account work: main refused the turn`), and
  so does a project moved off it before a turn (`main refused a turn`). It
  is remembered in memory: `bb plugin reload claude-switcher` forgets it.
  This also covers a new thread's first turn, which in bb 0.44 starts on
  the account the project had before it was placed.

### Added

- `THIRD_PARTY_NOTICES.md` lists the licenses of `zod`,
  `@radix-ui/react-slot` and `@radix-ui/react-compose-refs`, which the
  built plugin bundles.

## [0.2.5] - 2026-09-30

### Fixed

- **A thread you switch to another model follows that model.** Every
  decision looked only at `preferredModel`, so a thread switched to Opus
  in bb's model picker, in a project whose account was out, kept waiting
  for the preferred model (or failed with a 429) while other accounts had
  Opus left. bb now tells the plugin the model each turn is sent with
  (its dispatch checkpoint), and that model decides:
  - **Before every turn**, a project whose account is measured unable to
    run the turn's model moves to an account that can. It is decided on
    the measurements already there; nothing is asked of the provider, and
    the message is never refused and is delayed 3 seconds at most: if
    anything fails here, it is logged and the message goes on as before.
  - **When a turn fails on a limit**, it is judged against the model its
    thread was last sent with: an Opus thread switches to an account with
    Opus left, or waits for Opus.
    A thread sent with the preferred model is decided by that model, as
    before: when no account can run it, the project stays and the retry
    waits for it. A thread bb has not sent a message for since the plugin
    started is judged by the preferred model. The plugin never changes a
    thread's model: it only chooses the account. With `preferredModel`
    empty, a thread's own model now counts too, and the reasons name it
    (`Waiting for Fable on work`).

## [0.2.4] - 2026-09-30

### Added

- **Add an account from bb.** Settings has an **Add account** form, and a
  **Log in** button on every account without a login. Both run Claude
  Code's own `claude auth login` for the account's directory and open the
  consent page in a private Chrome window on macOS, so the login does not
  reuse the browser's Claude session (the default browser when Chrome is
  missing, when `loginPrivateWindow` is off, and on Linux). The account is measured when the login
  ends, and the section says when the login left no account, no login, or
  the Claude account of another directory; such a directory keeps saying
  it on its card, with **Log in again**. While it runs, the section
  shows a link to the login page and a field for the code that page
  gives, for when no window opens. One login at a time, given up after 10
  minutes and stopped with the plugin. A new name that differs only in
  case from an account or a directory, or that is a link or a file, is
  refused, and so is a new directory under `~/.claude`. The login does
  not inherit credentials from bb's environment.
  A directory the plugin creates links
  `projects`, `settings.json`, `hooks`, `CLAUDE.md`, `plugins`, `skills`,
  `agents`, `commands` and `rules` from `~/.claude` (those that exist), so
  threads can move to the new account; a directory that already existed is
  left as it is. New settings: `claudeCommand` and `loginPrivateWindow`.
- **Switch ahead of the limit** (opt-in: `switchAheadPercent`, 0 = off;
  needs `autoSwitch`).
  When a turn ends with the project's account at or above that share of
  its session, weekly or preferred-model window, and another account is
  below it in all three (measured lately, and another Claude account),
  the project moves there. No turn is interrupted
  and no retry is spent. It acts on measured usage (the project's account
  is measured again when its measurement is over a minute old), not on
  the forecast.
- **A forecast per weekly window.** Under each weekly and per-model window
  in Settings, in the thread header menu and in `list`: when the window
  runs out at the average pace since the plugin first measured the
  current window, or
  that it lasts until its reset. It needs two hours between that first
  measurement and the latest (both kept in the plugin's storage) and says
  nothing under one point a day, or once the moment it projected has
  passed.
- **History of moves.** Every move of a project (after a failed turn, when
  a thread is created, ahead of the limit or picked by hand) with its
  time, accounts and reason: the last 100, in Settings and with
  `bb claude-switcher history [--json]`. `release` is not recorded. It
  starts with the last switch 0.2.3 had stored.

### Changed

- Settings lists the history instead of only the last automatic switch.
- The setup loop in the README also shares `skills`, `agents`, `commands`
  and `rules`.

## [0.2.3] - 2026-09-30

### Added

- The project's account in every Claude Code thread's header, with a dot
  for how it stands for the preferred model (room, running low at 80 %,
  out, not measured, or no login) and a menu: switch now to the account the switch
  policy would pick, or pick any account. The change applies to every
  thread of the project from its next turn. Uses bb's experimental thread
  header slot, registered only when the host offers it. Its menu uses the
  dropdown menu of bb's component registry (Radix, provided by the host).

### Fixed

- A hand pick of an account (header, Settings or `use`) is kept when a
  turn still running on the old account fails right after it: that turn
  is retried once on the picked account, as after a switch, instead of
  moving the project elsewhere or waiting for the old account's reset
  (unless the picked account is measured out of usage or has no login).
- A pick and an automatic move of the same project no longer interleave:
  the pick waits for it and lands last.
- A turn that started on the project's old account and fails more than
  a minute after the move (a long tool call) is retried on the new
  account (unless that account has no login or is measured out),
  instead of being judged as the new account's failure (which
  moved the project again or waited hours for the old account's reset).
- Settings shows 0 % for a window whose reset has passed.

## [0.2.2] - 2026-09-29

### Added

- New projects go to the best account. When a thread of a project created
  after the plugin first ran (for an update from 0.2.1, after the first
  start of 0.2.2) is created, the project moves to the
  account the switch policy would choose (the preferred model included)
  instead of staying on the default account. A project the user already
  pinned, the default account included, is left alone.
- A project whose account is already measured unable to run (a reported
  lock, a window at 100 %, or the preferred model used up) moves to the
  best other account when a thread is created. A usage answer with a
  missing window is not taken as proof. A project pinned by hand stays put
  while its account works.
- Both race the thread's first turn: if that turn starts first on the old
  account and fails, it is retried once on the new account instead of
  being judged against it.

### Fixed

- A failed turn of a hidden thread (for example another plugin's summary
  worker) no longer moves the whole project to another account. Visible
  threads are the user's work even when a plugin's composer opened them,
  and are handled as before.
- `bb claude-switcher use` and the project picker read the accounts again,
  so a changed accounts directory or a new account directory needs no
  refresh first, and a measurement of an account that is gone is never
  used.

### Changed

- The personal project ("Don't work in a project") is listed in Settings
  and by `list`, and `release` removes a variable the plugin set there.
- Every placement decision, including leaving a project where it was, is
  logged with its reason.
- Development dependencies: better-sqlite3 13, hono 4.13.11; the plugin
  SDK stays pinned to bb's own (0.5.29), now checked in CI.

## [0.2.1] - 2026-09-29

### Added

- A logo for the README and the plugin's own icon in bb, instead of a
  generic one (the glyph is Lucide's `repeat`, ISC License).
- A README in a new layout: the problem, a before/after table, where to
  find each surface in bb, and what the plugin never does. Every setting,
  caveat and the disclaimer are unchanged.
- `docs/DESIGN.md`: how the plugin measures, chooses, waits and declines,
  why, its known limits and the decisions not taken.

## [0.2.0] - 2026-09-29

### Changed

- Renamed to **Claude Switcher**. The plugin id and the CLI are now
  `claude-switcher` (`bb claude-switcher list`, `refresh`, `use`,
  `release`), the repository is `Finolaina/bb-plugin-claude-switcher`, and
  the note next to each `CLAUDE_CONFIG_DIR` it sets reads "set by the
  Claude Switcher plugin". Behaviour is unchanged.

### Upgrading from claude-accounts 0.1.x

bb treats the new id as another plugin. Note your settings
(`bb plugin config claude-accounts`), run `bb claude-accounts release`
and `bb plugin remove claude-accounts`, install `claude-switcher`, set the
settings again and reassign any project with `bb claude-switcher use`.

## [0.1.0] - 2026-09-29

First public release.

### Added

- Every Claude Code account the plugin finds (`~/.claude` plus each
  subdirectory of the accounts directory that holds a `.claude.json`) in
  bb's Provider usage panel, with the 5-hour session, weekly and
  per-model weekly windows.
- Automatic switch and retry when a turn fails on a subscription-window
  rate limit, following a policy that ranks accounts by the closest weekly
  reset and respects a preferred model.
- Waiting for the account that frees first when none is free, within a
  configurable maximum wait, in cooperation with bb's provider-retry
  plugin.
- A **Claude accounts** section in Settings with account cards, a
  per-project account picker and the last automatic switch.
- The `bb claude-accounts` CLI: `list`, `refresh`, `use` and `release`.
- macOS keychain and Linux credentials-file support; rotated OAuth tokens
  are written back and verified by reading them again.

[0.2.13]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.13
[0.2.12]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.12
[0.2.11]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.11
[0.2.10]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.10
[0.2.9]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.9
[0.2.8]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.8
[0.2.7]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.7
[0.2.6]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.6
[0.2.5]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.5
[0.2.4]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.4
[0.2.3]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.3
[0.2.2]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.2
[0.2.1]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.1
[0.2.0]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.0
[0.1.0]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.1.0
