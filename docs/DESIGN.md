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
waits for the one that frees first.

## Pieces

| File                 | Role                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/accounts.ts`    | Discovery: `~/.claude` (no variable) plus every subdirectory of the accounts directory that holds a `.claude.json`.                                                     |
| `src/credentials.ts` | Reads each login from the macOS keychain or `<dir>/.credentials.json`, refreshes an expired token, writes it back and verifies the write, and calls the usage endpoint. |
| `src/usage.ts`       | Parses the usage endpoint's answer into session, weekly and per-model windows.                                                                                          |
| `src/collector.ts`   | One cached measurement per account, single-flight queries, the rule for stale measurements.                                                                             |
| `src/policy.ts`      | Pure ranking: which usable account to choose.                                                                                                                           |
| `src/switch.ts`      | Pure decisions: where a project runs before a new thread's first turn, and what to do with one failed turn (switch, wait or decline).                                   |
| `server.ts`          | Wires it to bb: settings, the Provider usage source, `thread.created`, `turn.failed`, project variables, retries, CLI, realtime updates.                                 |
| `app.tsx`            | The Claude Switcher section in Settings.                                                                                                                                |

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
   and it was never placed, kept, pinned in the picker or with `use`, or
   given a thread while `autoSwitch` was off (key `handled-projects`). A
   project that already carries a variable this plugin set is never new.
2. **A known project** moves only when its account is **measured** unable
   to run: a lock the provider reported, a window at 100 %, or the
   preferred model used up. A usage answer that lacks the session or the
   weekly window is unknown, not out, and moves nothing. A project pinned
   by hand stays put while its account works, even when another account
   ranks better.
3. **Nothing happens** for a hidden thread, a thread another plugin
   opened, a thread of another provider, a project whose
   `CLAUDE_CONFIG_DIR` the plugin did not set, or when no other account
   can run. If the project's account changes while the plugin decides (a
   pick in Settings), the plugin leaves it.

A move is recorded as the last switch and opens the same 60-second grace
window as a switch after a failure, so the project's threads still running
on the old account follow it. If the install time cannot be read or
stored, no project is moved for being new; the measured-block rule still
applies.

This check races the thread's first turn on purpose: holding the turn until
it finishes would need bb's experimental dispatch hook, which fails the
turn when a plugin is slow. When the turn starts first, it runs where the
project was; if it fails there, it is retried once on the new account (the
placing thread gets the grace retry too, because no failure caused the
move), and a second failure is judged as below.

## Deciding on a failed turn

`declineReason` runs first and is cheap, so another provider's limit never
queries every account. The plugin acts only when all of these hold:

- the attempt number is below 5 (`MAX_ATTEMPTS`, as provider-retry);
- the error category is `rate-limit`;
- the rate-limit state is `blocked`, its kind is `subscription-window`;
- the provider is `claude-code`.

It also leaves alone any project whose `CLAUDE_CONFIG_DIR` it did not set
(recognised by the note it writes next to the variable), and any failure of
a hidden thread or of a thread another plugin opened (the provider is
judged from the failure's own rate-limit report, not from the thread row): moving the whole
project for another plugin's worker would surprise the user, and the plugin
that owns the worker decides what to do with it.

Then `decideSwitch`:

1. **Settle.** Every window whose reset time has passed counts as free,
   whatever the last measurement said.
2. **Switch** if another account is usable under the policy. The project's
   variable moves to it (the default account means removing the variable)
   and the failed turn is retried at once.
3. **Wait** otherwise, for the account that can run the turn first. For
   the account that just failed, the provider's own reported reset wins
   over our measurement: it is blocked at least until then. Ties go to the
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

## Leftover threads: the 60-second grace window

When a project moves, its other threads that were already running on the
old account keep failing for a while. For 60 seconds after a switch or a
wait (`SWITCH_GRACE_MS`), a failure from another thread of that project is
not judged again: it is retried once as it is, on the new account, or
queued for the same reset after a wait. Once per thread: a second failure
of the same thread inside the window means the new account fails too, and
it is judged from scratch.

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

- **A refresh race can log an account out.** If a running `claude` session
  of the same account refreshes between the plugin's read and its write,
  or bb stops while a rotated login is only in memory, that account needs
  `/login` again.
- **Same machine only.** The variable is a local path set on the project's
  machine environment; a thread executed on another host does not see it.
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
- **A hand-pinned project on an account out of the preferred model** is
  moved when a thread is created, even if that thread will run another
  model: bb does not tell the plugin a thread's model at creation.

## Measured in real use

On bb 0.44 with Claude Code 2.1.284, a turn that failed on a subscription
limit at 01:40:57 was switched to another account at 01:41:00, and the
retried turn completed there at 01:42:52.

## Decisions not taken

- **No account pooling.** The plugin never spreads one person's work across
  accounts to multiply quota, never logs anyone in, and never shares logins
  between people. It only moves a project between logins its user already
  holds, when the current one is blocked.
- **No per-thread accounts.** The environment belongs to the project in bb;
  switching per thread would need a second mechanism and would split one
  project's sessions across directories.
- **No switching on a forecast.** The plugin moves a project on a measured
  block (a failed turn, or an account already measured out before a new
  thread's first turn), never on a forecast such as "80 % used": a forecast
  is a guess, and every guess costs a retry or a project the user placed.
- **No guessing on stale data.** When the only evidence that an account is
  free is the clock and the measurement is old, the plugin declines rather
  than switch.
