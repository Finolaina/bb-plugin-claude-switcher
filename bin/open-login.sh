#!/bin/sh
# Opens the Claude login page for a login started from bb (Claude Switcher).
# `claude auth login` runs this as $BROWSER with the consent URL as its only
# argument. macOS: a private Chrome window, so the login does not reuse the
# browser's Claude session (CLAUDE_SWITCHER_PRIVATE=0 opens the default
# browser instead); without Chrome, the default browser. Linux: xdg-open.
set -eu
url="${1:-}"
case "$url" in
  https://*) ;;
  *) echo "open-login: not an https URL" >&2; exit 1 ;;
esac
if [ "$(uname)" = "Darwin" ]; then
  if [ "${CLAUDE_SWITCHER_PRIVATE:-1}" = "1" ] \
    && /usr/bin/open -na "Google Chrome" --args --incognito "$url" 2>/dev/null; then
    exit 0
  fi
  exec /usr/bin/open "$url"
fi
exec xdg-open "$url"
