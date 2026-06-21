#!/usr/bin/env bash
# Darwin one-click installer (Linux + macOS).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/darwin/<branch>/install.sh | bash
#   curl ... | bash -s -- --branch dev
#   curl ... | bash -s -- --dir /opt/darwin
#
# Environment overrides:
#   DARWIN_REPO     git URL to clone (default: https://github.com/weixing/darwin.git)
#   DARWIN_BRANCH   git branch/tag to checkout (default: main)
#   DARWIN_HOME     install directory (default: $HOME/.darwin)
#   DARWIN_BIN      bin directory for the `darwin` symlink (default: $HOME/.local/bin)
#   DARWIN_VERSION  pinned version (overrides --branch; e.g. v0.1.0)
#
# The script is idempotent: re-running updates an existing install
# in-place (`git pull --ff-only` + `npm install --omit=dev`).
#
# Exits non-zero on any failure (set -e). Network failures, missing
# Node, missing git, missing permissions all bail out with a clear
# error message rather than leaving a half-installed tree.

set -euo pipefail

# ---------- args ----------
REPO="${DARWIN_REPO:-https://github.com/weixing/darwin.git}"
BRANCH="${DARWIN_BRANCH:-main}"
HOME_DIR="${DARWIN_HOME:-$HOME/.darwin}"
BIN_DIR="${DARWIN_BIN:-$HOME/.local/bin}"
PINNED_VERSION="${DARWIN_VERSION:-}"
NO_PATH_UPDATE=0
QUIET=0

usage() {
  cat <<'EOF'
Darwin one-click installer

Usage:
  install.sh [options]

Options:
  --repo URL         git repository URL (default: $DARWIN_REPO or weixing/darwin)
  --branch NAME      git branch to checkout (default: main)
  --version TAG      pin to a specific version tag/commit (overrides --branch)
  --dir PATH         install directory (default: $HOME/.darwin)
  --bin PATH         bin directory for `darwin` symlink (default: $HOME/.local/bin)
  --no-path-update   skip writing to shell rc files (PATH export hint)
  -q, --quiet        suppress non-error output
  -h, --help         show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --version) PINNED_VERSION="$2"; shift 2;;
    --dir) HOME_DIR="$2"; shift 2;;
    --bin) BIN_DIR="$2"; shift 2;;
    --no-path-update) NO_PATH_UPDATE=1; shift;;
    -q|--quiet) QUIET=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "install.sh: unknown option: $1" >&2; usage; exit 64;;
  esac
done

log() {
  if [ "$QUIET" -eq 0 ]; then
    echo "$@"
  fi
}
err() { echo "install.sh: $*" >&2; }

# ---------- preflight ----------
log ""
log "Darwin installer"
log "  install dir:  $HOME_DIR"
log "  bin dir:      $BIN_DIR"
log "  branch:       $BRANCH"
[ -n "$PINNED_VERSION" ] && log "  pinned:       $PINNED_VERSION"
log ""

# git
if ! command -v git >/dev/null 2>&1; then
  err "git is required. Install git and retry."
  exit 65
fi

# node
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required (>= 20)."
  err "Install via nvm (https://github.com/nvm-sh/nvm) or your package manager."
  err "Then re-run this installer."
  exit 66
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js >= 20 required (got $(node -v))."
  err "Install a newer Node (e.g. via nvm install 20) and re-run."
  exit 66
fi

# npm
if ! command -v npm >/dev/null 2>&1; then
  err "npm is required (comes with Node.js)."
  exit 66
fi

# ---------- clone or update ----------
CLONE_DIR="$HOME_DIR"
PARENT_DIR="$(dirname "$HOME_DIR")"

# Make sure parent dir exists and is writable.
if [ ! -d "$PARENT_DIR" ]; then
  err "parent directory does not exist: $PARENT_DIR"
  exit 73
fi

if [ -d "$CLONE_DIR/.git" ]; then
  log "Existing install detected at $CLONE_DIR -- updating."
  cd "$CLONE_DIR"
  if ! git remote get-url origin >/dev/null 2>&1; then
    err "existing install has no origin remote; aborting update to avoid clobbering."
    exit 74
  fi
  EXISTING_REMOTE="$(git remote get-url origin)"
  if [ "$EXISTING_REMOTE" != "$REPO" ] && [ "$QUIET" -eq 0 ]; then
    log "  note: existing remote is $EXISTING_REMOTE; using it (not $REPO)."
    log "        pass --repo to override, or remove $CLONE_DIR to switch remotes."
  fi
  git fetch --depth 1 --tags origin
  if [ -n "$PINNED_VERSION" ]; then
    git reset --hard "$PINNED_VERSION"
  else
    git reset --hard "origin/$BRANCH"
  fi
