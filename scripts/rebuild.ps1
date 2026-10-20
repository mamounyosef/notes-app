# Builds the app, then closes the running packaged app, repackages release\win-unpacked
# (no installer) and relaunches it. A failed build leaves the running app open.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'release\win-unpacked\Notes.exe'

Push-Location $root
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed ($LASTEXITCODE)" }

  # Packaging rewrites release\win-unpacked, which the running app keeps locked.
  $procs = Get-Process | Where-Object { $_.Path -eq $exe }
  if ($procs) {
    # Ask the main window to close first so pending saves can flush.
    $procs | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Seconds 3
    Get-Process | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
    Start-Sleep -Seconds 1
  }

  # Only the unpacked app is needed to run it here; `npm run dist` still makes the installer.
  npx electron-builder --win --dir
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
  # Reopen the app whatever happened, so a failure never leaves it closed.
  if (-not (Get-Process | Where-Object { $_.Path -eq $exe })) { Start-Process -FilePath $exe }
}

Write-Output 'Rebuilt and relaunched Notes.'
