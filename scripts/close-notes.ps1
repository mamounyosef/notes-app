# Closes every running Notes (this folder's packaged app, its dev Electron, or
# an older installed copy) so it can be updated. Asks politely first so saves
# can flush.
$root = Split-Path -Parent $PSScriptRoot
$mine = {
  if (-not $_.Path) { return $false }
  if ($_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and ($_.Name -eq 'Notes' -or $_.Name -eq 'electron')) { return $true }
  # An installed copy: Notes.exe made by this project. Not while testing a throwaway copy (scripts\test-update.mjs).
  if ($env:NOTES_UPDATE_TEST) { return $false }
  return ($_.Name -eq 'Notes' -and $_.Company -match 'mamoun')
}
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object $mine
if (-not $procs) { exit 0 }
Write-Host '  Closing Notes so it can be updated.'
$procs | ForEach-Object { [void]$_.CloseMainWindow() }
# Give it time to save (the app waits up to 5 seconds for that), then stop what is left.
for ($i = 0; $i -lt 16 -and (Get-Process -ErrorAction SilentlyContinue | Where-Object $mine); $i++) { Start-Sleep -Milliseconds 500 }
Get-Process -ErrorAction SilentlyContinue | Where-Object $mine | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
exit 0
