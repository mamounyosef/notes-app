// Builds and publishes the Android app.
//
//   node mobile/scripts/publish.mjs            web update (over the air, most changes)
//   node mobile/scripts/publish.mjs --apk      new APK too (native changes: plugins,
//                                               permissions, capacitor.config); bump
//                                               mobile/native-version.json first
//   node mobile/scripts/publish.mjs --apk --demo --no-publish
//                                               test APK with demo notes, not published
//   --notes "text"                              what changed (shown on the phone)
//
// The phone server serves release-phone/ at https://<host>/notes.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zipDir } from './zip.mjs'

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(mobile, '..')
const release = path.join(repo, 'release-phone')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const arg = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : '')
const apk = has('--apk')
const demo = has('--demo')
const publish = !has('--no-publish')
const notes = arg('--notes')

const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', cwd: mobile, ...opts })
const node = process.execPath
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

if (demo && publish) {
  console.error('A demo build is never published. Add --no-publish.')
  process.exit(1)
}

// 1. Config (version stamp), typecheck (a bundle that does not compile would break the app), build.
run(node, [path.join(mobile, 'scripts', 'build-config.mjs')], { cwd: repo })
const cfg = JSON.parse(fs.readFileSync(path.join(mobile, 'src', 'generated', 'config.json'), 'utf8'))
console.log('\n> typecheck')
run(node, [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'])
console.log('\n> web build')
run(node, [path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', ...(demo ? ['--mode', 'demo'] : [])])

const nativeVersion = JSON.parse(fs.readFileSync(path.join(mobile, 'native-version.json'), 'utf8'))

// 2. APK (only when asked).
if (apk) {
  console.log('\n> capacitor sync')
  run('npx.cmd', ['cap', 'sync', 'android'], { shell: true })
  console.log('\n> gradle assembleRelease')
  const env = { ...process.env }
  env.JAVA_HOME = 'C:\\Users\\mamou\\dev-tools\\jdk\\jdk-21.0.13+9'
  env.ANDROID_HOME ||= 'C:\\Users\\mamou\\dev-tools\\android-sdk'
  execSync(`"${path.join(mobile, 'android', 'gradlew.bat')}" assembleRelease --console=plain`, { stdio: 'inherit', cwd: path.join(mobile, 'android'), env, shell: 'cmd.exe' })
  const built = path.join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  if (!fs.existsSync(built)) throw new Error('No signed APK was built (is mobile/keystore.properties there? run make-keystore.mjs)')
  const out = path.join(mobile, 'android', 'app', 'release')
  fs.mkdirSync(out, { recursive: true })
  const name = demo ? 'notes-demo.apk' : 'notes.apk'
  fs.copyFileSync(built, path.join(out, name))
  console.log(`APK: ${path.join(out, name)} (${(fs.statSync(built).size / 1048576).toFixed(1)} MB)`)
  if (publish) {
    fs.mkdirSync(release, { recursive: true })
    const tmp = path.join(release, 'notes.apk.tmp')
    fs.copyFileSync(built, tmp)
    fs.renameSync(tmp, path.join(release, 'notes.apk'))
    const info = {
      versionCode: nativeVersion.versionCode,
      versionName: nativeVersion.versionName,
      sha256: sha256(path.join(release, 'notes.apk')),
      size: fs.statSync(path.join(release, 'notes.apk')).size,
      publishedAt: new Date().toISOString(),
      notes: notes || nativeVersion.notesForRelease || '',
    }
    fs.writeFileSync(path.join(release, 'apk.json'), JSON.stringify(info, null, 2))
    console.log('APK published at /notes')
  }
}

// 3. Web update (over the air).
if (publish) {
  const ota = path.join(release, 'ota')
  fs.mkdirSync(ota, { recursive: true })
  const file = `bundle-${cfg.bundleVersion}.zip`
  const n = zipDir(path.join(mobile, 'www'), path.join(ota, file))
  const manifest = {
    version: cfg.bundleVersion,
    minNativeVersion: nativeVersion.versionCode,
    sha256: sha256(path.join(ota, file)),
    size: fs.statSync(path.join(ota, file)).size,
    publishedAt: new Date().toISOString(),
    notes,
    file,
  }
  const tmp = path.join(ota, 'manifest.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2))
  fs.renameSync(tmp, path.join(ota, 'manifest.json'))
  // Keep the last 5 bundles.
  const old = fs.readdirSync(ota).filter((f) => /^bundle-.*\.zip$/.test(f)).sort()
  for (const f of old.slice(0, -5)) fs.rmSync(path.join(ota, f))
  console.log(`Web update ${cfg.bundleVersion} published (${n} files, ${(manifest.size / 1048576).toFixed(1)} MB)`)
}
