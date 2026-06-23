# Darwin one-click installer (Windows PowerShell 5.1+ / PowerShell Core 7+).
#
# Usage (from PowerShell):
#   # From git (default):
#   iwr -useb https://raw.githubusercontent.com/<owner>/darwin/<branch>/install.ps1 | iex
#   iwr ... | iex; Install-Darwin -Branch dev
#
#   # From a pre-built tarball (no git needed, used by V25+ release):
#   iwr -useb .../install.ps1 | iex; Install-Darwin -FromTarball <url>
#
#   # From a local already-extracted tarball:
#   tar -xzf darwin-v0.1.0.tar.gz
#   cd darwin-v0.1.0
#   ./install.ps1 -FromTarballInstalled
#
# After install:
#   - $HOME\.darwin\                 = installed tree
#   - $HOME\.local\bin\darwin.cmd    = launcher
#   - $HOME\.darwin\.env             = config template
#   - `darwin --version` works from any new shell
#
# Uninstall: iwr -useb .../uninstall.ps1 | iex

[CmdletBinding()]
param(
  [string]$Repo = $env:DARWIN_REPO,
  [string]$Branch = $env:DARWIN_BRANCH,
  [string]$Version = $env:DARWIN_VERSION,
  [string]$FromTarball = $env:DARWIN_TARBALL,
  [switch]$FromTarballInstalled,
  [string]$Home = $env:DARWIN_HOME,
  [string]$Bin = $env:DARWIN_BIN,
  [switch]$NoPathUpdate,
  [switch]$Quiet,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Host 'Darwin one-click installer (Windows)'
  Write-Host ''
  Write-Host 'Source options (pick one):'
  Write-Host '  (default)              git clone from $Repo at $Branch'
  Write-Host '  -Repo URL              git repository URL'
  Write-Host '  -Branch NAME           git branch (default: main)'
  Write-Host '  -Version TAG           pin to a specific git tag/commit (overrides -Branch)'
  Write-Host '  -FromTarball URL       install from a pre-built tarball (no git needed)'
  Write-Host '  -FromTarballInstalled  install from current dir (already-extracted tarball)'
  Write-Host ''
  Write-Host 'Install layout:'
  Write-Host '  -Home PATH             install directory (default: $HOME\.darwin)'
  Write-Host '  -Bin PATH              bin directory (default: $HOME\.local\bin)'
  Write-Host ''
  Write-Host 'Other:'
  Write-Host '  -NoPathUpdate          skip the PATH hint'
  Write-Host '  -Quiet                 suppress non-error output'
  exit 0
}

if (-not $Repo)    { $Repo = 'https://github.com/weixingnc/darwin_ai.git' }
if (-not $Branch)  { $Branch = 'main' }
if (-not $Home)    { $Home = Join-Path $env:USERPROFILE '.darwin' }
if (-not $Bin)     { $Bin  = Join-Path $env:USERPROFILE '.local\bin' }

function Log($msg) {
  if (-not $Quiet) { Write-Host $msg }
}
function Err($msg) {
  Write-Host "install.ps1: $msg" -ForegroundColor Red
}

Log ''
Log 'Darwin installer'
Log "  install dir:  $Home"
Log "  bin dir:      $Bin"
if ($FromTarballInstalled) {
  Log '  source:       local (already extracted)'
} elseif ($FromTarball) {
  Log "  source:       tarball $FromTarball"
} else {
  Log "  branch:       $Branch"
  if ($Version) { Log "  pinned:       $Version" }
}
Log ''

# ----- preflight -----
if (-not $FromTarball -and -not $FromTarballInstalled) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    Err 'git is required for the default git-based install. Use -FromTarball <url> to install without git.'
    exit 65
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Err 'Node.js is required (>= 20). Install from https://nodejs.org/ and re-run.'
  exit 66
}
$nodeVer = & node -v
$nodeMajor = [int]($nodeVer -replace '^v(\d+).*', '$1')
if ($nodeMajor -lt 20) {
  Err "Node.js >= 20 required (got $nodeVer)."
  exit 66
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Err 'npm is required (comes with Node.js).'
  exit 66
}

