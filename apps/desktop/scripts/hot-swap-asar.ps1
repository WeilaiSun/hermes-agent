# hot-swap-asar.ps1 — Apply a hot-built Hermes desktop update (2026-08-12)
#
# Run AFTER `node scripts/hot-build-asar.mjs` produced:
#   release/hot-update/app.asar.new
#   release/hot-update/unpacked-dist/
#
# What this script does (all in one go):
#   1. Close the Hermes desktop UI (win-unpacked processes only)
#   2. Back up the current app.asar + unpacked dist
#   3. Swap in the new app.asar and new renderer
#   4. Verify checksums
#   5. Restart Hermes.exe
#
# Usage (from any shell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "F:\Hermes\HERMES_HOME\hermes-agent\apps\desktop\scripts\hot-swap-asar.ps1"

$ErrorActionPreference = 'Stop'

# ---- paths ----
$desktopRoot  = Split-Path $PSScriptRoot -Parent   # apps/desktop (scripts 的上级)
$release      = Join-Path $desktopRoot 'release'
$winUnpacked  = Join-Path $release 'win-unpacked'
$resources    = Join-Path $winUnpacked 'resources'
$hotUpdate    = Join-Path $release 'hot-update'

$newAsar      = Join-Path $hotUpdate 'app.asar.new'
# @electron/asar 把 unpacked 文件放在 <output>.unpacked/ 旁（与 electron-builder 同款约定）
$newUnpacked  = Join-Path $hotUpdate 'app.asar.new.unpacked\dist'
$targetAsar   = Join-Path $resources 'app.asar'
$targetDist   = Join-Path $resources 'app.asar.unpacked\dist'
$hermesExe    = Join-Path $winUnpacked 'Hermes.exe'

function Get-Sha256($path) {
  (Get-FileHash -Path $path -Algorithm SHA256).Hash
}

Write-Host '=== hot-swap-asar ==='
Write-Host "release: $winUnpacked"

# ---- 0. sanity checks ----
if (-not (Test-Path $newAsar))   { Write-Host 'FATAL: app.asar.new missing - run hot-build-asar.mjs first'; exit 1 }
if (-not (Test-Path $newUnpacked)) { Write-Host 'FATAL: app.asar.new.unpacked\dist missing - run hot-build-asar.mjs first'; exit 1 }
if (-not (Test-Path $targetAsar)) { Write-Host "FATAL: current app.asar not found at $targetAsar"; exit 1 }

$newAsarHash = Get-Sha256 $newAsar

# ---- 1. close desktop UI (win-unpacked processes ONLY, never backend/gateway) ----
Write-Host 'Closing Hermes desktop UI (win-unpacked)...'
$ui = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*win-unpacked*' }
foreach ($p in $ui) { Write-Host "  killing PID $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# ---- 2. backup ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakAsar = "$targetAsar.bak-$stamp"
Copy-Item $targetAsar $bakAsar -Force
Write-Host "Backed up asar -> $bakAsar"

# ---- 3. swap app.asar ----
Remove-Item $targetAsar -Force
Move-Item $newAsar $targetAsar -Force
Write-Host 'Swapped app.asar'

# ---- 4. swap renderer (app.asar.unpacked/dist) ----
$unpackedRoot = Join-Path $resources 'app.asar.unpacked'
if (Test-Path $targetDist) {
  $bakDist = "$targetDist.bak-$stamp"
  Rename-Item $targetDist $bakDist
  Write-Host "Backed up unpacked dist -> $bakDist"
}
New-Item -ItemType Directory -Path $targetDist -Force | Out-Null
Move-Item (Join-Path $newUnpacked '*') $targetDist -Force
Write-Host 'Swapped app.asar.unpacked/dist'

# ---- 5. verify ----
$verifyAsar = Get-Sha256 $targetAsar
if ($verifyAsar -eq $newAsarHash) {
  Write-Host "VERIFY OK: app.asar SHA256 $verifyAsar"
} else {
  Write-Host "VERIFY FAIL: expected $newAsarHash got $verifyAsar"
  exit 1
}
$distCount = (Get-ChildItem $targetDist -Recurse -File | Measure-Object).Count
Write-Host "VERIFY OK: unpacked dist files = $distCount"
Write-Host "app.asar size: $((Get-Item $targetAsar).Length) bytes, mtime $((Get-Item $targetAsar).LastWriteTime)"

# ---- 6. restart ----
if (Test-Path $hermesExe) {
  Start-Process $hermesExe
  Write-Host "Hermes restarted: $hermesExe"
} else {
  Write-Host "WARN: Hermes.exe not found at $hermesExe - start it manually"
}

Write-Host '=== done - new build should now be live ==='