elif [ -d "$CLONE_DIR" ] && [ -n "$(ls -A "$CLONE_DIR" 2>/dev/null)" ]; then
  err "directory exists and is not a git repo: $CLONE_DIR"
  err "remove it (rm -rf $CLONE_DIR) or pass --dir to use a different path."
  exit 74
else
  log "Cloning $REPO into $CLONE_DIR ..."
  mkdir -p "$CLONE_DIR"
  if [ -n "$PINNED_VERSION" ]; then
    git clone --depth 1 --branch "$PINNED_VERSION" "$EXISTING_REMOTE_FALLBACK" "$CLONE_DIR" 2>/dev/null \
      || git clone --depth 1 "$REPO" "$CLONE_DIR"
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$CLONE_DIR"
  fi
  cd "$CLONE_DIR"
fi

# ---------- install dependencies ----------
log "Installing dependencies (npm install --omit=dev) ..."
cd "$CLONE_DIR"
npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

# ---------- link darwin into PATH ----------
log "Linking $BIN_DIR/darwin -> $CLONE_DIR/bin/darwin ..."
mkdir -p "$BIN_DIR"
chmod +x "$CLONE_DIR/bin/darwin"

# Use a real symlink (not a copy) so future updates flow through.
ln -sf "$CLONE_DIR/bin/darwin" "$BIN_DIR/darwin"

# Some shells also look for `darwin` without a suffix; symlink that too.
ln -sf "$CLONE_DIR/bin/darwin" "$BIN_DIR/darwin-bin" 2>/dev/null || true

# ---------- create ~/.darwin/.env template ----------
ENV_FILE="$HOME/.darwin/.env"
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Darwin configuration (one-click installer generated)
# Edit this file to set your provider credentials, then run:
#   darwin config show   # verify
#   darwin chat "hi"     # smoke test
#
# Pick a provider below and uncomment the matching lines. Only one
# provider block needs to be set for `darwin chat` to work.
#
# --- DeepSeek (openai-compatible) ---
# DARWIN_PROVIDER=openai-compatible
# DARWIN_API_KEY=sk-...
# DARWIN_BASE_URL=https://api.deepseek.com/v1
# DARWIN_MODEL=deepseek-chat
#
# --- Anthropic ---
# DARWIN_PROVIDER=anthropic
# DARWIN_API_KEY=sk-ant-...
# DARWIN_MODEL=claude-3-5-sonnet-20241022
#
# --- OpenAI ---
# DARWIN_PROVIDER=openai-compatible
# DARWIN_API_KEY=sk-...
# DARWIN_BASE_URL=https://api.openai.com/v1
# DARWIN_MODEL=gpt-4o-mini
EOF
  chmod 600 "$ENV_FILE"
  log "Created $ENV_FILE (edit to set your API key; chmod 600 already applied)."
else
  log "Existing $ENV_FILE preserved (not overwritten)."
fi

# ---------- PATH hint ----------
PATH_OK=0
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_OK=1;;
esac

# ---------- verify install ----------
log ""
log "Verifying install ..."
if "$BIN_DIR/darwin" version >/dev/null 2>&1; then
  INSTALLED_VERSION="$("$BIN_DIR/darwin" version 2>/dev/null || true)"
  log "  $($BIN_DIR/darwin version 2>/dev/null || echo darwin unknown)"
  log "  install OK"
else
  err "darwin command failed self-test (version subcommand)."
  err "  $BIN_DIR/darwin version"
  err "Try running it manually to see the error."
  exit 1
fi

log ""
log "Darwin installed successfully."
log ""
log "  Quick start:"
log "    darwin --version        # verify install"
log "    darwin help             # see all commands"
log "    darwin self-evolution diagnose   # scan capability surface"
log ""
log "  Next step: edit $ENV_FILE to set your API key,"
log "  then run:  darwin chat \"hello\""
log ""

if [ "$PATH_OK" -eq 0 ] && [ "$NO_PATH_UPDATE" -eq 0 ]; then
  log "  Note: $BIN_DIR is not in your PATH."
  log "  Add it to your shell rc:"
  log "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc   # bash"
  log "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc    # zsh"
  log "  Or re-run with --no-path-update to silence this message."
fi

log ""
log "  Uninstall: re-run install.sh with --dir pointing elsewhere,"
log "  then 'rm -rf $CLONE_DIR $BIN_DIR/darwin $BIN_DIR/darwin-bin $ENV_FILE'."
log ""