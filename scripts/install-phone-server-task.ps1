# Registers the "Notes Phone Server Watchdog" scheduled task for the current user:
# runs scripts\phone-server.vbs at sign-in and every 2 minutes, so the Notes and
# Planner connectors come back on their own after a reboot, a crash or a kill.
# Safe to re-run (replaces the task). Usage: powershell -File scripts\install-phone-server-task.ps1
$ErrorActionPreference = 'Stop'
$name = 'Notes Phone Server Watchdog'
$vbs = Join-Path $PSScriptRoot 'phone-server.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $every) -Settings $settings `
  -Principal $principal -Description 'Keeps the Notes phone server (Claude connectors for Notes and Planner) running.' -Force | Out-Null
Write-Output "Registered '$name'."
