# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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
  preferred model (`… before the turn: <old> is not logged in`). When no
  account can, bb refuses the message with the command that fixes it
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
