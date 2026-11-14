// Creates the Android signing key once (kept outside the repo, in
// %APPDATA%\notesapp\android-signing\) and writes mobile/keystore.properties
// (git-ignored) pointing at it. Every APK must be signed with the same key,
// or Android refuses to install it as an update. Back that folder up.
// Usage: node mobile/scripts/make-keystore.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(process.env.APPDATA, 'notesapp', 'android-signing')
const store = path.join(dir, 'notes-release.keystore')
const secretFile = path.join(dir, 'keystore.json')
const props = path.join(mobile, 'keystore.properties')

fs.mkdirSync(dir, { recursive: true })
let secret
if (fs.existsSync(store) && fs.existsSync(secretFile)) {
  secret = JSON.parse(fs.readFileSync(secretFile, 'utf8'))
  console.log('signing key already exists')
} else {
  secret = { password: crypto.randomBytes(18).toString('base64url'), alias: 'notes' }
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe') : 'keytool'
  execFileSync(java, [
    '-genkeypair', '-v', '-keystore', store, '-alias', secret.alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', secret.password, '-keypass', secret.password, '-dname', 'CN=Notes, O=Personal, C=US',
  ], { stdio: 'ignore' })
  fs.writeFileSync(secretFile, JSON.stringify(secret, null, 2))
  console.log('signing key created in', dir)
}
const esc = (p) => p.replace(/\\/g, '/')
fs.writeFileSync(
  props,
  `storeFile=${esc(store)}\nstorePassword=${secret.password}\nkeyAlias=${secret.alias}\nkeyPassword=${secret.password}\n`,
)
console.log('keystore.properties written')
