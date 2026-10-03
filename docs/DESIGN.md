# Claude Switcher: design

This document explains how the plugin decides, why each rule exists, and
what it deliberately does not do. The README says how to use it; the code
is the source of truth for every constant quoted here.

## The problem

Claude Code has three usage limits per subscription: a 5-hour session
window, a 7-day weekly window, and 7-day windows per model (for example
Fable). They reset on their own clocks and are not interchangeable: an
account with session room but no weekly room cannot run a turn, and an
account with weekly room but no Fable room cannot run a Fable turn.

People who hold more than one subscription keep one login per Claude Code
config directory (`CLAUDE_CONFIG_DIR`). bb runs every thread of a project
with that project's environment, so the account a thread uses is decided by
one variable on the project. When a turn fails on a limit, bb and its
bundled provider-retry plugin retry at the provider's reset; nothing moves
the project to an account that could run the turn now.

The plugin does exactly that, and nothing more: it measures every login
that already exists on the machine, and when a turn fails on a Claude Code
subscription window it points the project at a login that can run it, or
waits for the one that frees first. So that a new project does not start
on a login that is already out, it also places projects when a thread is
created (below).

## Pieces

| File                 | Role                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/accounts.ts`    | Discovery: `~/.claude` (no variable) plus every subdirectory of the accounts directory that holds a `.claude.json`.                                                     |
| `src/credentials.ts` | Reads each login from the macOS keychain or `<dir>/.credentials.json`, refreshes an expired token, writes it back and verifies the write, and calls the usage endpoint. |
| `src/usage.ts`       | Parses the usage endpoint's answer into session, weekly and per-model windows.                                                                                          |
| `src/collector.ts`   | One cached measurement per account, single-flight queries, the rule for stale measurements.                                                                             |
| `src/policy.ts`      | Pure ranking: which usable account to choose.                                                                                                                           |
| `src/switch.ts`      | Pure decisions: where a project runs before a new thread's first turn, what to do with one failed turn (switch, wait or decline), and whether to move ahead of the limit after a turn. |
| `src/forecast.ts`    | Pure: the usage samples of a window and the pace they give.                                                                                                             |
| `src/login.ts`       | A `claude auth login` run for one account directory: its phases, the fallback address and code, the timeout, and what a new directory shares with `~/.claude`.          |
| `bin/open-login.sh`  | The `BROWSER` of that login: opens an `https://` address in a private Chrome window, or the default browser.                                                            |
| `server.ts`          | Wires it to bb: settings, the Provider usage source, `thread.created`, `turn.failed`, `thread.idle`, project variables, retries, the history, CLI, realtime updates.     |
| `app.tsx`            | The Claude Switcher section in Settings, and the account control in a Claude Code thread's header and in the new-thread composer.                                       |

The policy and the decision are pure functions of their inputs (usage,
the failure, `now`, a random number), so every rule below has a unit test
that does not touch bb, the keychain or the network.

## Measuring usage

Each account's OAuth token is sent to the same endpoint `claude`'s
`/usage` uses (`GET https://api.anthropic.com/api/oauth/usage`), with a
20-second timeout. The background service measures every account at start
and then every `refreshMinutes` (default 5, never below 1). A failed turn
triggers a fresh measurement of every account before any decision.

- **Sequential, single-flight.** Accounts are measured one after another,
  because the usage endpoint rate-limits bursts. Concurrent callers (the
  panel, a failed turn, the background refresh) share one in-flight query
  per account, so an expired token is refreshed once: two refreshes with
  the same refresh token would log the account out, because it rotates.
- **A blip does not blind the policy.** A rate-limited or failed query
  keeps the last good usage, with its original measurement time, and the
  panel shows the problem next to it.
- **Stale blocks are not trusted.** When the last good measurement is
  older than twice the refresh interval and queries keep failing, an
  account that only the clock would free (measured blocked, with the
  reset now passed) is left out of the decision: it is unknown, not free.
  A block whose reset is still ahead stays, because waiting for it is
  known. A stale free measurement stays too: a reset cannot have made it
  worse, and a wrong switch costs one attempt where a wrong wait costs
  hours.

