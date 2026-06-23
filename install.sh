#!/usr/bin/env bash
# Darwin one-click installer (Linux + macOS).
#
# Usage:
#   # From git (default):
#   curl -fsSL https://raw.githubusercontent.com/<owner>/darwin/<branch>/install.sh | bash
#   curl ... | bash -s -- --branch dev
#   curl ... | bash -s -- --dir /opt/darwin
#
#   # From a pre-built tarball (no git needed, used by V25 release workflow):
#   curl ... | bash -s -- --from-tarball \
#     https://github.com/<owner>/darwin/releases/download/<tag>/darwin-<tag>.tar.gz
#
#   # From a local already-extracted tarball (post-`tar -xzf`):
#   tar -xzf darwin-v0.1.0.tar.gz
#   cd darwin-v0.1.0
#   bash install.sh --from-tarball-installed
#
# Environment overrides:
#   DARWIN_REPO      git URL to clone (default: https://github.com/weixingnc/darwin_ai.git)
#   DARWIN_BRANCH    git branch/tag to checkout (default: main)
#   DARWIN_HOME      install directory (default: $HOME/.darwin)
#   DARWIN_BIN       bin directory for the `darwin` symlink (default: $HOME/.local/bin)
#   DARWIN_VERSION   pinned git version (overrides --branch; e.g. v0.1.0)
#   DARWIN_TARBALL   URL of a pre-built tarball (overrides --from-tarball flag)
#
# The script is idempotent: re-running with --repo updates an
# existing install in-place (`git pull --ff-only` + `npm install`).
# With --from-tarball, the existing install must be removed first
# (tarballs aren't incrementally updateable).
#
# Exits non-zero on any failure (set -e). Network failures, missing
# Node, missing git, missing permissions all bail out with a clear
# error message rather than leaving a half-installed tree.

set -euo pipefail

# ---------- args ----------
REPO="${DARWIN_REPO:-https://github.com/weixingnc/darwin_ai.git}"
BRANCH="${DARWIN_BRANCH:-main}"
HOME_DIR="${DARWIN_HOME:-$HOME/.darwin}"
BIN_DIR="${DARWIN_BIN:-$HOME/.local/bin}"
PINNED_VERSION="${DARWIN_VERSION:-}"
FROM_TARBALL="${DARWIN_TARBALL:-}"
FROM_TARBALL_INSTALLED=0
NO_PATH_UPDATE=0
QUIET=0

usage() {
  cat <<'EOF'
Darwin one-click installer

Usage:
  install.sh [options]

Source options (pick one):
  (default)              git clone from $DARWIN_REPO (or --repo) at $DARWIN_BRANCH
  --repo URL             git repository URL
  --branch NAME          git branch to checkout (default: main)
  --version TAG          pin to a specific git tag/commit (overrides --branch)
  --from-tarball URL     install from a pre-built tarball (no git needed)
  --from-tarball-installed   install from current dir (already-extracted tarball)

Install layout:
  --dir PATH             install directory (default: $HOME/.darwin)
  --bin PATH             bin directory for `darwin` symlink (default: $HOME/.local/bin)

Other:
  --no-path-update       skip the "add to PATH" hint
  -q, --quiet            suppress non-error output
  -h, --help             show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --version) PINNED_VERSION="$2"; shift 2;;
    --from-tarball) FROM_TARBALL="$2"; shift 2;;
    --from-tarball-installed) FROM_TARBALL_INSTALLED=1; shift;;
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
if [ -n "$FROM_TARBALL_INSTALLED" ]; then
  log "  source:       local (already extracted)"
elif [ -n "$FROM_TARBALL" ]; then
  log "  source:       tarball $FROM_TARBALL"
else
  log "  branch:       $BRANCH"
  [ -n "$PINNED_VERSION" ] && log "  pinned:       $PINNED_VERSION"
fi
log ""

# git
if [ -z "$FROM_TARBALL" ] && [ "$FROM_TARBALL_INSTALLED" -eq 0 ]; then
  if ! command -v git >/dev/null 2>&1; then
    err "git is required for the default git-based install."
    err "Use --from-tarball URL to install without git."
    exit 65
  fi
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

# curl (for tarball + verify)
if [ -n "$FROM_TARBALL" ] && ! command -v curl >/dev/null 2>&1; then
  err "curl is required for --from-tarball."
  exit 65
fi

# tar (for tarball extract)
if [ -n "$FROM_TARBALL" ] && ! command -v tar >/dev/null 2>&1; then
  err "tar is required for --from-tarball."
  exit 65
fi

# ---------- resolve source ----------
CLONE_DIR="$HOME_DIR"
PARENT_DIR="$(dirname "$HOME_DIR")"

