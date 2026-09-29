# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [0.2.2] - 2026-09-29

### Added

- New projects start on the best account. When the first thread of a
  project created after the plugin was installed is opened, the project
  moves to the account the switch policy would choose (the preferred model
  included), instead of running its first turn on the default account.
- A project whose account is already measured unable to run (blocked, or
  out of the preferred model) moves to the best other account when a new
  thread is created, instead of failing the thread's first turn. A project
  pinned by hand stays put while its account works.

### Fixed

- A failed turn of a hidden thread, or of a thread another plugin opened
  (for example a summary worker), no longer moves the whole project to
  another account.
- After changing the accounts directory, `bb claude-switcher use` and the
  project picker accept the new directory's accounts at once, without a
  refresh first.

### Changed

- Development dependencies: plugin SDK 0.5.31, better-sqlite3 13, hono
  4.13.11.

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

[0.2.1]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.1
[0.2.0]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.2.0
[0.1.0]: https://github.com/Finolaina/bb-plugin-claude-switcher/releases/tag/v0.1.0
