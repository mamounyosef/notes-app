# Keeps the Notes phone server running (the Android app's download page and
# updates at /notes, and the Notes and Planner connectors for Claude).
# Restarts node if it ever stops. Started hidden by scripts\phone-server.vbs,
# which the "Notes Phone Server Watchdog" scheduled task runs at sign-in and
# every 2 minutes. -Restart first stops any other copy of this loop and
# whatever holds port 4790 (a hung server), so only one copy ever runs.
param([switch]$Restart)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:APPDATA 'notesapp\phone-server.log'
$port = 4790
Set-Location $repo

function Write-Log($msg) {
  "---- $msg $(Get-Date -Format s)" | Out-File -FilePath $log -Append -Encoding utf8
}

if ($Restart) {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*phone-server-run.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Write-Log 'watchdog restart (server was not answering)'
  Start-Sleep -Seconds 1
}

while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
  Write-Log 'start'
  & node server/phone-server.mjs *>> $log
  Write-Log "stopped (exit $LASTEXITCODE), restarting in 5 s"
  Start-Sleep -Seconds 5
}
