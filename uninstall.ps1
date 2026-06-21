# Darwin uninstaller (Windows PowerShell).
# Usage: iwr -useb https://.../uninstall.ps1 | iex
# Removes the install dir + bin launchers; preserves ~/.darwin/.env
# unless -Purge is passed (which also wipes memory + audit data).

[CmdletBinding()]
param(
  [string]$Home = $env:DARWIN_HOME,
  [string]$Bin = $env:DARWIN_BIN,
  [switch]$Purge,
  [switch]$Quiet,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Host 'Darwin uninstaller (Windows)'
  Write-Host 'Usage: iwr -useb .../uninstall.ps1 | iex'
  Write-Host 'Options: -Home PATH -Bin PATH -Purge -Quiet'
  exit 0
}

if (-not $Home) { $Home = Join-Path $env:USERPROFILE '.darwin' }
if (-not $Bin)  { $Bin  = Join-Path $env:USERPROFILE '.local\bin' }

function Log($msg) { if (-not $Quiet) { Write-Host $msg } }
function Err($msg)  { Write-Host "uninstall.ps1: $msg" -ForegroundColor Red }

$entry = Join-Path $Home 'bin\darwin'
if (-not (Test-Path $entry)) {
  Err "refusing to remove $Home -- bin\darwin not found (not a darwin install?)"
  exit 74
}

Log "Removing darwin install at $Home ..."
Remove-Item -Recurse -Force $Home

$cmd = Join-Path $Bin 'darwin.cmd'
$ps1 = Join-Path $Bin 'darwin.ps1'
foreach ($f in @($cmd, $ps1)) {
  if (Test-Path $f) {
    Log "Removing $f ..."
    Remove-Item -Force $f
  }
}

$envFile = Join-Path (Split-Path -Parent $Home) '.darwin\.env'
if (Test-Path $envFile) {
  if ($Purge) {
    Log "Removing $envFile (-Purge)"
    Remove-Item -Force $envFile
  } else {
    Log "Preserving $envFile (pass -Purge to remove; contains your API keys)"
  }
}

Log ''
Log 'Darwin uninstalled. Open a new shell so the PATH change (if any) takes effect.'
Log ''