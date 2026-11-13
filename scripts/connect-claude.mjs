// Registers the Notes MCP server with the Claude desktop app and Claude Code,
// the same as Settings, AI, Connect in the app (for when the app is not at hand).
//   node scripts/connect-claude.mjs [desktop|code|both] [--off] [--exe <Notes.exe>]
// Restart the Claude desktop app afterwards to load it.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const target = ['desktop', 'code', 'both'].includes(args[0]) ? args[0] : 'both'
const off = args.includes('--off')
const exeArg = args.indexOf('--exe')
const exe = exeArg >= 0 ? args[exeArg + 1] : path.resolve(HERE, '../release/win-unpacked/Notes.exe')
const dataDir = path.join(process.env.APPDATA, 'notesapp')
const shim = path.join(dataDir, 'notes-mcp.cjs')
const link = path.join(dataDir, 'claude-link.json')

if (!off) {
  if (!fs.existsSync(exe)) throw new Error(`Notes.exe not found: ${exe}`)
  // Notes writes the bridge on start; write it here too so this works before the first start.
  fs.mkdirSync(dataDir, { recursive: true })
  fs.copyFileSync(path.resolve(HERE, '../electron/notes-mcp.cjs'), shim)
}
const entry = { command: exe, args: [shim, link], env: { ELECTRON_RUN_AS_NODE: '1' } }

if (target !== 'code') {
  const file = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
  const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.notes-backup`)
  j.mcpServers = { ...(j.mcpServers || {}) }
  if (off) delete j.mcpServers.notes
  else j.mcpServers.notes = entry
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(j, null, 2))
  console.log(`Claude app: ${off ? 'removed from' : 'added to'} ${file}`)
}

if (target !== 'desktop') {
  const run = (a) => {
    try {
      return execFileSync(process.platform === 'win32' ? 'claude.exe' : 'claude', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return String(e.stdout || '') + String(e.stderr || '')
    }
  }
  run(['mcp', 'remove', 'notes', '--scope', 'user'])
  if (!off) {
    console.log(run(['mcp', 'add-json', 'notes', JSON.stringify({ type: 'stdio', ...entry }), '--scope', 'user']).trim())
  }
  console.log(`Claude Code: ${off ? 'removed' : 'added'} (user scope)`)
}
