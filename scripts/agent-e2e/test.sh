#!/usr/bin/env bash
# Builds, then runs one e2e scenario with the keys from credentials.txt.
# Usage: bash scripts/agent-e2e/test.sh <scenario name> [--no-build]
# Log and screenshots land in demo-shots/<name>/.
set -u
cd "$(dirname "$0")/../.."
NAME="$1"
OUT="demo-shots/$NAME"
mkdir -p "$OUT"
if [ "${2:-}" != "--no-build" ]; then
  npm run build > "$OUT/build-log.txt" 2>&1 || { tail -5 "$OUT/build-log.txt"; exit 1; }
fi
key() { grep "$1" credentials.txt | sed 's/^[^:]*: *//'; }
export OLLAMA_API_KEY="$(key 'Ollama API key')" OPENROUTER_API_KEY="$(key 'OpenRouter API key')"
timeout 900 node scripts/agent-e2e/run.mjs "scripts/agent-e2e/$NAME.json" > "$OUT/log.txt" 2>&1
rm -f "$OUT"/*.png
cp "$TEMP/notes-agent-e2e/out/"*.png "$OUT/" 2>/dev/null
grep -E "^during|^=== PROMPT|^  (TOOL|ASSISTANT|ERROR)|^EVAL|FAILED" "$OUT/log.txt" | cut -c1-400
