# Closes the running packaged app, rebuilds it with npm run dist, then relaunches it.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'release\win-unpacked\Notes.exe'

$procs = Get-Process | Where-Object { $_.Path -eq $exe }
if ($procs) {
  # Ask the main window to close first so pending saves can flush.
  $procs | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 3
  Get-Process | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
  Start-Sleep -Seconds 1
}

Push-Location $root
try {
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw "npm run dist failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

Start-Process -FilePath $exe
Write-Output 'Rebuilt and relaunched Notes.'