## Choosing an account

`policy.ts` is a port of the rules of the author's shell account switcher,
so both tools pick the same account.

1. An account is **usable** when the provider reports no lock and both the
   session and the weekly windows are under 100 %.
2. With a **preferred model**, the account must also be under 100 % in that
   model's window (matched case-insensitively). No row for the model means
   it counts against the weekly window only.
3. Usable accounts are ranked by the **closest weekly reset**, then the
   **lowest session use**, then the **name**, never by the order in which
   they were measured. Spending the account whose week ends soonest first
   wastes the least quota.

## Placing a project before the first turn

A project bb created after the plugin was installed starts on the default
account, and so would fail its first turn whenever that account is out.
When a thread is created (`thread.created`), `decidePlacement` looks at the
measurements already in hand; it queries the accounts only when none has a
usable measurement, and if none can be measured the project is left alone
(and still counts as new for its next thread):

1. **A new project** goes to the best account under the policy above. A
   project is new when bb created it after the plugin first ran (plugin
   storage, key `installed-at`, compared with the project's `createdAt`)
   and it was never placed, kept, pinned (thread header, new-thread composer, Settings or `use`), or
   given a thread while `autoSwitch` was off (key `handled-projects`). A
   project that already carries a variable this plugin set is never new.
2. **A known project** moves only when its account is **measured** unable
   to run: a lock the provider reported, a window at 100 %, the
   preferred model used up, or a turn it refused in the last 6 hours (see
   "Deciding on a failed turn"). A usage answer that lacks the session or the
   weekly window is unknown, not out, and moves nothing. A project pinned
   by hand stays put while its account works, even when another account
   ranks better.
3. **Nothing happens** for a hidden thread (whoever opened it), a thread
   of another provider, a project whose
   `CLAUDE_CONFIG_DIR` the plugin did not set, or when no other account
   can run. A pick by hand waits in the project's queue for a placement or
   a switch in progress and lands after it, so the pick wins (the placement
   before a turn is the exception: see Known limits).

A move is recorded as the last switch and opens the same 60-second grace
window as a switch after a failure, so the project's threads still running
on the old account follow it. If the install time cannot be read or
stored, no project is moved for being new; the measured-block rule still
applies.

This check races the thread's first turn on purpose: it may have to query
the accounts, and bb's dispatch checkpoint fails the turn when a plugin is
slow (the checkpoint is used only for the bounded rule of the next
section). When the turn starts first, it runs where the
project was; if it fails there, it is retried once on the new account (the
placing thread gets the grace retry too, because no failure caused the
move), and a second failure is judged as below.

## Placing a turn by its model

bb runs its `message.dispatch` checkpoint before each message is sent, and
says there the model the turn will run with (`requestedExecution.model`);
neither a thread row nor a failed turn carries one. The handler translates
the id to the usage API's name (`claude-opus-5-5` → `Opus`), remembers it
for the thread, and, for a message that starts a turn, applies the rule
for a known project above with that model in place of the preferred one:
the project moves only when its account is measured unable to run that
model and another account can.

The checkpoint fails a message whose handler throws or takes more than
10 s, and runs every handler under one lock, so this one:

- always answers `proceed`: it never refuses a message nor sends it to
  bb's queue, and delays it 3 s at most;
- decides on the measurements already in hand and asks the provider
  nothing;
- catches every error (logged as a warning) and gives the placement up
  after 3 s (`DISPATCH_LIMIT_MS`): a placement that has not begun to
  write the variable by then moves nothing;
- stays out of the project's queue: a retry sent from that queue passes
  through this same checkpoint and would wait for itself.

It does nothing for a message that joins a running turn or is queued
behind one (the thread is starting, active or stopping: bb asks again when
it sends the message), a model id that is not a Claude model id (none
resolved yet, an alias), a hidden thread, another provider, a variable the
plugin did not set, or with `autoSwitch` off.

A failed turn is judged against the model its thread was last sent with:
kept in memory at the checkpoint (forgotten when the thread is archived)
and, for a thread not seen there since the plugin started (a reload or a
restart while a long turn ran), read from bb's log: the `execution.model`
of the thread's newest `client/turn/requested` event. When neither names a
Claude model (the log cannot be read, is empty, or holds an alias), the
preferred model decides. On 2026-10-02 an Opus turn of 2 h 40 min failed
on its account's weekly limit half an hour after a reload; judged against
the preferred Fable, which no account had left, it was given up, while
two other accounts still had a quarter of their week left for Opus.
The plugin never changes a thread's model: it only chooses the account.

## Deciding on a failed turn

`declineReason` runs first and is cheap, so another provider's limit never
queries every account. The plugin acts only when all of these hold:

- the attempt number is below 5 (`MAX_ATTEMPTS`, as provider-retry);
- and either the turn hit a limit: the error category is `rate-limit`, the
  rate-limit state is `blocked` or `warning`, its kind is
  `subscription-window`, and the provider is `claude-code`. A warning
  counts because bb sends the thread's latest stored report, and a
  provider that refuses the turn before reporting the limit reached
  leaves a warning there (2026-10-02: "rate limit rejected; type
  seven_day_overage_included" under a weekly warning, on an account the
  usage API measured at 96 %). Accepted risk: bb's report is the latest
  stored one, not tied to the failure, so a `rate-limit` failure that is
  not a subscription limit, under an old warning, is judged as one too;
  the cost is a needless move to an account that can run the turn,
  bounded by the attempt cap;
- or the account refused the turn: the error category is `unauthorized`
  (on 2026-09-30 an account whose organization had turned subscription
  access off answered every turn with HTTP 403 while its usage still
  measured fine; an account whose login stopped working is the same case),
  and the thread's provider is `claude-code`. A refusal carries no
  rate-limit report, so the thread row is the only thing that names its
  provider.

It also leaves alone any project whose `CLAUDE_CONFIG_DIR` it did not set
(recognised by the note it writes next to the variable), and any failure of
a hidden thread (the provider is judged from the failure's own rate-limit
report, not from the thread row): moving the whole project for another
plugin's hidden worker would surprise the user, and the plugin that owns
the worker decides what to do with it. A visible thread is the user's work
even when a plugin's composer opened it, and is handled like any other.

An account that refused a turn is taken as out for 6 hours
(`REFUSAL_MS`), whatever its usage says: no placement, switch or move
ahead chooses it, and a known project on it leaves at its next thread. The
retry's reason names it (`Switched to account work: main refused the
turn`), and the log says until when.

Then `decideSwitch`:

1. **Settle.** Every window whose reset time has passed counts as free,
   whatever the last measurement said.
2. **Switch** if another account is usable under the policy. The project's
   variable moves to it (the default account means removing the variable)
   and the failed turn is retried at once.
3. **Wait** otherwise, for the account that can run the turn first. For
   the account that just failed, the provider's own reported reset wins
   over our measurement: it is blocked at least until then (the latest
   reset of its blocked windows; under a warning report, of the windows
   that warned, since the one that resets last may not be the one
   enforced); an account
   that refused is never waited for. Ties go to the
   current account (no move needed), then to the name. The project moves
   to that account if it is another one, and the retry is queued for its
   reset plus 15 s (`RESET_BUFFER_MS`) and up to 30 s of jitter
   (`RESET_JITTER_MS`), the same numbers provider-retry uses, so a wait
   lands where provider-retry would have put it.
4. **Decline** when no account has a known reset, or the earliest one is
   further away than `maximumWaitHours` (default 6; 0 = no limit). The turn
   stays failed and provider-retry keeps its own retry.

Failures of one project are handled one at a time, in order: two threads of
the same project failing together must not make two different moves.

## Moving ahead of the limit

Off by default (`switchAheadPercent` = 0). With a percentage set, a
visible Claude Code thread turning idle is the trigger: the turn has
ended, so moving the project interrupts nothing and spends no retry.

1. The project's account is measured again unless it was measured, or
   asked for, within the last minute: the turn that just ended used some
   of it, and a provider that is failing is asked once a minute, not at
   every turn end. When the query fails, the last measurement stands. The
   query runs before the project's queue, so a failed turn of the project
   does not wait on it; the decision, inside the queue, reads the account
   the project has by then.
2. `decideAhead` keeps the project when its account is unknown or
   unmeasured, or when the fullest of its session, weekly and
   preferred-model windows (settled: a window past its reset counts 0) is
   under the percentage.
3. Otherwise the candidates are the accounts under the percentage in all
   three windows, ranked by the same policy as a switch. A candidate is
   listed now, was measured within two refresh periods (an account whose
   query keeps failing keeps an old measurement, which a switch after a
   failed turn still tries and this does not: nothing fails if the project
   stays), and is another Claude account (a directory of the same one
   shares its usage). None: the project stays. The target is under the percentage and the account left is at
   or above it; usage only falls at a reset, so the project does not come
   back before the account it left has reset.
4. The move is recorded like a switch (reason
   `Switched ahead of the limit to <name>: <old> at <n>% of <window>`) and
   opens the grace window below for turns of the same project still
   running on the old account. The thread that went idle is the move's
   cause: its next failure is judged on the new account, not retried as
   a leftover.

It needs `autoSwitch` (read again after the measurement), skips external
variables, and also moves a project pinned by hand: the percentage is the
user's standing instruction.

## The forecast

Each refresh adds a sample (time, percent) to a series per account and
window, for the weekly and the per-model windows; the 5-hour session is
too short to be worth one. A series keeps two points, the first sample of
the window and the latest, which is all the forecast reads. It starts
over when the window's reset moves by five minutes or more (the provider
answers one reset with another fraction of a second at each query) or
its share falls; a window without a reset keeps one point and has no
forecast. Samples are not pruned while the list of accounts is empty (a
changed accounts directory, before the next look). The series live in
the plugin's key-value storage, so a restart keeps them; they are read account by account, and one that cannot be read
starts again.

The forecast is the average pace from the first sample of the window to
the last: with at least two hours between them and at least one point a
day, either the moment the window reaches 100 % at that pace (when that is
before its reset) or "lasts until the reset". It is a line of text in
Settings, the header menu and `list`. No decision reads it.

## Logging an account in from bb

`claude auth login` needs no terminal: it listens on a localhost port,
hands the consent address to `$BROWSER` (one executable path, no
arguments), and completes when the browser comes back. `LoginFlow` runs it
as a child process of bb's server, without a shell, with
`CLAUDE_CONFIG_DIR` set to the account's directory (removed from the
inherited environment for the default account) and `BROWSER` set to
`bin/open-login.sh`. Exit 0 is Claude Code's word that it wrote the login
to its own store; the plugin then discovers and measures the account and
says in the login's status when the directory holds no account, the
account still has no login, or its Claude account is the one of another
directory (the browser answered with the session it had).

- **The name is a trust boundary.** It becomes a directory under the
  accounts directory: one segment that starts with a letter or a digit
  and goes on with letters, digits, dots, dashes and underscores, 64
  characters at most. `default`
  is refused when it is only the alias of the default account. An account
  that already has a login is refused: its store would be overwritten
  while a thread may be using it. The exception is a directory, other than
  the default account's, logged in to the Claude account of another listed
  one: that login is the mistake, and doing it again is the way out. On a disk that ignores case `Team` is
  the directory of `team`, and a link under the accounts directory leads
  elsewhere: a new name that matches an account ignoring case, that
  differs only in case from an entry of the accounts directory, or whose
  entry there is not a real directory, is refused. A real directory of
  that exact name without an account in it (what a cancelled login
  leaves) is taken as it is, with nothing linked into it. While the
  accounts directory is the default account's directory or inside it
  (compared without `.` and `..`, ignoring case), no new directory is
  taken: `projects` or `plugins` there are what every account shares. A listed account without a login logs in under
  the name its directory has, whatever it is.
- **A private window.** The helper opens Chrome with `--incognito`, so
  the consent page asks which Claude account to use instead of taking the
  one the browser is signed in to: that is how a second account ends up
  in the second directory. Without Chrome, or with `loginPrivateWindow`
  off, it opens the default browser.
- **The consent address is not kept.** It goes from the CLI to the helper
  as an argument. The plugin reads the CLI's output only for the fallback
  address (always printed, for when no window opens) and the prompt
  for a code; a failure message has every address replaced by `<url>`.
- **One login at a time**, given up after 10 minutes, cancellable, and
  stopped when the plugin is reloaded, disabled or bb shuts down. The
  process is killed before the end is reported.
- **What a failed login reports** is the last line it printed: addresses
  and the pasted code (whole, or either half of `code#state`, in any
  case) blanked, the prompt (printed without a line break), escapes and
  control characters removed, cut at 200 characters. A line with
  `visit: <address>` is not reported (it is the one that gives the
  address, though an error worded that way would go too), nor a line of
  one word right after a line with an address, which may be a piece of
  it; what follows the prompt on its line is always kept. A code is one
  line; control characters in it are refused. The kept output is dropped
  when the login ends.
