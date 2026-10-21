# Speech engine (for computers without the weekly planner)

Voice mode hears with Whisper and speaks with Kokoro through `speech-server.py`.
On the PC, Notes uses the weekly planner's engine (on the GPU) and this folder
is not used. On a computer without the planner (the laptop), `setup.bat` runs
`setup-speech.ps1`, which fills this folder:

- `.venv-speech/` Python with the CPU libraries (`requirements.txt`, about 0.5 GB)
- `speech-models/` Kokoro (`kokoro-v1.0.onnx`, `voices-v1.0.bin`, about 0.35 GB)
  and Whisper small.en in `speech-models/hf` (about 0.5 GB)

Both are git-ignored. Re-running the setup only adds what is missing.

`speech-server.py` here is a COPY of the weekly planner's (repo root there), so
both computers run the same engine. Change it in the planner, then copy it here.
