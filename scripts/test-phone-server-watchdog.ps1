# Kills the phone server and its supervisor loop, then waits (up to 4 min) for the
# "Notes Phone Server Watchdog" task to bring it back. Prints how long it took.
$port = 4790
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*phone-server-run.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep 2
$down = -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
Write-Output "Killed, port down: $down"
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 240) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/robots.txt" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { Write-Output ("Back after {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds); exit 0 }
  } catch {}
  Start-Sleep 5
}
Write-Output 'NOT back after 240 s'; exit 1