if ($FromTarball) {
  $curl = Get-Command curl -ErrorAction SilentlyContinue
  if (-not $curl) {
    Err 'curl is required for -FromTarball (Windows 10 1803+ ships it).'
    exit 65
  }
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $tar) {
    Err 'tar is required for -FromTarball (Windows 10 1803+ ships it).'
    exit 65
  }
}

# ----- resolve source -----
$parent = Split-Path -Parent $Home
if (-not (Test-Path $parent)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

if ($FromTarballInstalled) {
  $pwdHasInstall = (Test-Path '.\install.ps1') -and (Test-Path '.\bin\darwin') -and (Test-Path '.\package.json')
  if (-not $pwdHasInstall) {
    Err '-FromTarballInstalled: expected install.ps1, bin\darwin, package.json in $PWD.'
    Err 'cd into the extracted tarball directory first.'
    exit 74
  }
  $homeEmpty = -not (Test-Path $Home) -or -not (Get-ChildItem -Force $Home -ErrorAction SilentlyContinue)
  if (-not $homeEmpty -and ($Home -ne (Get-Location).Path)) {
    Err "$Home already exists and is not empty. Remove it first or pass -Home."
    exit 74
  }
  if ($Home -ne (Get-Location).Path) {
    Log "Copying extracted tree from $(Get-Location) to $Home ..."
    New-Item -ItemType Directory -Path $Home -Force | Out-Null
    Copy-Item -Path '. \*' -Destination $Home -Recurse -Force
  } else {
    Log "Using $(Get-Location) as the install dir."
  }
} elseif ($FromTarball) {
  if (Test-Path $Home) {
    $existing = Get-ChildItem -Force $Home -ErrorAction SilentlyContinue
    if ($existing.Count -gt 0) {
      Err "$Home already exists and is not empty. Remove it first or pass -Home."
      Err 'tarball install is install-only (no in-place update).'
      exit 74
    }
  }
  Log "Downloading tarball from $FromTarball ..."
  New-Item -ItemType Directory -Path $Home -Force | Out-Null
  $tarballTmp = Join-Path $env:TEMP ("darwin-tarball-" + [guid]::NewGuid() + ".tar.gz")
  try {
    & curl -fsSL --retry 3 -o $tarballTmp $FromTarball
    if ($LASTEXITCODE -ne 0) {
      Err "failed to download $FromTarball"
      exit 75
    }
    Log "Extracting $tarballTmp to $Home ..."
    Push-Location $Home
    try {
      & tar -xzf $tarballTmp
      if ($LASTEXITCODE -ne 0) {
        Err 'tar extraction failed'
        exit 76
      }
    } finally {
      Pop-Location
    }
  } finally {
    if (Test-Path $tarballTmp) { Remove-Item -Force $tarballTmp }
  }
} elseif (Test-Path (Join-Path $Home '.git')) {
  Log "Existing install detected at $Home -- updating."
  Push-Location $Home
  try {
    $existingRemote = git remote get-url origin 2>$null
    if (-not $existingRemote) {
      Err 'existing install has no origin remote; aborting update to avoid clobbering.'
      exit 74
    }
    if ($existingRemote -ne $Repo -and -not $Quiet) {
      Log "  note: existing remote is $existingRemote; using it (not $Repo)."
      Log '        pass -Repo to override, or remove $Home to switch remotes.'
    }
    git fetch --depth 1 --tags origin | Out-Null
    if ($Version) {
      git reset --hard $Version | Out-Null
    } else {
      git reset --hard origin/$Branch | Out-Null
    }
  } finally {
    Pop-Location
  }
} elseif (Test-Path $Home) {
  $existing = Get-ChildItem -Force $Home -ErrorAction SilentlyContinue
  if ($existing.Count -gt 0) {
    Err "$Home already exists and is not a git repo."
    Err 'remove it (Remove-Item -Recurse -Force) or pass -Home to use a different path.'
    exit 74
  }
  Log "Cloning $Repo into $Home ..."
  git clone --depth 1 --branch $Branch $Repo $Home
} else {
  Log "Cloning $Repo into $Home ..."
  git clone --depth 1 --branch $Branch $Repo $Home
}

# ----- install dependencies -----
Log 'Installing dependencies (npm install --omit=dev --ignore-scripts) ...'
Push-Location $Home
try {
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error | Out-Null
} finally {
  Pop-Location
}

# ----- generate launchers if missing -----
Log "Creating $Bin\darwin.cmd ..."
if (-not (Test-Path $Bin)) {
  New-Item -ItemType Directory -Path $Bin -Force | Out-Null
}

$cmd = Join-Path $Home 'bin\darwin.cmd'
$ps1 = Join-Path $Home 'bin\darwin.ps1'
if (-not (Test-Path $cmd)) {
  $cmdBody = '@echo off' + "`r`n" + 'REM Darwin CLI launcher (auto-generated by install.ps1).' + "`r`n" + 'node "%~dp0darwin" %*'
  Set-Content -Path $cmd -Value $cmdBody -Encoding ASCII
}
if (-not (Test-Path $ps1)) {
  $ps1Body = '# Darwin CLI launcher (PowerShell, auto-generated by install.ps1).' + "`r`n" + '& node "$PSScriptRoot\darwin" @args'
  Set-Content -Path $ps1 -Value $ps1Body -Encoding ASCII
}

Copy-Item -Path $cmd -Destination (Join-Path $Bin 'darwin.cmd') -Force
Copy-Item -Path $ps1 -Destination (Join-Path $Bin 'darwin.ps1') -Force

# ----- create ~/.darwin/.env template -----
$envDir = Join-Path (Split-Path -Parent $Home) '.darwin'
if (-not (Test-Path $envDir)) { New-Item -ItemType Directory -Path $envDir -Force | Out-Null }
$envFile = Join-Path $envDir '.env'
if (-not (Test-Path $envFile)) {
  $envBody = @"
# Darwin configuration (one-click installer generated)
# Edit this file to set your provider credentials, then run:
#   darwin config show
#   darwin chat `"hi`"

# --- DeepSeek (openai-compatible) ---
# DARWIN_PROVIDER=openai-compatible
# DARWIN_API_KEY=sk-...
# DARWIN_BASE_URL=https://api.deepseek.com/v1
# DARWIN_MODEL=deepseek-chat

# --- Anthropic ---
# DARWIN_PROVIDER=anthropic
# DARWIN_API_KEY=sk-ant-...
# DARWIN_MODEL=claude-3-5-sonnet-20241022

# --- OpenAI ---
# DARWIN_PROVIDER=openai-compatible
# DARWIN_API_KEY=sk-...
# DARWIN_BASE_URL=https://api.openai.com/v1
# DARWIN_MODEL=gpt-4o-mini
"@
  Set-Content -Path $envFile -Value $envBody -Encoding UTF8
  Log "Created $envFile (edit to set your API key)."
} else {
  Log "Existing $envFile preserved (not overwritten)."
}

# ----- verify install -----
Log ''
Log 'Verifying install ...'
$darwinCmd = Join-Path $Bin 'darwin.cmd'
$ver = & cmd.exe /c "$darwinCmd version" 2>$null
if ($LASTEXITCODE -ne 0) {
  Err 'darwin command failed self-test (version subcommand).'
  Err "  $darwinCmd version"
  exit 1
}
$verText = ($ver -join "`n").Trim()
Log "  $verText"
Log '  install OK'

Log ''
Log 'Darwin installed successfully.'
Log ''
Log '  Quick start:'
Log '    darwin --version        # verify install (in a NEW shell)'
Log '    darwin help             # see all commands'
Log '    darwin self-evolution diagnose   # scan capability surface'
Log ''
Log "  Next step: edit $envFile to set your API key,"
Log '  then run:  darwin chat "hello"'
Log ''

# PATH check
$binInPath = $false
foreach ($p in ($env:PATH -split ';')) {
  if ($p -eq $Bin) { $binInPath = $true; break }
}
if (-not $binInPath) {
  if (-not $NoPathUpdate) {
    Log "  Note: $Bin is not in your PATH for the current session."
    Log '  To make it permanent (PowerShell):'
    Log '    [Environment]::SetEnvironmentVariable("PATH", $Bin + ";" + $env:PATH, "User")'
    Log '  Then open a new PowerShell window.'
  }
}

Log ''
Log "  Uninstall: Remove-Item -Recurse -Force $Home,$envFile"
Log "  and remove the darwin.cmd from $Bin."
Log ''
