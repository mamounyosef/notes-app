# Keeps the Notes phone server running (the Android app's download page and
# updates at /notes, and the Notes connector for Claude on the phone).
# Restarts it if it ever stops. Started hidden at sign-in by
# scripts\phone-server.vbs (a copy sits in the Startup folder).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:APPDATA 'notesapp\phone-server.log'
Set-Location $repo
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
  "---- start $(Get-Date -Format s)" | Out-File -FilePath $log -Append -Encoding utf8
  & node server/phone-server.mjs *>> $log
  "---- stopped $(Get-Date -Format s) (exit $LASTEXITCODE), restarting in 5 s" | Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 5
}
