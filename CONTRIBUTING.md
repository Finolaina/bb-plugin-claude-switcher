# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Before you start

- For a bug, open an issue with the bb version, the plugin version, your
  platform and the relevant lines of `bb plugin logs claude-switcher`.
  Remove emails, account names and paths you do not want to share.
- For a larger change, open an issue first so we can agree on the approach.

## Development setup

You need Node.js 24, npm and the `bb` CLI (bb 0.44 or later).

```sh
git clone https://github.com/Finolaina/bb-plugin-claude-switcher.git
cd bb-plugin-claude-switcher
npm install
npm run check          # typecheck + lint + tests
npm run build          # bb plugin build → dist/
bb plugin install .    # load it into the running bb
bb plugin reload claude-switcher   # after each rebuild
```

## Project layout

| Path                 | What lives there                                                       |
| -------------------- | ---------------------------------------------------------------------- |
| `server.ts`          | Plugin entry: settings, usage source, thread and failure handlers, CLI, RPC. |
| `app.tsx`            | The **Claude Switcher** section in Settings.                           |
| `src/accounts.ts`    | Account discovery from the config directories.                         |
| `src/credentials.ts` | Reading and refreshing each login's OAuth token.                       |
| `src/usage.ts`       | Parsing the usage endpoint's response.                                 |
| `src/collector.ts`   | Background measurements and which accounts the policy may consider.    |
| `src/policy.ts`      | Account ranking: the pure choice rules.                                |
| `src/switch.ts`      | Switch, wait or decline for a failed turn; placement at thread creation. |
| `src/usage-source.ts` | Shapes each account for the Provider usage panel. |
| `src/usage-source-contract.ts` | The Provider usage panel's RPC contract, copied from bb. |
| `src/node-io.ts` | Real file system, keychain and network adapters. |
| `src/ui.ts` | Small pure helpers for the settings section. |
| `components/`, `lib/` | UI components used by `app.tsx`. |
| `dist/` | Build output, committed so CI can check it against the source; bb rebuilds it at install time. |

Tests live next to the code they cover (`*.test.ts`).

## Rules for a change

- **Tests first.** Add or change a test that fails without your change.
  The suite runs on `@get-bb/plugin-sdk/testing`'s fake host, so the
  whole plugin can be exercised without a real bb or real accounts.
- **Never use real data in tests or screenshots.** Use `example.com`
  emails and paths such as `/Users/someone/.claude-accounts/work`.
- **Keep `dist/` in sync.** Run `npm run build` and commit `dist/` with the
  source change. bb rebuilds it at install time; CI rebuilds it with the
  pinned bb version and fails when it differs, so the committed copy is
  always the build of the source (`dist/*.map` is not committed: it
  carries local paths).
- **All checks green:** `npm run check` and `bb plugin types --check`.
- Keep the README in step with the behavior, especially
  [The switch policy](README.md#the-switch-policy).

## Releases

Releases are git tags `vX.Y.Z` on `main`, with `package.json` at the same
version and an entry in [CHANGELOG.md](CHANGELOG.md). A published tag is
never moved: every fix is a new version, because bb refuses a tag that
changed.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
