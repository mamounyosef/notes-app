# Closes Notes if it is running from this folder (the packaged app or the
# dev Electron), so it can be rebuilt. Asks politely first so saves can flush.
$root = Split-Path -Parent $PSScriptRoot
$mine = { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and ($_.Name -eq 'Notes' -or $_.Name -eq 'electron') }
$procs = Get-Process | Where-Object $mine
if (-not $procs) { exit 0 }
Write-Host '  Closing Notes so it can be updated.'
$procs | ForEach-Object { [void]$_.CloseMainWindow() }
Start-Sleep -Seconds 3
Get-Process | Where-Object $mine | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
