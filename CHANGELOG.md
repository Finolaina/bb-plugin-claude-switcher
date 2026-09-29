# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/Finolaina/bb-plugin-claude-accounts/releases/tag/v0.1.0
