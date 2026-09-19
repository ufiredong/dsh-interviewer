# safe-plugin.ps1 -- install/remove DSH plugins without risking the profile
#
# WHY THIS EXISTS
#   `dsh plugin add` runs a pnpm install inside the profile directory. That
#   touches node_modules, and this DSH install uses a CUSTOM native-addon
#   loader (node-addon-require-builtin / node-addon-system). Once a native
#   module gets disturbed, the next boot can fail with:
#
#       Error: Mismatched native Koffi modules
#       failed to import loader entry subprocess (@deepseek-ai/dsh-subprocess-local)
#       failed to import loader entry sandbox    (@deepseek-ai/dsh-sandbox-local)
#
#   DSH crashes, but the root cause is NOT the plugin you installed.
#
# RULE: back up the profile before touching it. One command rolls back.
#
# USAGE
#   .\safe-plugin.ps1 status
#   .\safe-plugin.ps1 backup
#   .\safe-plugin.ps1 install D:\ai\dsh-interviewer
#   .\safe-plugin.ps1 restore
#
# Restart `dsh web` after install or restore.
#
# NOTE: this file is deliberately ASCII-only. A recovery script must not
# depend on the console code page -- see README for the full story.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'backup', 'install', 'restore')]
  [string]$Action,

  [Parameter(Position = 1)]
  [string]$Package,

  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfDir = Join-Path $DshHome "profiles\$Profile"
$BackRoot = Join-Path $DshHome "plugin-backups\$Profile"

# These three files ARE the record of what is installed. Miss one and the
# rollback is incomplete.
$Tracked = @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')

if (-not (Test-Path $ProfDir)) {
  Write-Host "ERROR: profile directory not found: $ProfDir" -ForegroundColor Red
  exit 1
}

function Show-Bundles {
  $pkgPath = Join-Path $ProfDir 'package.json'
  if (-not (Test-Path $pkgPath)) { Write-Host '  (no package.json)' -ForegroundColor DarkGray; return }
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $bundles = $pkg.dsh.profile.bundles
  Write-Host ("  bundles ({0}):" -f $bundles.Count)
  foreach ($b in $bundles) { Write-Host "    - $b" }
}

function Invoke-Backup {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dest = Join-Path $BackRoot $stamp
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  $n = 0
  foreach ($f in $Tracked) {
    $src = Join-Path $ProfDir $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $dest $f) -Force; $n++ }
  }

  if ($n -eq 0) {
    Write-Host 'ERROR: backed up nothing -- check the profile directory' -ForegroundColor Red
    exit 1
  }

  Write-Host ("OK: backed up {0} file(s) to {1}" -f $n, $dest) -ForegroundColor Green
  return $dest
}

switch ($Action) {

  'status' {
    Write-Host "profile : $ProfDir" -ForegroundColor Cyan
    Show-Bundles
    Write-Host ''
    Write-Host 'Existing backups:'
    if (Test-Path $BackRoot) {
      $any = $false
      Get-ChildItem $BackRoot -Directory | Sort-Object Name -Descending |
        Select-Object -First 5 | ForEach-Object {
          $any = $true
          $files = (Get-ChildItem $_.FullName -File).Count
          Write-Host ("  {0}  ({1} file(s))" -f $_.Name, $files)
        }
      if (-not $any) { Write-Host '  (none)' -ForegroundColor DarkGray }
    } else {
      Write-Host '  (none)' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host 'Official escape hatch when the web profile is broken:' -ForegroundColor Yellow
    Write-Host '  dsh --profile rescue --from-default-profile web'
  }

  'backup' {
    Invoke-Backup | Out-Null
  }

  'install' {
    if (-not $Package) {
      Write-Host 'ERROR: need a package name or path, e.g.' -ForegroundColor Red
      Write-Host '  .\safe-plugin.ps1 install D:\ai\dsh-interviewer' -ForegroundColor Red
      exit 1
    }

    Write-Host '[1/2] Backing up first (pnpm install can disturb native modules)' -ForegroundColor Cyan
    $dest = Invoke-Backup

    Write-Host ''
    Write-Host "[2/2] Installing: $Package" -ForegroundColor Cyan
    & dsh plugin --profile $Profile add $Package
    $code = $LASTEXITCODE

    if ($code -ne 0) {
      Write-Host ("ERROR: dsh plugin add exited with {0}. The profile is half-changed." -f $code) -ForegroundColor Red
      Write-Host '  Roll back with:  .\safe-plugin.ps1 restore' -ForegroundColor Yellow
      exit $code
    }

    Write-Host ''
    Write-Host "OK: installed. Backup at $dest" -ForegroundColor Green
    Write-Host '  Rollback:  .\safe-plugin.ps1 restore' -ForegroundColor DarkGray
    Write-Host '  Then restart dsh web.' -ForegroundColor DarkGray
  }

  'restore' {
    if (-not (Test-Path $BackRoot)) {
      Write-Host 'ERROR: no backups to restore from' -ForegroundColor Red
      exit 1
    }
    $latest = Get-ChildItem $BackRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) {
      Write-Host 'ERROR: backup directory is empty' -ForegroundColor Red
      exit 1
    }

    Write-Host ("Restoring from: {0}" -f $latest.Name) -ForegroundColor Cyan
    $n = 0
    foreach ($f in $Tracked) {
      $src = Join-Path $latest.FullName $f
      if (Test-Path $src) {
        Copy-Item $src (Join-Path $ProfDir $f) -Force
        Write-Host "  restored $f"
        $n++
      }
    }
    Write-Host ("OK: restored {0} file(s)" -f $n) -ForegroundColor Green
    Write-Host ''
    Show-Bundles
    Write-Host ''
    Write-Host 'NOTE: this only restores the "which plugins are installed" record.' -ForegroundColor Yellow
    Write-Host '      It does NOT rebuild node_modules. If the crash was a native' -ForegroundColor Yellow
    Write-Host '      module mismatch, restart dsh web and check the result.' -ForegroundColor Yellow
  }
}
