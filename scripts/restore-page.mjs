/**
 * Brings back cells from an older copy of a page (for example a version
 * downloaded from Google Drive's version history) after they were deleted.
 *
 * Deleted cells leave tombstones that are newer than the old cells, so simply
 * copying the old file back would delete them again on the next sync. This
 * gives every restored cell a version newer than its tombstone, so it wins
 * everywhere.
 *
 * Close the Notes app first.
 *
 *   node scripts/restore-page.mjs <old-copy.json> [--vault <folder>] [--dry]
 *
 * The vault defaults to the one in %APPDATA%\notesapp\config.json. The current
 * page file is backed up to .trash before it is replaced.
 */
import fs from 'node:fs'
import path from 'node:path'
import { vvJoin, vvBump } from '../shared/sync-core.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const vi = args.indexOf('--vault')
const oldFile = args.find((a, i) => !a.startsWith('--') && (vi < 0 || i !== vi + 1))
if (!oldFile) {
  console.error('usage: node scripts/restore-page.mjs <old-copy.json> [--vault <folder>] [--dry]')
  process.exit(1)
}

const appData = process.env.APPDATA || ''
const stateDir = path.join(appData, 'notesapp')
const vault = vi >= 0 ? args[vi + 1] : JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).vault
const device = fs.readFileSync(path.join(stateDir, 'sync', 'device-id'), 'utf8').trim()

const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'))
const pageFile = path.join(vault, 'pages', `${old.id}.json`)
const cur = JSON.parse(fs.readFileSync(pageFile, 'utf8'))
if (cur.id !== old.id) throw new Error('the old copy is a different page')

const have = new Set((cur.cells || []).map((c) => c.id))
const tombstones = { ...(cur.tombstones || {}) }
const restored = []
for (const c of old.cells || []) {
  if (have.has(c.id)) continue
  const vv = vvBump(vvJoin(c.vv, tombstones[c.id]), device)
  delete tombstones[c.id]
  restored.push({ ...c, vv, updatedAt: Date.now() })
}

const page = { ...cur, cells: [...(cur.cells || []), ...restored], tombstones, updatedAt: Date.now() }
console.log(`page "${cur.title}" (${cur.id}): ${restored.length} cell(s) to restore, ${have.size} kept`)
for (const c of restored) console.log(`  ${c.id}  ${(c.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)}`)
if (dry || !restored.length) process.exit(0)

const backup = path.join(vault, '.trash', `${cur.id}-before-restore-${Date.now()}.json.bak`)
fs.mkdirSync(path.dirname(backup), { recursive: true })
fs.copyFileSync(pageFile, backup)
const text = JSON.stringify(page, null, 2)
fs.writeFileSync(`${pageFile}.restore.tmp`, text, 'utf8')
fs.renameSync(`${pageFile}.restore.tmp`, pageFile)
console.log(`restored. previous file saved as ${backup}`)
