# electron-builder unpacks its winCodeSign helper with symlinks that Windows
# only allows for admins or with developer mode on. Only the windows folder is
# needed on this machine, so extract that part and leave a ready cache behind.
$ErrorActionPreference = 'Stop'

$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
if (-not (Test-Path $cache)) {
  Write-Host 'Nothing cached yet. Run the build once so the archive is downloaded, then run this.'
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$sevenZip = Join-Path $root 'node_modules\7zip-bin\win\x64\7za.exe'
if (-not (Test-Path $sevenZip)) { throw "7za.exe not found at $sevenZip" }

$archives = Get-ChildItem $cache -Filter '*.7z'
if (-not $archives) { Write-Host 'No archive found.'; exit 0 }

foreach ($a in $archives) {
  $dest = Join-Path $cache $a.BaseName
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  # Only the windows tools matter here; the mac folder holds the symlinks.
  & $sevenZip x $a.FullName "-o$dest" 'windows\*' -r -y | Out-Null
  Write-Host "Prepared $dest"
}

Write-Host 'Done. Run the build again.'
