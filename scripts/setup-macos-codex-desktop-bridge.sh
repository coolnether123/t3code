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

echo "Starting the managed Codex daemon with Remote Control enabled..."
"$codex_binary" remote-control start --json

echo
echo "The host bridge is ready. In T3 Code, open Settings > Providers > Codex"
echo "and enable 'Use Codex desktop bridge'. Leave Binary path as 'codex' so"
echo "T3 can auto-discover this app-bundled binary, or paste the path above."
