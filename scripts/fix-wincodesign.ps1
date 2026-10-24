# electron-builder unpacks its winCodeSign helper with symlinks that Windows
# only allows for admins or with developer mode on, so the unpack fails and it
# retries forever. It uses Cache\winCodeSign\winCodeSign-<version> as is when
# that folder exists, so build it here without the mac folder (which holds the
# symlinks) and clear the half unpacked copies its failed tries left behind.
$ErrorActionPreference = 'Stop'

$version = 'winCodeSign-2.6.0'
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
$ready = Join-Path $cache $version
if (Test-Path (Join-Path $ready 'windows-10')) { exit 0 }

$root = Split-Path -Parent $PSScriptRoot
$sevenZip = Join-Path $root 'node_modules\7zip-bin\win\x64\7za.exe'
if (-not (Test-Path $sevenZip)) { throw "7za.exe not found at $sevenZip" }

New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archive = Get-ChildItem $cache -Filter '*.7z' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($archive) {
  $archive = $archive.FullName
} else {
  $archive = Join-Path $cache "$version.7z"
  Write-Host "  Downloading $version."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/electron-userland/electron-builder-binaries/releases/download/$version/$version.7z" -OutFile $archive
}

$tmp = Join-Path $cache "$version.tmp"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
& $sevenZip x $archive "-o$tmp" '-xr!darwin' -y -bd | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tmp 'windows-10'))) { throw "Could not unpack $archive (7-Zip exit code $LASTEXITCODE)" }
if (Test-Path $ready) { Remove-Item -Recurse -Force $ready }
Rename-Item $tmp $version

# The numbered folders and archives are electron-builder's failed tries.
Get-ChildItem $cache | Where-Object { $_.Name -match '^\d+(\.7z)?$' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  Prepared $ready"
