Run Claude Code in bb with more than one subscription and spend less time
watching the limits. This plugin treats `~/.claude` and every subdirectory
of your accounts directory that holds a Claude Code login as an account,
measures each one, starts new projects on the best one, and moves a
project to another account the moment a turn fails on a subscription
limit.

## What you get

- **Every account in Provider usage.** The 5-hour session, the weekly and
  the per-model weekly windows of each account, next to the usage bb already
  shows. Refreshed every few minutes and on demand.
- **Automatic switching.** When a turn fails with a subscription-window rate
  limit, the plugin picks the best other account and retries the turn at
  once. When no account is free, it moves the project to the account that
  frees first and queues the retry for that reset (up to a wait you set).
- **A good start for new projects.** When a thread is created, a project
  created after the plugin first ran moves to the best account instead
  of the default one, and a project whose account is already out moves to
  another. If the thread's first turn wins the race and fails on the old
  account, it is retried once on the new one.
- **The account in every thread.** A Claude Code thread's header shows
  the project's account with a coloured dot for how much it has left, and
  a menu to switch now to the best account or to any other.
- **Switch ahead of the limit, if you want.** Set a percentage and, when
  a turn ends with the project's account at or above it, the project moves
  to an account below it before the next turn fails. Off by default;
  needs the automatic choice on.
- **A forecast per window.** When each weekly window runs out at the pace
  you have used it, or that it lasts until its reset.
- **Add an account from bb.** Type a name in Settings: the plugin creates
  the directory, shares your transcripts and configuration with it and
  runs Claude Code's own login, in a private Chrome window on macOS.
- **A history of moves.** Every move of a project, automatic or by hand,
  with its reason.
- **A picker per project.** In Settings, choose which account each project
  runs with, or let the plugin manage it. The CLI does the same:
  `bb claude-switcher use PROJECT ACCOUNT`.

## How the choice is made

The three Claude Code limits are not interchangeable, so an account is only a
candidate while its session and its weekly window are both under 100 % and
the provider reports no lock. Candidates are ordered by the closest weekly
reset, then by the lowest session use. If you name a preferred model, only
accounts that can still run it are chosen; when none can, the retry waits for
the first moment an account can run that model again. A thread you switch to
another model in bb's picker is judged by that model instead.

## Requirements

bb 0.44 or later, running on the machine that holds your Claude Code logins
(macOS keychain, or the credentials file on Linux). The switch is a project
machine environment variable, so threads that run on another host do not
follow it. Each account directory must share the session transcripts
(`projects/`, symlinked from `~/.claude`) and normally the settings, hooks
and `CLAUDE.md` too, or a thread cannot continue on the new account; the
[README](https://github.com/Finolaina/bb-plugin-claude-switcher#setting-up-extra-accounts)
shows the setup.

## How it works

One account = one `CLAUDE_CONFIG_DIR`. The plugin reads each directory's
login from the same place Claude Code keeps it (the macOS keychain, or the
credentials file elsewhere), queries the usage endpoint Claude Code itself
uses, and sets `CLAUDE_CONFIG_DIR` as a project machine environment variable
when it switches. Tokens are sent only to Anthropic's own OAuth and usage
endpoints, the same ones the Claude Code CLI calls; nothing is sent
anywhere else.

Add each extra account from **Settings → Claude Switcher → Add account**,
or by hand: make the directory once (share `projects/` and the rest first,
as the README shows), then `CLAUDE_CONFIG_DIR=~/.claude-accounts/work claude`
and log in; the plugin finds it on the next refresh.

## Privacy and terms

No telemetry and no third-party services: tokens go only to Anthropic's own
OAuth and usage endpoints, the ones the Claude Code CLI calls. The plugin
also refreshes an expired token itself, with Claude Code's public OAuth
client id, and writes it back where the CLI keeps it, even when automatic
switching is off. Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
says OAuth logins are for ordinary use of Claude Code and that developers
may not collect, store or intermediate Claude.ai credentials or session
tokens, so Anthropic could regard this plugin as outside its terms. It is
an independent, MIT-licensed project, not affiliated with Anthropic; use it
at your own risk.
Full details, setup and troubleshooting are in the
[README](https://github.com/Finolaina/bb-plugin-claude-switcher#readme).
