// Writes mobile/src/generated/config.json (git-ignored) for the phone build:
//  - the Supabase project URL and publishable (anon) key, read from this
//    computer's Notes settings (%APPDATA%\notesapp\config.json);
//  - the update address and the app's update token (from the phone server's
//    private state, %APPDATA%\notesapp\phone-server.json);
//  - the web bundle version stamp.
// Never prints the values. Usage: node mobile/scripts/build-config.mjs [--version <v>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mobile = path.resolve(here, '..')
const appData = path.join(process.env.APPDATA || '', 'notesapp')

const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

const cfg = read(path.join(appData, 'config.json'))
const phone = read(path.join(appData, 'phone-server.json'))
const native = read(path.join(mobile, 'native-version.json'))
if (!cfg?.cloud?.url || !cfg?.cloud?.key) {
  console.error('Cloud sync is not set up in the desktop Notes app (Settings, Storage, Cloud sync). Not building.')
  process.exit(1)
}
if (!phone?.otaToken) {
  console.error('The phone server has not run yet (npm run phone-server creates its token). Not building.')
  process.exit(1)
}

const i = process.argv.indexOf('--version')
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const version = i > 0 ? process.argv[i + 1] : stamp()

const out = {
  supabaseUrl: cfg.cloud.url,
  supabaseKey: cfg.cloud.key,
  updateBase: process.env.NOTES_PHONE_PUBLIC_URL || 'https://mamoun.tail27d0a5.ts.net/notes',
  otaToken: phone.otaToken,
  bundleVersion: version,
  nativeVersion: native?.versionCode || 1,
  builtAt: new Date().toISOString(),
}
fs.mkdirSync(path.join(mobile, 'src', 'generated'), { recursive: true })
fs.writeFileSync(path.join(mobile, 'src', 'generated', 'config.json'), JSON.stringify(out, null, 2))
console.log(`config written (bundle ${version}, native ${out.nativeVersion})`)
