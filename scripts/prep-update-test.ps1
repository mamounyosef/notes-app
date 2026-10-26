# Clones Notes from GitHub into a throwaway folder and builds the packaged app there, like a
# second computer that last updated at the current commit. Then push a newer commit and run
#   node scripts/test-update.mjs <folder>
# Not under %TEMP%: this PC clears old files there, which can empty the copy mid test.
param([string]$Dir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'notes-update-test'))
# Exit codes decide: tools print warnings on stderr.
$ErrorActionPreference = 'Continue'
if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
git clone --quiet https://github.com/mamounyosef/notes-app.git $Dir
Set-Location $Dir
git log -1 --format='%h %s'
npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icon.ps1
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-wincodesign.ps1
npx electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw 'packaging failed' }
Get-Item release\win-unpacked\Notes.exe | Select-Object FullName, LastWriteTime
