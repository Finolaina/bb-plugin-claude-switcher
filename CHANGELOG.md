# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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
  account; the pick still applies to the next turns. On bb 0.45 and later it shows
  only when Claude Code is the picked provider; bb 0.44 does not tell
  plugins which provider is picked, so there it shows for every provider.
  A project made a moment ago shows at once: a view that needs a project
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

[0.2.3]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.3
[0.2.2]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.2
[0.2.1]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.1
[0.2.0]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.0
[0.1.0]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.1.0
