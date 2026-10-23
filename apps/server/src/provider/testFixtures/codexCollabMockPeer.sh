#!/usr/bin/env bash
# Wrapper so the Codex provider probe can spawn the mock peer: it always
# passes "app-server" as the first argument (real codex CLI subcommand);
# discard it and exec node on the .mjs peer.
if [ "$1" = "--version" ]; then
  printf 'codex 0.0.0\n'
  exit 0
fi
shift
exec node "$(dirname "$0")/codexCollabMockPeer.mjs" "$@"
