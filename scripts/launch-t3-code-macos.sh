#!/bin/bash
# Safe macOS deployment for the packaged T3 Code app.
# Dry-run, prepare-only, and build-only never stop processes or touch live data.
set -euo pipefail
IFS=$'\n\t'
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_ROOT="$ROOT"; APP_PATH="/Applications/T3 Code (Alpha).app"
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
APP_SUPPORT_PATH="${T3CODE_APP_SUPPORT:-$HOME/Library/Application Support/t3code}"
BACKUP_ROOT=""; ARTIFACT_DIR=""; EXPECTED_BRANCH="${T3CODE_EXPECTED_BRANCH:-feat/t3-workers-prototype}"
EXPECTED_COMMIT="${T3CODE_EXPECTED_COMMIT:-}"; SERVER_PORT="${T3CODE_PORT:-3773}"
ARCH="${T3CODE_DESKTOP_ARCH:-}"; WAIT_SECONDS=120
DRY_RUN=0; PREPARE_ONLY=0; BUILD_ONLY=0; SKIP_BUILD=0
RUN_ID=""; RUN_DIR=""; LOG_PATH=/dev/null; STATE_PATH=""; STAGED_APP=""; PREVIOUS_APP=""
VP_PATH=""; declare -a OWNED_PIDS=()

usage() {
  cat <<'HELP'

Usage: launch-t3-code-macos.sh --expected-commit <full-sha> --backup-root <dir> [options]
  --dry-run                 Validate/print only; no writes, builds, or process stops.
  --prepare-only            Locked install, checks, and build; no app install.
  --build-only              Prepare and package macOS artifact; no app install/launch.
  --source-root <dir>       Source checkout (default: this repository).
  --expected-branch <name>  Exact branch (default: feat/t3-workers-prototype).
  --expected-commit <sha>   Required exact 40-character source commit.
  --backup-root <dir>       Explicit backup root (required for deployment).
  --app-path <path>         Installed app (default: /Applications/T3 Code (Alpha).app).
  --t3-home <dir>           T3 home to preserve (default: ~/.t3).
  --app-support <dir>       Electron support data to preserve.
  --artifact-dir <dir>      Artifact output (default: unique directory under /tmp).
  --arch <arm64|x64>        Package architecture (default: host architecture).
  --port <number>           Server loopback port (default: 3773).
  --wait-seconds <15..600>  Health timeout (default: 120).
  --skip-build              Use existing desktop/server bundles.
  --help                    Show this help.
No launchd, Tailscale, service definitions, T3 home, database, attachments, or
Electron support data are changed by this workflow.
HELP
}
fail() { printf 'launch-t3-code-macos.sh: %s\n' "$*" >&2; exit 1; }
plan() { [[ "$DRY_RUN" -eq 1 ]] && printf 'PLAN %s\n' "$*" || printf '%s\n' "$*"; }
need() { [[ -n "${2:-}" ]] || fail "$1 requires a value"; printf '%s' "$2"; }

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;; --prepare-only) PREPARE_ONLY=1; shift;;
    --build-only) BUILD_ONLY=1; shift;; --skip-build) SKIP_BUILD=1; shift;;
    --source-root) SOURCE_ROOT="$(need "$1" "${2:-}")"; shift 2;;
    --expected-branch) EXPECTED_BRANCH="$(need "$1" "${2:-}")"; shift 2;;
    --expected-commit) EXPECTED_COMMIT="$(need "$1" "${2:-}")"; shift 2;;
    --backup-root) BACKUP_ROOT="$(need "$1" "${2:-}")"; shift 2;;
    --app-path) APP_PATH="$(need "$1" "${2:-}")"; shift 2;;
    --t3-home) T3_HOME="$(need "$1" "${2:-}")"; shift 2;;
    --app-support) APP_SUPPORT_PATH="$(need "$1" "${2:-}")"; shift 2;;
    --artifact-dir) ARTIFACT_DIR="$(need "$1" "${2:-}")"; shift 2;;
    --arch) ARCH="$(need "$1" "${2:-}")"; shift 2;;
    --port) SERVER_PORT="$(need "$1" "${2:-}")"; shift 2;;
    --wait-seconds) WAIT_SECONDS="$(need "$1" "${2:-}")"; shift 2;;
    --help|-h) usage; exit 0;; *) fail "unknown option: $1 (use --help)";;
  esac
