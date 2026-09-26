#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This setup is only supported on macOS." >&2
  exit 1
fi

codex_binary=""
for candidate in \
  "/Applications/Codex.app/Contents/Resources/codex" \
  "$HOME/Applications/Codex.app/Contents/Resources/codex" \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/codex"
do
  if [ -x "$candidate" ]; then
    codex_binary="$candidate"
    break
  fi
done

if [ -z "$codex_binary" ]; then
  echo "Install and sign in to the Codex desktop app before running this setup." >&2
  exit 1
fi

echo "Using $codex_binary"
"$codex_binary" --version

if [ -d "/Applications/Codex.app" ] || [ -d "$HOME/Applications/Codex.app" ]; then
  open -a Codex
else
  open -a ChatGPT
fi

codex_home="${CODEX_HOME:-$HOME/.codex}"
managed_package="$codex_home/packages/standalone/current"
managed_codex=""
package_manifest="$managed_package/codex-package.json"
if [ -f "$package_manifest" ]; then
  managed_entrypoint=$(sed -n 's/^[[:space:]]*"entrypoint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package_manifest" | sed -n '1p')
  if [ -n "$managed_entrypoint" ]; then
    managed_codex="$managed_package/$managed_entrypoint"
  fi
fi

legacy_managed_codex="$managed_package/codex"
if [ ! -x "$managed_codex" ] && [ -x "$legacy_managed_codex" ]; then
  managed_codex="$legacy_managed_codex"
fi

if [ ! -x "$managed_codex" ]; then
  echo >&2
  echo "The desktop app was found, but its bundled CLI cannot bootstrap the managed daemon." >&2
  echo "Install the standalone Codex CLI from the official instructions:" >&2
  echo "https://developers.openai.com/codex/cli/" >&2
  echo "Then rerun this script. Expected managed CLI under: $managed_package" >&2
  exit 1
fi

echo "Using managed Codex CLI at $managed_codex"

echo "Bootstrapping the managed Codex app-server daemon..."
# Bootstrap rewrites the daemon settings, so carry the user's Remote Control choice forward.
remote_control_flag=""
daemon_settings="$codex_home/app-server-daemon/settings.json"
if [ -f "$daemon_settings" ] && grep -Eq '"remoteControlEnabled"[[:space:]]*:[[:space:]]*true' "$daemon_settings"; then
  remote_control_flag="--remote-control"
fi
# shellcheck disable=SC2086
"$managed_codex" app-server daemon bootstrap $remote_control_flag

echo "Checking the managed Codex app-server daemon..."
if ! daemon_version_output=$("$managed_codex" app-server daemon version 2>&1); then
  printf '%s\n' "$daemon_version_output" >&2
  echo "The managed daemon did not answer. Run this setup again, then check daemon version." >&2
  exit 1
fi
printf '%s\n' "$daemon_version_output"
if ! printf '%s\n' "$daemon_version_output" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"running"'; then
  echo "The managed daemon did not report status \"running\". Run daemon bootstrap again, then check daemon version." >&2
  exit 1
fi

echo
echo "The host bridge is ready. In T3 Code, open Settings > Providers > Codex"
echo "and enable 'Use Codex desktop app'. Leave Binary path as 'codex' so"
echo "T3 can auto-discover this app-bundled binary, or paste the path above."
