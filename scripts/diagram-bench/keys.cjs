// Reads the app's saved Ollama and OpenRouter keys, kept in memory only.
// Must run inside Electron: the keys are encrypted with safeStorage, whose
// master key sits in the app's "Local State". That file and the key files are
// copied to a private user data folder so the running Notes app is untouched.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SRC = path.join(process.env.APPDATA, 'notesapp')
const UD = path.join(os.tmpdir(), 'notes-diagram-bench-ud')
fs.mkdirSync(UD, { recursive: true })
for (const f of ['Local State', 'ollama-key.bin', 'ollama-keys.bin', 'openrouter-key.bin', 'openrouter-keys.bin']) {
  try { fs.copyFileSync(path.join(SRC, f), path.join(UD, f)) } catch { /* not saved */ }
}
app.setPath('userData', UD)

function read(p) {
  const dec = (raw) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'))
  try {
    const list = JSON.parse(dec(fs.readFileSync(path.join(UD, `${p}-keys.bin`))))
    if (Array.isArray(list) && list.length) return list.map((k) => String(k).trim()).filter(Boolean)
  } catch { /* no list */ }
  try {
    const one = dec(fs.readFileSync(path.join(UD, `${p}-key.bin`))).trim()
    if (one) return [one]
  } catch { /* none */ }
  return []
}

/** Call after app 'ready'. */
function readKeys() {
  return { ollama: read('ollama'), openrouter: read('openrouter') }
}

module.exports = { readKeys, UD }
