# Makes every way of starting Notes start this build:
#  - creates the desktop and start menu shortcuts,
#  - repoints any other Notes shortcut (pinned taskbar icon, old installer
#    shortcuts, Quick Launch) at it,
#  - refreshes an older installed copy (from the installer) with this build,
#    for anything that still starts that one.
# No admin rights needed.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$packagedDir = Join-Path $root 'release\win-unpacked'
$packaged = Join-Path $packagedDir 'Notes.exe'
$icon = Join-Path $root 'build\icon.ico'

# The packaged app when there is one (what setup.bat builds), else Electron on this folder.
$usePackaged = Test-Path $packaged
if (-not $usePackaged -and -not (Test-Path $electron)) { throw "Electron is missing. Run setup.bat first." }
if (-not (Test-Path $icon)) { $icon = if ($usePackaged) { $packaged } else { $electron } }

$shell = New-Object -ComObject WScript.Shell

function Set-Target($sc) {
  if ($usePackaged) {
    $sc.TargetPath = $packaged
    $sc.Arguments = ''
    $sc.WorkingDirectory = $packagedDir
  } else {
    $sc.TargetPath = $electron
    $sc.Arguments = '.'
    $sc.WorkingDirectory = $root
  }
  $sc.IconLocation = "$icon,0"
  $sc.Description = 'Notes'
  $sc.WindowStyle = 1
  $sc.Save()
}

# 1. The two shortcuts this folder owns.
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Notes.lnk'
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Notes.lnk'
foreach ($t in @($desktop, $startMenu)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $t) | Out-Null
  Set-Target $shell.CreateShortcut($t)
  Write-Host "  Shortcut: $t"
}

# 2. Every other shortcut that starts some copy of Notes.
$installed = New-Object System.Collections.Generic.HashSet[string]
$defaultInstall = Join-Path $env:LOCALAPPDATA 'Programs\notesapp'
if (Test-Path (Join-Path $defaultInstall 'Notes.exe')) { [void]$installed.Add($defaultInstall) }

$places = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu')
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($dir in $places) {
  foreach ($f in Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue) {
    if ($f.FullName -eq $desktop -or $f.FullName -eq $startMenu) { continue }
    try { $sc = $shell.CreateShortcut($f.FullName) } catch { continue }
    $target = [string]$sc.TargetPath
    if (-not $target) { continue }
    $exe = Split-Path -Leaf $target
    $isNotesExe = $exe -ieq 'Notes.exe'
    $isOurElectron = ($exe -ieq 'electron.exe') -and (([string]$sc.WorkingDirectory) -ieq $root -or $target -like "$root\*")
    if (-not ($isNotesExe -or $isOurElectron)) { continue }
    # Notes.exe from some other product: leave it alone.
    if ($isNotesExe -and (Test-Path $target)) {
      $info = (Get-Item $target).VersionInfo
      if ($info.CompanyName -and $info.CompanyName -notmatch 'mamoun') { continue }
      $tdir = Split-Path -Parent $target
      if ($tdir -ine $packagedDir) { [void]$installed.Add($tdir) }
    }
    if ($target -ieq $packaged -and $sc.Arguments -eq '') { continue }
    Set-Target $sc
    Write-Host "  Repointed: $($f.FullName)"
  }
}

# 3. Older installed copies get this build too, so nothing starts old code.
if ($usePackaged) {
  foreach ($dir in $installed) {
    Write-Host "  Updating the installed copy in $dir"
    # /E copies everything without deleting the installer's own files (its uninstaller).
    & robocopy $packagedDir $dir /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "  Could not update $dir (is it open?)" }
  }
  $global:LASTEXITCODE = 0
}

# 4. Let Explorer pick up the new icons.
try { & "$env:SystemRoot\System32\ie4uinit.exe" -show 2>$null } catch {}
exit 0
