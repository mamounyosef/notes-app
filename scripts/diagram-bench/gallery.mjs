// Writes "Open me - Gallery.html" and "Results.csv" into the benchmark's
// output folder from every job's meta.json: per task, a grid of models
// (rows) by engines (columns), each picture linking to its full size,
// source and log. Usage alone: node scripts/diagram-bench/gallery.mjs config.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const safe = (s) => String(s).replace(/[<>:"/\\|?*]+/g, '-').trim()
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const href = (...p) => p.map((x) => encodeURIComponent(x)).join('/')

export function writeGallery(cfg) {
  const OUT = cfg.out
  const rows = []
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Diagram engine test</title><style>
body{font:14px/1.45 'Segoe UI',system-ui,sans-serif;background:#1b1b1d;color:#e6e6e6;margin:0;padding:24px}
h1{margin:0 0 6px}h2{margin:36px 0 10px;border-bottom:1px solid #3a3a3e;padding-bottom:6px}
.note{color:#a5a5a5;max-width:980px}
table{border-collapse:collapse}th,td{border:1px solid #3a3a3e;padding:6px;vertical-align:top}
th{background:#26262a;position:sticky;top:0;z-index:1}td.m{white-space:nowrap;font-weight:600;background:#222225}
.cell{width:300px}.cell img{max-width:300px;max-height:380px;display:block;background:#2a2a2e;border-radius:6px}
.st{font-size:12px;margin-top:4px;color:#a5a5a5}.ok{color:#98c379}.bad{color:#e06c75}.warn{color:#e5c07b}
.ref img{max-width:420px;max-height:420px;border-radius:6px;background:#fff}
a{color:#7c9cff}</style></head><body>
<h1>Diagram engine test</h1>
<p class="note">Each picture was made by the Notes assistant itself (its own prompt, tools, automatic checks and fix rounds), asked to draw the task with one engine. Theme: ${esc(cfg.theme || 'dark')}. Click a picture for full size; "src" is the exact source the model wrote, "log" the whole conversation, "page" how the note looked. Generated ${new Date().toLocaleString()}.</p>`
  for (const t of cfg.tasks) {
    const tdir = safe(`${t.order} ${t.name}`)
    html += `<h2>${esc(t.order)}. ${esc(t.name)}</h2>`
    if (t.ref) html += `<div class="ref"><a href="${href('References', `${safe(t.name)}.png`)}"><img src="${href('References', `${safe(t.name)}.png`)}"></a></div>`
    else html += `<p class="note">Text only prompt: ${esc(t.prompt)}</p>`
    html += `<table><tr><th>Model</th>${cfg.engines.map((e) => `<th>${esc(e.name)}</th>`).join('')}</tr>`
    for (const m of cfg.models) {
      if (m.tasks && !m.tasks.includes(t.id)) continue
      html += `<tr><td class="m">${esc(m.name)}<div class="st">${esc(m.id)}</div></td>`
      for (const e of cfg.engines) {
        const dir = path.join(OUT, tdir, safe(e.name))
        const base = safe(m.name)
        const mf = path.join(dir, `${base} - meta.json`)
        if (!fs.existsSync(mf)) {
          html += `<td class="cell"><div class="st">not run yet</div></td>`
          continue
        }
        const meta = JSON.parse(fs.readFileSync(mf, 'utf8'))
        const cls = meta.status === 'ok' ? 'ok' : /error|no drawing/.test(meta.status) ? 'bad' : 'warn'
        const rel = (f) => href(tdir, safe(e.name), f)
        let cell = ''
        for (const d of meta.drawings || []) cell += `<a href="${rel(d.big || d.png)}"><img src="${rel(d.png)}" loading="lazy"></a>`
        const lint = (meta.drawings || []).reduce((n, d) => n + (d.lint?.length || 0), 0)
        const tools = meta.tools || {}
        cell += `<div class="st"><span class="${cls}">${esc(meta.status)}</span> · ${meta.seconds ?? '?'}s · ${meta.requests ?? '?'} requests · ${tools.check_drawing || 0} checks · ${tools.update_drawing || 0} fixes${lint ? ` · ${lint} measured problems left` : ''}</div>`
        if (meta.error) cell += `<div class="st bad">${esc(String(meta.error).slice(0, 220))}</div>`
        cell += `<div class="st">${(meta.drawings || []).map((d) => `${d.big ? `<a href="${rel(d.big)}">large</a> ` : ""}<a href="${rel(d.src)}">src</a>`).join(" ")} <a href="${rel(`${base} - log.txt`)}">log</a>${meta.pageShot ? ` <a href="${rel(meta.pageShot)}">page</a>` : ''}</div>`
        html += `<td class="cell">${cell}</td>`
        rows.push([t.name, e.name, m.name, m.id, meta.status, meta.seconds, meta.requests, tools.check_drawing || 0, tools.update_drawing || 0, lint, (meta.drawings || []).map((d) => d.kind).join('+'), String(meta.error || '').replace(/[\r\n,]+/g, ' ').slice(0, 200)])
      }
      html += `</tr>`
    }
    html += `</table>`
  }
  html += `</body></html>`
  fs.writeFileSync(path.join(OUT, 'Open me - Gallery.html'), html)
  const csv = [['task', 'engine', 'model', 'model id', 'status', 'seconds', 'requests', 'checks', 'fixes', 'measured problems left', 'kinds drawn', 'error'], ...rows].map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
  fs.writeFileSync(path.join(OUT, 'Results.csv'), csv)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  writeGallery(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))
}
