# Puts a Notes shortcut on the desktop and in the start menu.
# No admin rights needed.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$packaged = Join-Path $root 'release\win-unpacked\Notes.exe'
$icon = Join-Path $root 'build\icon.ico'

# The packaged app when there is one (what setup.bat builds), else Electron on this folder.
$usePackaged = Test-Path $packaged
if (-not $usePackaged -and -not (Test-Path $electron)) { throw "Electron is missing. Run setup.bat first." }
if (-not (Test-Path $icon)) { $icon = if ($usePackaged) { $packaged } else { $electron } }

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Notes.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Notes.lnk')
)

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $t) | Out-Null
  $sc = $shell.CreateShortcut($t)
  if ($usePackaged) {
    $sc.TargetPath = $packaged
    $sc.Arguments = ''
    $sc.WorkingDirectory = Split-Path -Parent $packaged
  } else {
    $sc.TargetPath = $electron
    $sc.Arguments = '.'
    $sc.WorkingDirectory = $root
  }
  $sc.IconLocation = "$icon,0"
  $sc.Description = 'Notes'
  $sc.WindowStyle = 1
  $sc.Save()
  Write-Host "Created $t"
}