done
[[ "$(uname -s)" == Darwin ]] || fail "this workflow only runs on macOS"
[[ "$PREPARE_ONLY" -eq 0 || "$BUILD_ONLY" -eq 0 ]] || fail "choose one of --prepare-only/--build-only"
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--expected-commit must be an exact 40-character SHA"
[[ "$SERVER_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( SERVER_PORT <= 65535 )) || fail "invalid --port"
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] && (( WAIT_SECONDS >= 15 && WAIT_SECONDS <= 600 )) || fail "invalid --wait-seconds"
if [[ -z "$ARCH" ]]; then case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) fail "pass --arch";; esac; fi
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || fail "--arch must be arm64 or x64"

abs() { [[ "$1" == /* ]] && printf '%s' "$1" || printf '%s/%s' "$PWD" "$1"; }
SOURCE_ROOT="$(abs "$SOURCE_ROOT")"; APP_PATH="$(abs "$APP_PATH")"; T3_HOME="$(abs "$T3_HOME")"; APP_SUPPORT_PATH="$(abs "$APP_SUPPORT_PATH")"
[[ -z "$BACKUP_ROOT" ]] || BACKUP_ROOT="$(abs "$BACKUP_ROOT")"; [[ -z "$ARTIFACT_DIR" ]] || ARTIFACT_DIR="$(abs "$ARTIFACT_DIR")"
broad() { case "$1" in ""|/|/Users|/Applications|/Library|/System|/tmp|"$HOME") fail "$2 is an unsafe broad path: $1";; esac; }
real_dir() { [[ -d "$1" && ! -L "$1" ]] || fail "$2 is not a real directory: $1"; }
real_file() { [[ -f "$1" && ! -L "$1" ]] || fail "$2 is not a real file: $1"; }
same_or_below() { [[ "$1" == "$2" || "$1" == "$2/"* ]]; }
git_text() { git -C "$SOURCE_ROOT" "$@" 2>/dev/null || fail "git $* failed"; }

validate() {
  real_dir "$SOURCE_ROOT" "source checkout"; broad "$SOURCE_ROOT" "source checkout"
  real_file "$SOURCE_ROOT/package.json" "package manifest"; real_file "$SOURCE_ROOT/pnpm-lock.yaml" "lockfile"
  real_file "$SOURCE_ROOT/pnpm-workspace.yaml" "workspace manifest"; real_file "$SOURCE_ROOT/scripts/build-desktop-artifact.ts" "artifact builder"
  local git_root; git_root="$(git_text rev-parse --show-toplevel)"
  [[ "$(cd "$git_root" && pwd -P)" == "$SOURCE_ROOT" ]] || fail "source is not Git root"
  [[ "$(git_text branch --show-current)" == "$EXPECTED_BRANCH" ]] || fail "source branch is not $EXPECTED_BRANCH"
  local actual al el; actual="$(git_text rev-parse HEAD)"; al="$(printf '%s' "$actual"|tr A-Z a-z)"; el="$(printf '%s' "$EXPECTED_COMMIT"|tr A-Z a-z)"
  [[ "$al" == "$el" ]] || fail "source commit is $actual, expected $EXPECTED_COMMIT"
  [[ -z "$(git -C "$SOURCE_ROOT" status --porcelain --untracked-files=normal)" ]] || fail "source checkout has uncommitted changes"
  broad "$APP_PATH" "installed app path"; [[ "$APP_PATH" == *.app && "$(dirname "$APP_PATH")" == /Applications ]] || fail "app must be directly under /Applications"
  broad "$T3_HOME" "T3 home"; broad "$APP_SUPPORT_PATH" "Electron support path"
  if [[ "$PREPARE_ONLY" -eq 0 && "$BUILD_ONLY" -eq 0 ]]; then
    [[ -n "$BACKUP_ROOT" ]] || fail "deployment requires explicit --backup-root"; broad "$BACKUP_ROOT" "backup root"
    same_or_below "$BACKUP_ROOT" "$APP_PATH" && fail "backup root is inside app path"
    same_or_below "$BACKUP_ROOT" "$T3_HOME" && fail "backup root is inside T3 home"
    same_or_below "$BACKUP_ROOT" "$APP_SUPPORT_PATH" && fail "backup root is inside Electron support path"
    same_or_below "$T3_HOME" "$BACKUP_ROOT" && fail "T3 home is inside backup root"
    same_or_below "$APP_SUPPORT_PATH" "$BACKUP_ROOT" && fail "Electron support path is inside backup root"
    [[ "$BACKUP_ROOT" != /Applications/* ]] || fail "backup root must not be under /Applications"
    [[ "$BACKUP_ROOT" != "$SOURCE_ROOT" && "$SOURCE_ROOT" != "$BACKUP_ROOT/"* ]] || fail "backup root is source checkout"
  fi
}

vp_run() {
  local label="$1"; shift; plan "RUN $label: (cd $SOURCE_ROOT && vp $*)"
  [[ "$DRY_RUN" -eq 1 ]] && return
  (cd "$SOURCE_ROOT" && "$VP_PATH" "$@") >>"$LOG_PATH" 2>&1 || fail "$label failed; see $LOG_PATH"
}
prepare() {
  [[ "$SKIP_BUILD" -eq 1 ]] && { plan "Skipping locked install/check/build (--skip-build)."; return; }
  vp_run "frozen dependency install" install --frozen-lockfile
  vp_run "workspace typecheck" run typecheck; vp_run "repository checks" check; vp_run "desktop/server build" run build:desktop
}
dirs() {
  RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$$"; [[ -n "$ARTIFACT_DIR" ]] || ARTIFACT_DIR="${TMPDIR:-/tmp}/t3code-macos-artifacts-$RUN_ID"
  [[ -n "$BACKUP_ROOT" ]] || BACKUP_ROOT="${TMPDIR:-/tmp}/t3code-macos-backups"
  RUN_DIR="$BACKUP_ROOT/$RUN_ID"; STATE_PATH="$BACKUP_ROOT/.t3code-macos-deployment-state"; LOG_PATH="$RUN_DIR/deployment.log"
  [[ "$DRY_RUN" -eq 1 ]] && { plan "Would create $ARTIFACT_DIR and backup $RUN_DIR"; return; }
  broad "$ARTIFACT_DIR" "artifact directory"; broad "$BACKUP_ROOT" "backup root"
  [[ ! -e "$ARTIFACT_DIR" ]] || fail "artifact directory already exists; pass a fresh --artifact-dir"
  [[ ! -L "$ARTIFACT_DIR" && ! -L "$BACKUP_ROOT" ]] || fail "artifact or backup root is a symlink"
  mkdir -p "$ARTIFACT_DIR" "$RUN_DIR"
  [[ ! -L "$ARTIFACT_DIR" && ! -L "$BACKUP_ROOT" ]] || fail "artifact or backup root is a symlink"
  : >"$LOG_PATH"; chmod 600 "$LOG_PATH"
}

bundle_exec() {
  local app="$1" plist="$1/Contents/Info.plist" name; real_file "$plist" "Info.plist"
  name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist" 2>/dev/null || true)"; [[ -n "$name" ]] || fail "CFBundleExecutable missing"
  real_file "$app/Contents/MacOS/$name" "app executable"; [[ -x "$app/Contents/MacOS/$name" ]] || fail "app executable is not executable"
  printf '%s' "$app/Contents/MacOS/$name"
}
validate_app() {
  local app="$1"; local require_hash="${2:-0}"; real_dir "$app" "T3 app bundle"; [[ "$app" == *.app ]] || fail "not an app bundle"
  local exe; exe="$(bundle_exec "$app")"; real_file "$app/Contents/Resources/app.asar" "app archive"
  if [[ "$require_hash" -eq 1 ]]; then strings "$app/Contents/Resources/app.asar" | grep -Fq "$EXPECTED_COMMIT" || fail "app.asar lacks expected source commit"; fi
  printf '%s' "$exe"
}
roots() {
  local exe="$1" row pid command
  ps -axo pid=,command= | while IFS= read -r row; do
    pid="${row%% *}"; command="${row#"$pid"}"; command="${command#"${command%%[![:space:]]*}"}"; [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$command" in "$exe"|"$exe "*)
      [[ "$command" == *" --type="* || "$command" == *" --process-type="* || "$command" == *"apps/server/dist"* || "$command" == *"--bootstrap-fd"* ]] || printf '%s\n' "$pid";; esac
  done
}
root() { local p candidate="" count=0; while read -r p; do [[ -z "$p" ]] || { candidate="$p"; count=$((count + 1)); }; done < <(roots "$1"); [[ "$count" -le 1 ]] || fail "found $count exact T3 app roots; refusing to choose one"; printf '%s' "$candidate"; }
alive() { kill -0 "$1" 2>/dev/null; }
in_owned() { local n="$1" p; for p in "${OWNED_PIDS[@]}"; do [[ "$p" == "$n" ]] && return; done; return 1; }
capture_tree() {
  local r="$1" changed=1 pid ppid; OWNED_PIDS=("$r")
  while [[ "$changed" -eq 1 ]]; do
    changed=0; while IFS=' ' read -r pid ppid; do
      [[ "$pid" =~ ^[0-9]+$ && "$ppid" =~ ^[0-9]+$ ]] || continue
      if in_owned "$ppid" && ! in_owned "$pid"; then OWNED_PIDS+=("$pid"); changed=1; fi
    done < <(ps -axo pid=,ppid=)
  done
}
listeners() { lsof -nP -t -iTCP:"$SERVER_PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true; }
check_listeners() { local p; while read -r p; do [[ -z "$p" ]] || in_owned "$p" || fail "port $SERVER_PORT held by unrelated PID $p"; done < <(listeners); }
stop_tree() {
  local p i live; [[ "${#OWNED_PIDS[@]}" -gt 0 ]] || return; plan "Stopping captured T3 PID ${OWNED_PIDS[0]} and its descendants."
  [[ "$DRY_RUN" -eq 1 ]] && return; kill -TERM "${OWNED_PIDS[0]}" 2>/dev/null || true
  for i in {1..10}; do live=0; for p in "${OWNED_PIDS[@]}"; do alive "$p" && live=1; done; [[ "$live" -eq 0 ]] && return; sleep 1; done
  for (( i=${#OWNED_PIDS[@]}-1; i>=0; i-- )); do p="${OWNED_PIDS[i]}"; alive "$p" && kill -KILL "$p" 2>/dev/null || true; done
  sleep 1; for p in "${OWNED_PIDS[@]}"; do alive "$p" && fail "captured PID $p did not stop"; done
}
stop_existing() {
  local exe="$1" r p; r="$(root "$exe")"
  if [[ -z "$r" ]]; then while read -r p; do [[ -z "$p" ]] || fail "port $SERVER_PORT has no exact T3 owner (PID $p)"; done < <(listeners); OWNED_PIDS=(); return; fi
  capture_tree "$r"; check_listeners; stop_tree; [[ -z "$(root "$exe")" ]] || fail "exact app root remains"; while read -r p; do [[ -z "$p" ]] || fail "port remains occupied by PID $p"; done < <(listeners)
}
backup() {
  real_dir "$T3_HOME" "T3 home"; real_dir "$T3_HOME/userdata" "T3 userdata"; plan "Backing up T3 home to $RUN_DIR/t3-home; live data stays in place."
  ditto "$T3_HOME" "$RUN_DIR/t3-home" >>"$LOG_PATH" 2>&1 || fail "T3 home backup failed"
  local db="$T3_HOME/userdata/state.sqlite" out="$RUN_DIR/t3-home/userdata/state.sqlite" snap="$RUN_DIR/t3-home/userdata/state.sqlite.consistent" sql
  real_file "$db" "live SQLite database"; command -v sqlite3 >/dev/null || fail "sqlite3 is required"; sql="$(printf '%s' "$snap"|sed "s/'/''/g")"
  sqlite3 -readonly "$db" "PRAGMA busy_timeout=5000; VACUUM INTO '$sql';" >>"$LOG_PATH" 2>&1 || fail "consistent SQLite backup failed"
  [[ -f "$snap" ]] || fail "SQLite snapshot was not created"; mv "$snap" "$out"; rm -f "$out-wal" "$out-shm"
  [[ "$(sqlite3 -readonly "$out" 'PRAGMA integrity_check;' 2>>"$LOG_PATH")" == ok ]] || fail "backup SQLite integrity_check failed"
  if [[ -d "$APP_SUPPORT_PATH" ]]; then plan "Backing up Electron support data to $RUN_DIR/application-support; live data stays in place."; ditto "$APP_SUPPORT_PATH" "$RUN_DIR/application-support" >>"$LOG_PATH" 2>&1 || fail "Electron support backup failed"; fi
}
backup_app() {
  [[ -d "$APP_PATH" && ! -L "$APP_PATH" ]] || fail "installed app is absent or a symlink"; mkdir -p "$RUN_DIR/installed-app"
  plan "Backing up installed app to $RUN_DIR/installed-app"; ditto "$APP_PATH" "$RUN_DIR/installed-app/$(basename "$APP_PATH")" >>"$LOG_PATH" 2>&1 || fail "app backup failed"
  shasum -a 256 "$APP_PATH/Contents/Resources/app.asar" >"$RUN_DIR/installed-app/app.asar.sha256" || fail "app checksum failed"
}
write_state() {
  local phase="$1" tmp="$STATE_PATH.tmp.$$"; printf 'phase=%s\napp_path=%s\nstaged_app=%s\nprevious_app=%s\nrun_dir=%s\n' "$phase" "$APP_PATH" "$STAGED_APP" "$PREVIOUS_APP" "$RUN_DIR" >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$STATE_PATH"; sync
}
state_value() { awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$STATE_PATH"; }
recover() {
  [[ -f "$STATE_PATH" ]] || return; [[ "$DRY_RUN" -eq 0 ]] || { plan "Would recover $STATE_PATH"; return; }
  local a s p r phase exe rt; a="$(state_value app_path)"; s="$(state_value staged_app)"; p="$(state_value previous_app)"; r="$(state_value run_dir)"; phase="$(state_value phase)"
  [[ "$a" == "$APP_PATH" && "$s" == "$APP_PATH.new."* && "$p" == "$APP_PATH.previous."* && "$r" == "$BACKUP_ROOT/"* ]] || fail "deployment state is not for this exact app/backup"
  real_dir "$r" "deployment backup run directory"
  if [[ -d "$APP_PATH" ]]; then exe="$(bundle_exec "$APP_PATH")"; else exe="$(bundle_exec "$p")"; fi
  rt="$(root "$exe")"; if [[ -n "$rt" ]]; then capture_tree "$rt"; check_listeners; stop_tree; fi
  case "$phase" in
    ready-to-swap) if [[ ! -d "$APP_PATH" ]]; then [[ -d "$p" ]] || fail "target and previous app are missing"; mv "$p" "$APP_PATH"; fi;;
    old-moved|new-installed)
      if [[ -d "$APP_PATH" ]]; then mv "$APP_PATH" "$r/recovery-failed-$(basename "$APP_PATH")"; fi
      [[ -d "$p" ]] || fail "previous app missing"; mv "$p" "$APP_PATH";;
    rolled-back) [[ -d "$APP_PATH" ]] || { [[ -d "$p" ]] || fail "previous app missing"; mv "$p" "$APP_PATH"; };;
    *) fail "unknown deployment phase $phase";; esac
  rm -f "$STATE_PATH"; plan "Recovered interrupted swap; previous app restored and live data untouched."
}
extract_app() {
  local z="" p n=0 app="" apps=0; while read -r p; do [[ -z "$p" ]] || { z="$p"; n=$((n+1)); }; done < <(find "$ARTIFACT_DIR" -maxdepth 1 -type f -name '*.zip' -print)
  [[ "$n" -eq 1 ]] || fail "expected one artifact ZIP; found $n"; local x="$ARTIFACT_DIR/extracted"; mkdir -p "$x"; ditto -x -k "$z" "$x" >>"$LOG_PATH" 2>&1 || fail "artifact extraction failed"
  while read -r p; do [[ -z "$p" ]] || { app="$p"; apps=$((apps+1)); }; done < <(find "$x" -type d -name '*.app' -prune -print)
  [[ "$apps" -eq 1 ]] || fail "expected one app in ZIP; found $apps"; STAGED_APP="$app"; validate_app "$STAGED_APP" 1 >/dev/null
}
package_app() {
  if [[ "$DRY_RUN" -eq 1 ]]; then plan "Would create artifact directory $ARTIFACT_DIR"; vp_run "macOS DMG/ZIP packaging" run dist:desktop:artifact --platform mac --target dmg --arch "$ARCH" --output-dir "$ARTIFACT_DIR" --skip-build; return; fi
  mkdir -p "$ARTIFACT_DIR"; vp_run "macOS DMG/ZIP packaging" run dist:desktop:artifact --platform mac --target dmg --arch "$ARCH" --output-dir "$ARTIFACT_DIR" --skip-build; extract_app
}
launch_verify() {
  local exe root_pid i log; exe="$(validate_app "$APP_PATH")"; log="$RUN_DIR/runtime-$(date -u +%Y%m%d-%H%M%S).log"; plan "Launching $exe with T3CODE_HOME=$T3_HOME and T3CODE_PORT=$SERVER_PORT."
  [[ "$DRY_RUN" -eq 1 ]] && return; T3CODE_HOME="$T3_HOME" T3CODE_PORT="$SERVER_PORT" "$exe" >>"$log" 2>&1 & local started="$!"
  for ((i=0; i<WAIT_SECONDS; i++)); do if ! alive "$started"; then printf 'app exited during startup; see %s\n' "$log" >&2; return 1; fi; root_pid="$(root "$exe")"
    if [[ -n "$root_pid" ]]; then capture_tree "$root_pid"; check_listeners; if curl --fail --silent --max-time 5 "http://127.0.0.1:$SERVER_PORT/.well-known/t3/environment" >/dev/null 2>>"$log" && curl --fail --silent --max-time 5 "http://127.0.0.1:$SERVER_PORT/api/auth/session" >/dev/null 2>>"$log"; then check_listeners; printf 'health passed: PID %s, environment/session APIs on 127.0.0.1:%s\n' "$root_pid" "$SERVER_PORT"; return; fi; fi
    sleep 1
  done; printf 'app did not pass API health within %s seconds; see %s\n' "$WAIT_SECONDS" "$log" >&2; return 1
}
rollback() {
  local exe rt failed; exe="$(bundle_exec "$APP_PATH")"; rt="$(root "$exe")"; if [[ -n "$rt" ]]; then capture_tree "$rt"; check_listeners; stop_tree; fi
  failed="$RUN_DIR/failed-candidate-$(basename "$APP_PATH")"; [[ ! -e "$failed" ]] || fail "rollback destination exists"; [[ -d "$APP_PATH" ]] && mv "$APP_PATH" "$failed"; [[ -d "$PREVIOUS_APP" ]] || fail "previous app unavailable"; mv "$PREVIOUS_APP" "$APP_PATH"; write_state rolled-back; rm -f "$STATE_PATH"; launch_verify || fail "rollback health verification failed"; printf 'rollback passed; failed candidate retained at %s\n' "$failed"
}
deploy() {
  [[ -d "$APP_PATH" ]] || fail "installed app missing; refusing deployment"; local old new
  old="$(validate_app "$APP_PATH")"; backup_app; backup; stop_existing "$old"; PREVIOUS_APP="$(dirname "$APP_PATH")/.T3 Code (Alpha).app.previous.$RUN_ID"; new="$(dirname "$APP_PATH")/.T3 Code (Alpha).app.new.$RUN_ID"
  [[ ! -e "$PREVIOUS_APP" && ! -e "$new" ]] || fail "app staging path exists"; ditto "$STAGED_APP" "$new" >>"$LOG_PATH" 2>&1 || fail "candidate staging copy failed"; validate_app "$new" 1 >/dev/null; STAGED_APP="$new"; write_state ready-to-swap
  mv "$APP_PATH" "$PREVIOUS_APP"; write_state old-moved; mv "$STAGED_APP" "$APP_PATH"; write_state new-installed
  if ! launch_verify; then printf 'new app health failed; rolling back\n' >&2; rollback; fail "deployment rolled back"; fi
  rm -f "$STATE_PATH"; printf 'deployment ready: %s\nbackup: %s\nprevious app retained: %s\n' "$APP_PATH" "$RUN_DIR" "$PREVIOUS_APP"
}
main() {
  validate; if [[ "$DRY_RUN" -eq 0 ]]; then command -v vp >/dev/null || fail "vp is required"; VP_PATH="$(command -v vp)"; else VP_PATH=vp; fi
  dirs; [[ "$DRY_RUN" -eq 0 && "$PREPARE_ONLY" -eq 0 && "$BUILD_ONLY" -eq 0 ]] && recover; prepare
  [[ "$PREPARE_ONLY" -eq 1 ]] && { printf 'prepared: app and live data unchanged\n'; return; }; package_app
  [[ "$BUILD_ONLY" -eq 1 ]] && { printf 'built: macOS %s artifact in %s; app and live data unchanged\n' "$ARCH" "$ARTIFACT_DIR"; return; }
  [[ "$DRY_RUN" -eq 1 ]] && { printf 'dry run complete: no files, processes, app/data, launchd, or Tailscale state changed\n'; return; }; deploy
}
main "$@"
