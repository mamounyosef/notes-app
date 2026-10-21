# Voice mode's speech engine, on a computer without the weekly planner.
#
# Called by setup.bat. Idempotent: every step checks first, so running it again
# after a pull only does what is missing. Never fails the Notes setup: voice
# mode is optional, so on any problem it says what happened and exits 0.
#
# On the PC, Notes uses the planner's engine (GPU) and this does nothing.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$venv = Join-Path $here '.venv-speech'
$py = Join-Path $venv 'Scripts\python.exe'
$models = Join-Path $here 'speech-models'

function Say($m) { Write-Host "         $m" }

# The planner's engine next to Notes (the PC): nothing to do here.
foreach ($dir in @((Split-Path -Parent $root), (Join-Path (Split-Path -Parent $root) 'weekly-planner'), 'D:\My Projects\weekly-planner')) {
  if ((Test-Path (Join-Path $dir 'speech-server.py')) -and (Test-Path (Join-Path $dir '.venv-speech\Scripts\python.exe')) -and (Test-Path (Join-Path $dir 'speech-models\kokoro-v1.0.onnx'))) {
    Say "The weekly planner's speech engine is on this computer ($dir); Notes uses that one."
    exit 0
  }
}

try {
  # 1. Python 3.10 to 3.13 (kokoro-onnx needs that range).
  if (-not (Test-Path $py)) {
    $base = $null
    foreach ($v in @('3.12', '3.11', '3.13', '3.10')) {
      try { $p = (& py "-$v" -c "import sys; print(sys.executable)" 2>$null); if ($LASTEXITCODE -eq 0 -and $p) { $base = $p.Trim(); break } } catch { }
    }
    if (-not $base) {
      try {
        $p = (& python -c "import sys; print(sys.executable if (3,10) <= sys.version_info[:2] <= (3,13) else '')" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $p -and $p.Trim()) { $base = $p.Trim() }
      } catch { }
    }
    if (-not $base) {
      Say 'Python 3.12 was not found. Installing it with winget.'
      winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements | Out-Host
      $cand = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
      if (Test-Path $cand) { $base = $cand }
    }
    if (-not $base) { throw 'Python 3.10 to 3.13 is needed. Install Python 3.12 from https://www.python.org and run setup.bat again.' }
    Say "Creating the speech engine's Python ($base)."
    & $base -m venv $venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $py)) { throw 'Could not create the Python environment.' }
  }

  # 2. Libraries (CPU only). pip skips what is already installed.
  Say 'Installing the speech libraries (the first time takes a few minutes).'
  & $py -m pip install --disable-pip-version-check -q --upgrade pip | Out-Null
  & $py -m pip install --disable-pip-version-check -q -r (Join-Path $here 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Installing the speech libraries failed (see above).' }

  # 3. Kokoro, the voice.
  New-Item -ItemType Directory -Force -Path $models | Out-Null
  $base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
  foreach ($f in @('kokoro-v1.0.onnx', 'voices-v1.0.bin')) {
    $dest = Join-Path $models $f
    if (-not (Test-Path $dest)) {
      Say "Downloading $f."
      $tmp = "$dest.part"
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri "$base/$f" -OutFile $tmp -UseBasicParsing
      Move-Item -Force $tmp $dest
    }
  }

  # 4. Whisper small.en, the ears (what the engine uses without a GPU).
  Say 'Fetching the Whisper model (small.en).'
  $env:HF_HOME = Join-Path $models 'hf'
  $env:HF_HUB_DISABLE_TELEMETRY = '1'
  & $py -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')"
  if ($LASTEXITCODE -ne 0) { throw 'Fetching the Whisper model failed (see above).' }

  Say 'Voice mode is ready. It runs on this computer''s processor: slower than the PC, still free and local.'
} catch {
  Say "Voice mode was not set up: $($_.Exception.Message)"
  Say 'Notes works without it. Run setup.bat again to retry.'
}
exit 0
