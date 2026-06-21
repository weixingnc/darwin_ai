#!/usr/bin/env bash
# Darwin uninstaller (Linux + macOS).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/darwin/<branch>/uninstall.sh | bash
#   curl ... | bash -s -- --dir /opt/darwin
#
# Removes:
#   - The install dir (default: $HOME/.darwin)
#   - The symlink in $Bin (default: $HOME/.local/bin/darwin)
#   - The ~/.darwin/.env config file (only if owned by the same install)
#
# Does NOT remove:
#   - ~/.darwin/ memory / audit data -- use --purge for that
#   - Any plugin / skill the user manually installed elsewhere

set -euo pipefail

HOME_DIR="${DARWIN_HOME:-$HOME/.darwin}"
BIN_DIR="${DARWIN_BIN:-$HOME/.local/bin}"
PURGE=0
QUIET=0

usage() {
  cat <<'EOF'
Darwin uninstaller

Usage:
  uninstall.sh [options]

Options:
  --dir PATH      install dir to remove (default: $HOME/.darwin)
  --bin PATH      bin dir holding the symlink (default: $HOME/.local/bin)
  --purge         also remove ~/.darwin/ memory + audit data
  -q, --quiet     suppress non-error output
  -h, --help      show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) HOME_DIR="$2"; shift 2;;
    --bin) BIN_DIR="$2"; shift 2;;
    --purge) PURGE=1; shift;;
    -q|--quiet) QUIET=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "uninstall.sh: unknown option: $1" >&2; usage; exit 64;;
  esac
done

log() { [ "$QUIET" -eq 0 ] && echo "$@"; }
err() { echo "uninstall.sh: $*" >&2; }

# Safety: refuse to remove a path that does not look like our install.
# The marker is bin/darwin (the CLI entrypoint).
if [ ! -f "$HOME_DIR/bin/darwin" ]; then
  err "refusing to remove $HOME_DIR -- bin/darwin not found (not a darwin install?)"
  err "pass --dir to point at the right path, or remove manually:"
  err "  rm -rf $HOME_DIR"
  exit 74
fi

log "Removing darwin install at $HOME_DIR ..."
rm -rf "$HOME_DIR"

if [ -L "$BIN_DIR/darwin" ] || [ -f "$BIN_DIR/darwin" ]; then
  log "Removing $BIN_DIR/darwin ..."
  rm -f "$BIN_DIR/darwin" "$BIN_DIR/darwin-bin" 2>/dev/null || true
fi

# ~/.darwin/.env -- only if the user explicitly asks, since it
# may contain real API keys. Default behaviour: keep it (it
# lives next to the install but is harmless without the install).
if [ -f "$HOME/.darwin/.env" ]; then
  if [ "$PURGE" -eq 1 ]; then
    log "Removing ~/.darwin/.env (--purge)"
    rm -f "$HOME/.darwin/.env"
    rmdir "$HOME/.darwin" 2>/dev/null || true
  else
    log "Preserving ~/.darwin/.env (pass --purge to remove; contains your API keys)"
  fi
fi

# Memory + audit data lives in --dir by default. With --purge, blow
# it away (the install dir is already gone above).
if [ "$PURGE" -eq 1 ]; then
  log "Purged memory + audit (was inside the install dir)."
fi

log ""
log "Darwin uninstalled."
log "Open a new shell so the PATH change (if any) takes effect."
log ""