if [ ! -d "$PARENT_DIR" ]; then
  err "parent directory does not exist: $PARENT_DIR"
  exit 73
fi

if [ "$FROM_TARBALL_INSTALLED" -eq 1 ]; then
  # User already extracted the tarball; treat the current dir as the source.
  if [ ! -f "./install.sh" ] || [ ! -f "./bin/darwin" ] || [ ! -f "./package.json" ]; then
    err "--from-tarball-installed: expected install.sh, bin/darwin, package.json in $PWD."
    err "cd into the extracted tarball directory first."
    exit 74
  fi
  # If $HOME_DIR exists and is not empty, refuse (tarball is install-only, not update).
  if [ -d "$CLONE_DIR" ] && [ -n "$(ls -A "$CLONE_DIR" 2>/dev/null)" ] && [ "$CLONE_DIR" != "$(pwd)" ]; then
    err "$CLONE_DIR already exists and is not empty. Remove it first or pass --dir."
    exit 74
  fi
  if [ "$CLONE_DIR" != "$(pwd)" ]; then
    log "Copying extracted tree from $(pwd) to $CLONE_DIR ..."
    mkdir -p "$CLONE_DIR"
    # Copy everything (including dotfiles) except the tarball itself.
    shopt -s dotglob
    cp -a ./. "$CLONE_DIR/"
  else
    log "Using $(pwd) as the install dir."
  fi
elif [ -n "$FROM_TARBALL" ]; then
  # Download + extract a tarball.
  if [ -d "$CLONE_DIR" ] && [ -n "$(ls -A "$CLONE_DIR" 2>/dev/null)" ]; then
    err "$CLONE_DIR already exists and is not empty. Remove it first or pass --dir."
    err "tarball install is install-only (no in-place update)."
    exit 74
  fi
  log "Downloading tarball from $FROM_TARBALL ..."
  mkdir -p "$CLONE_DIR"
  # Download to a temp file first so a partial download doesn't
  # leave a half-extracted tree behind.
  TARBALL_TMP="$(mktemp -t darwin-tarball-XXXXXX.tar.gz)"
  # shellcheck disable=SC2064
  trap "rm -f '$TARBALL_TMP'" EXIT
  if ! curl -fsSL --retry 3 -o "$TARBALL_TMP" "$FROM_TARBALL"; then
    err "failed to download $FROM_TARBALL"
    exit 75
  fi
  log "Extracting $TARBALL_TMP to $CLONE_DIR ..."
  tar -xzf "$TARBALL_TMP" -C "$CLONE_DIR"
  rm -f "$TARBALL_TMP"
  trap - EXIT
  # The tarball from release.yml extracts flat (no top-level subdir).
  # If a future build wraps in a darwin-${VERSION}/ subdir, flatten it.
  shopt -s nullglob
  subdirs=("$CLONE_DIR"/darwin-*/)
  if [ "${#subdirs[@]}" -eq 1 ] && [ ! -f "$CLONE_DIR/bin/darwin" ]; then
    log "Flattening nested subdir $(basename "${subdirs[0]}") ..."
    shopt -s dotglob
    mv "${subdirs[0]}"/* "$CLONE_DIR/"
    rmdir "${subdirs[0]}"
  fi
elif [ -d "$CLONE_DIR/.git" ]; then
  # Existing git install -- update in place.
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
    git clone --depth 1 --branch "$PINNED_VERSION" "$REPO" "$CLONE_DIR" \
      || git clone --depth 1 "$REPO" "$CLONE_DIR"
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$CLONE_DIR"
  fi
  cd "$CLONE_DIR"
fi

# ---------- install dependencies ----------
log "Installing dependencies (npm install --omit=dev --ignore-scripts) ..."
cd "$CLONE_DIR"
npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

# ---------- link darwin into PATH ----------
log "Linking $BIN_DIR/darwin -> $CLONE_DIR/bin/darwin ..."
mkdir -p "$BIN_DIR"
chmod +x "$CLONE_DIR/bin/darwin"

ln -sf "$CLONE_DIR/bin/darwin" "$BIN_DIR/darwin"
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

# ---------- verify install ----------
log ""
log "Verifying install ..."
INSTALLED_VERSION="$("$BIN_DIR/darwin" version 2>/dev/null || true)"
if [ -n "$INSTALLED_VERSION" ]; then
  log "  $INSTALLED_VERSION"
  log "  install OK"
else
  err "darwin command failed self-test (version subcommand)."
  err "  $BIN_DIR/darwin version"
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

PATH_OK=0
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_OK=1;;
esac

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