- **No inherited credentials.** `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
  `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` of bb's environment are not passed
  on: the login is for another account.
- **The helper clears `BROWSER`.** On a Linux without a known desktop
  `xdg-open` runs `$BROWSER`, which is the helper itself; it unsets the
  variable before handing the address over.
- **A new directory shares `~/.claude`.** When the plugin creates the
  directory it links `projects`, `settings.json`, `hooks`, `CLAUDE.md`,
  `plugins`, `skills`, `agents`, `commands` and `rules` from `~/.claude`,
  for those that exist: without `projects` a thread cannot resume on the
  new account. A directory that already existed is never changed.

## The history

Every move of a project is a record (time, thread, project, from, to,
reason): after a failed turn, when a thread is created, ahead of the
limit, and a pick by hand (`Picked by hand`, only when the account
changes). The last 100 are kept in key-value storage, latest first, and
written in order so a slow write never replaces a later list; they are
read record by record. `release` is not recorded: it runs before an
uninstall. With no history stored yet, it starts with the last switch a
version before 0.2.4 kept.

## Leftover threads: the 60-second grace window

When a project moves, its other threads that were already running on the
old account keep failing for a while. For 60 seconds after a switch or a
wait (`SWITCH_GRACE_MS`), a failure from another thread of that project is
not judged again: it is retried once as it is, on the new account, or
queued for the same reset after a wait. Once per thread: a second failure
of the same thread inside the window means the new account fails too, and
it is judged from scratch. The window also closes, whoever opened it, once
the new account is measured unable to run a turn (`cannotRun`: no login,
or measured out for every model): a leftover's failure is then judged, so
it can move to an account that works. A wait keeps its window whatever a
later measurement says: that account is out until its reset.

A hand pick (thread header, new-thread composer, Settings or the CLI's
`use`) opens the same
window, unless the picked account cannot run a turn when picked.

A long turn can outlast the window. So the plugin also notes, on each
`thread.active`, the account a turn of the user's Claude Code threads
starts on. When that turn fails later on an account the project has since
left, it is retried once on the project's account, whatever the time,
unless that account has no login or is measured out. The note is used
once: the retry's own failure is judged.

## Cooperating with provider-retry

bb's bundled provider-retry plugin also listens to `turn.failed` and queues
one retry at the reset the provider reported, and bb keeps one retry per
turn. The plugin never adds a second one:

- **After a switch**, it sends the retry provider-retry already queued (the
  project is on the new account by then). If bb answers that the thread is
  busy again, the queued row stays and runs when it frees.
- **After a wait**, it replaces that retry with its own timed one. If
  queueing its own fails, it restores the one it removed.
- If another retry was queued first while it worked, it leaves that one.

Keep provider-retry enabled: disabling it is global and would also drop its
retries for overloads and for other providers.

## Credentials

Claude Code keeps each login in its own macOS keychain item:
`Claude Code-credentials` for `~/.claude` and
`Claude Code-credentials-<first 8 hex of sha256(NFC(dir))>` for any other
directory (observed with Claude Code 2.1.x). Elsewhere it is
`<dir>/.credentials.json`.

The refresh token rotates on every refresh, so the plugin:

- refreshes only a token that has already expired (an idle account; a live
  session refreshes its own);
- writes the rotated login back where the CLI keeps it and verifies the
  write by reading it again;
- if the write fails, keeps the rotated login in memory, reports it in the
  panel, and writes it on the next call, unless the store by then holds a
  different login (someone else rotated it, so the held one is dead).

## Known limits

- **On bb 0.44 the new-thread control shows for every provider.** That bb
  does not tell a composer action which provider is picked, so the control
  also shows while Codex or another provider is picked; the account it
  names applies to the project's Claude Code threads only. bb 0.45 reports
  the pickers and the control hides for other providers.
- **A message sent while a composer pick is being saved** can start the
  thread on the old account. bb gives plugins no way to hold a send: its
  input lock (`setInputLock`) only stops typing, and neither Enter nor the
  Send button checks it (bb 0.44, read 2026-10-03). The pick still lands
  for the next turns, unless that first turn's own placement writes over it
  (see "an account picked by hand during the one read a placement
  before a turn makes" below).
- **On a phone the new-thread control shows once the composer is open.**
  bb leaves plugin actions out of its collapsed one-line composer (bb 0.44,
  read 2026-10-03); a tap on the draft brings the control back.
- **With four or more plugins adding composer actions**, bb shows three of
  them in the row and the rest under "More plugin actions" (bb 0.44, read
  2026-10-03), so the control can open from inside that menu. Not tried.
- **A refresh race can log an account out.** If a running `claude` session
  of the same account refreshes between the plugin's read and its write,
  or bb stops while a rotated login is only in memory, that account needs
  `/login` again.
- **A project's account set in bb's own settings shows in the views within
  30 s.** bb has no batch read of machine environments, so the views share
  one read of every project's account for 30 s (concurrent lists included);
  a change made by the plugin, or in the accounts it finds, drops it at once,
  and a view that needs a project the read lacks (one made a moment ago)
  reads again. The Refresh button, the
  account menu, logins, the CLI and every decision read fresh.
- **Same machine only.** The variable is a path on bb's machine, set on
  the project's machine environment. The plugin does not check which host
  runs a thread, so a thread on another host may get a path that does not
  exist there, now at its first thread rather than only after a limit
  (bb 0.44 resolves the machine environment per host; not tested with a
  remote host).
- **Plugin storage may outlive `bb plugin remove`.** In bb 0.44 removing a
  plugin deletes its settings but not, as far as its source shows, its
  key-value storage. A reinstall then reads the old install time, so
  projects created while the plugin was removed count as new at their next
  thread.
- **The forecast is an average.** It is the pace since the window's
  first sample, so a burst at the end of a quiet week moves it slowly, and
  a window first seen late has a short, noisy history.
- **A new thread's first turn runs where the project was.** In bb 0.44
  the start of a new thread (its provisioning) runs alongside the dispatch
  checkpoint, not after it: in the canary of 2026-09-30 bb resolved the
  thread's environment 1.9 s before the placement set the variable. So a
  placement counts from the thread's second turn; if the first one fails
  there on a limit or a refusal, it is retried once on the new account.
- **A refusal is remembered in memory only.** A reload or a restart of bb
  forgets which accounts refused; the next refusal sets the account aside
  again. Settings and the thread header do not mark it: the account still
  shows its usage (though the header no longer offers it as the best one),
  and only the reasons of the moves it causes and the log say it refused. A refusal of a turn left on the old account after a move
  (the grace retry) sets no account aside: which account ran that turn is
  not certain. And the reverse: after a reload, a turn that started on
  the old account before it and is refused more than 60 s after a move is
  taken for a refusal of the project's current account, which is then set
  aside for 6 hours; bb does not say which account ran a turn.
- **A pick by hand does not lift a refusal.** For the 6 hours a refused
  account is set aside, a project picked onto it by hand (header,
  new-thread composer, Settings, `use`) moves off again at its next message, with the reason
  "refused a turn"; nothing but the clock or `bb plugin reload
  claude-switcher` lifts it, not a new login either. A wait for another
  account's reset after a refusal says "Waiting for ...", without naming
  the refusal. A clock set back lengthens the 6 hours by as much.
- **Every account refusing makes the plugin quiet for 6 hours.** Should an
  outage answer every account with `unauthorized`, each failure would set
  one account aside (up to the 5 attempts), and then no account is chosen:
  projects stay where they are and bb's own retry decides, as without the
  plugin.
- **Moving ahead needs a turn to end.** A project whose only thread runs
  one very long turn is not moved ahead; if that turn fails on the limit,
  the ordinary switch takes over.
- **Placement and "best now" do not read the percentage.** A new project
  is placed, and the header offers, the account the switch policy ranks
  first (the nearest weekly reset among those that can run), which may be
  at or above `switchAheadPercent`: its first turn runs there and the
  project moves ahead when that turn ends. Two records, no failed turn.
- **`lastSwitch` is the last automatic move.** A pick by hand goes to the
  history only, so `list --json` can show a `lastSwitch` older than the
  first record of `history`.
- **A move from an account that is gone is recorded as from the default
  one.** A project whose variable names a directory that no longer holds
  an account counts as on the default account, in the history too.
- **`list` says less than Settings.** The text output does not say how old
  a measurement is, that its last query failed, or that two accounts are
  the same Claude account; `list --json` has the fields.
- **A locked account under the percentage is not moved ahead.** The move
  ahead reads the used shares only; an account the provider locked below
  the percentage is switched by its next failed turn, as before.
- **A login reads "logged in" while it is checked.** The check of what
  the login left (the account, its login, whose Claude account it is)
  measures the account, which takes seconds; its note replaces "logged
  in" when it ends.
- **A clock set back delays the move ahead.** The minute between
  questions to the provider is counted from the last one; after a jump
  back, the periodic refresh still measures.
- **A forecast stops when its moment passes.** Past the moment it
  projected, with a last measurement that was not full, the pace was not
  kept or nothing was measured since: no forecast until the next sample.
- **Logging a twin in again overwrites its store.** Every directory of
  one Claude account offers it except the default account's, so two
  extra directories on one account both do, and the page does not say
  which one a project is on. A directory on the
  Claude account of another one can log in again while a thread uses it;
  that turn may fail as it would with `claude auth login` in a terminal.
- **A login outlives a killed bb.** A reload, a disable and a shutdown
  stop it; if bb's server is killed outright, `claude auth login` stays
  until it is ended by hand, waiting on a local port nobody else can use.
- **Only four credentials are kept from the login.** The rest of bb's
  environment reaches `claude` and, on Linux, the browser.
- **A failed start names the command.** "could not run ..." repeats the
  `claudeCommand` setting as it is written.
- **Logins are not rationed.** Any local process that can call the
  plugin's RPC as the app can start and cancel logins, each leaving a
  directory; it runs as the same user, who can do as much by hand.
- **A move-ahead percentage above 100 never moves.** It is not refused.
- **Accounts that vanish for a moment lose their samples.** If the
  accounts directory cannot be listed while the default account still
  is, the series of the others start again at the next look.
- **The accounts directory is compared as written.** A link that leads
  into `~/.claude` is not followed when refusing a new directory there.
- **A cancelled login leaves its directory.** Claude Code writes a
  `.claude.json` there as it starts, so the name stays listed as an
  account without a login; log it in later or delete the directory.
- **A login is stopped with one signal.** Cancel, the timeout and an
  unload send SIGTERM and do not wait for the process to end.
- **The private window is Chrome on macOS.** Elsewhere, and without
  Chrome, the login opens the default browser, which may be signed in to
  another Claude account.
- **A login from bb needs the `claude` executable** in the `PATH` of bb's
  server, or its full path in `claudeCommand`.
- **Shared transcripts are required.** A switch changes the whole config
  directory, so an account directory must share `projects/` (and normally
  settings, hooks and `CLAUDE.md`) with `~/.claude`, or the retried thread
  cannot resume its session.
- **Placement can lose the race.** A thread whose first turn starts before
  the plugin has moved its project runs that turn on the old account; if
  it fails, it is retried once on the new account.
- **Projects created while the plugin was disabled** count as new when it
  comes back, and move to the best account at their next thread unless
  they were pinned. Turning only `autoSwitch` off does not do this.
- **The install time is the first start of a version with placement.**
  After an update from 0.2.1, projects created before the first start of
  0.2.2 never count as new; the measured-block rule still applies to them.
- **A placement that loses the race to a turn that succeeds** moves the
  thread's next turns to the new account, which needs shared transcripts
  like any switch.
- **The personal project** ("Don't work in a project") is placed like any
  other, and is listed in Settings and by `list` and `release` so its
  variable can be seen and removed.
- **A hand-pinned project on an account out of the preferred model** is
  moved when a thread is created, even if that thread will run another
  model: bb does not tell the plugin a thread's model at creation. The
  turn's own model decides again when its first message is sent.
- **A project has one account, whatever its threads' models.** Two threads
  of a project sent with different models, when no single account can run
  both, move the project back and forth before each turn.
- **A placement before a turn that takes more than 3 s** is given up: the
  turn starts where the project was and, if it fails there, is judged like
  any failed turn. A write of the variable already on its way at that
  moment still lands: the turn starts on the old account and its failure
  there is retried on the new one.
- **Messages bb sends without its checkpoint** are neither placed nor
  remembered: a Send now of a queued message and an edited message sent
  again (bb 0.44). A turn started that way after the thread's model
  changed runs where the project is and, if it fails, is judged by the
  model the thread was last sent with through the checkpoint.
- **A message bb will hold for later** (scheduled, or waiting for an
  interaction or a host) is placed when bb asks, which is before it is
  sent, and again when it is sent.
- **With the checkpoint registered, bb asks the plugin before every
  message of every provider**, under its server-wide lock, and no longer
  takes its shortcut for draining queued messages. With `autoSwitch` off
  the handler answers at once.
- **An account picked by hand during the one read a placement before a
  turn makes** can be overwritten by the move: that placement runs outside
  the project's queue, which the checkpoint must never wait for.
- **The first turn of a new thread is placed twice**, by the preferred
  model when the thread is created and by its own model when its message
  is sent, in no fixed order. When the two disagree, the turn can start on
  an account that cannot run it, fail once and be judged by its model.
- **The retry of a leftover turn and the switch ahead of the limit do not
  look at a thread's model**: the first follows the project's latest move,
  the second decides by the preferred model. The placement before the next
  turn corrects both, at the cost of one more move.

## Measured in real use

On bb 0.44 with Claude Code 2.1.284, a turn that failed on a subscription
limit at 01:40:57 was switched to another account at 01:41:00, and the
retried turn completed there at 01:42:52.

## Decisions not taken

- **No account pooling.** The plugin never shares logins between people
  and never balances work across accounts: a project stays on its account
  until that account is blocked or, if the user set a percentage, close to
  its limit. A login happens only when the user asks for one, through
  Claude Code's own `claude auth login`.
- **No per-thread accounts.** The environment belongs to the project in bb;
  switching per thread would need a second mechanism and would split one
  project's sessions across directories.
- **No switching on a forecast.** By default the plugin moves a project
  only on a measured block (a failed turn, or an account already measured
  out before a new thread's first turn). The opt-in move ahead of the
  limit acts on a share measured at the end of a turn, against a
  percentage the user chose, and costs no retry. The forecast ("runs out
  in 2 d") is shown and never acted on: it is a guess.
- **No guessing on stale data.** When the only evidence that an account is
  free is the clock and the measurement is old, the plugin declines rather
  than switch.
