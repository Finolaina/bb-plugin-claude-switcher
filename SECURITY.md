# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private reporting instead: **Security → Report a vulnerability** on
[this repository](https://github.com/Finolaina/bb-plugin-claude-switcher/security/advisories/new).

Include the plugin and bb versions, your platform, and the steps to
reproduce. Never include real tokens, credentials files or keychain
contents.

## What the plugin touches

- It reads the OAuth token Claude Code stored for each login on the
  machine (macOS keychain or `<dir>/.credentials.json`) and, when a token
  has expired, refreshes it with Claude Code's public OAuth client id and
  writes the rotated token back to the same place.
- It sends tokens only to Anthropic's own OAuth and usage endpoints, the
  same ones the Claude Code CLI calls.
- It writes `CLAUDE_CONFIG_DIR` (and removes it again on `release`) as a
  project machine environment variable in bb. Outside bb's own storage,
  the only other thing it writes is the refreshed login, back to the
  keychain item or `<dir>/.credentials.json` it was read from. On macOS
  that goes through `/usr/bin/security`, which receives the login on its
  command line, as Claude Code's own write does; on Linux through a
  temporary file with mode 0600 renamed over the original.
- It has no telemetry and calls no third-party service.
