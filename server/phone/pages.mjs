// Mobile-first HTML pages. No scripts; every link and form target is relative.
import { escapeHtml as e } from './util.mjs'

const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:#0f1115;color:#e7e9ee;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:440px}
.logo{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#7c5cff,#3fb6ff);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#fff;margin-bottom:20px;box-shadow:0 8px 24px rgba(124,92,255,.35)}
h1{font-size:26px;line-height:1.2;margin:0 0 6px}
.sub{color:#9aa1ad;margin:0 0 24px}
.card{background:#171a21;border:1px solid #262a33;border-radius:16px;padding:20px;margin-bottom:16px}
label{display:block;font-size:14px;color:#9aa1ad;margin-bottom:8px}
input[type=password],input[type=text]{width:100%;font-size:20px;padding:14px 16px;border-radius:12px;border:1px solid #333845;background:#0f1115;color:#fff;outline:none}
input:focus{border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.25)}
.btn{display:block;width:100%;text-align:center;font-size:18px;font-weight:600;padding:16px;border-radius:12px;border:0;background:#7c5cff;color:#fff;text-decoration:none;cursor:pointer;margin-top:16px}
.btn:active{transform:scale(.99)}
.link{display:block;text-align:center;color:#9aa1ad;margin-top:14px;text-decoration:none;padding:8px}
.err{background:#3a1d22;border:1px solid #6b2a33;color:#ffb4bd;border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:15px}
.meta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:15px}
.meta dt{color:#9aa1ad}.meta dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.notes{white-space:pre-wrap;color:#c9cdd6;font-size:15px;margin:0}
ol{padding-left:20px;margin:0;color:#c9cdd6}ol li{margin:6px 0}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:#9aa1ad;margin:0 0 12px}
.app{color:#fff;font-weight:600;word-break:break-word}
.foot{color:#5f6673;font-size:13px;text-align:center;margin-top:24px}
`

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><title>${e(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`
}

const err = (msg) => (msg ? `<div class="err" role="alert">${e(msg)}</div>` : '')

export function loginPage({ error } = {}) {
  return layout(
    'Notes for Android',
    `<div class="logo">N</div><h1>Notes for Android</h1><p class="sub">Enter your passcode to download the app.</p>${err(error)}
<form class="card" method="post" action="login" autocomplete="off">
<label for="p">Passcode</label>
<input id="p" name="passcode" type="password" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required>
<button class="btn" type="submit">Continue</button>
</form>`,
  )
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return 'unknown'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function downloadPage(info) {
  const steps = `<div class="card"><h2>How to install</h2><ol>
<li>Tap <b>Download Notes.apk</b>.</li>
<li>Open the downloaded file. The first time, Android asks to allow Chrome to <b>Install unknown apps</b>: allow it once.</li>
<li>Tap <b>Install</b>, then open Notes.</li>
<li>Later updates install from inside the app. You do not need this page again.</li>
</ol></div>`
  if (!info)
    return layout(
      'Notes for Android',
      `<div class="logo">N</div><h1>Notes for Android</h1><p class="sub">No APK has been published yet. Check back after the next release.</p>`,
    )
  return layout(
    'Notes for Android',
    `<div class="logo">N</div><h1>Notes for Android</h1><p class="sub">Version ${e(info.versionName || '?')}</p>
<div class="card"><dl class="meta">
<dt>Version</dt><dd>${e(info.versionName || '?')} (${e(info.versionCode ?? '?')})</dd>
<dt>Size</dt><dd>${e(fmtSize(info.size))}</dd>
<dt>Published</dt><dd>${e(fmtDate(info.publishedAt))}</dd>
</dl>
<a class="btn" href="notes.apk" download="Notes.apk">Download Notes.apk</a></div>
${info.notes ? `<div class="card"><h2>What is new</h2><p class="notes">${e(info.notes)}</p></div>` : ''}
${steps}<p class="foot">Private download. Do not share this page.</p>`,
  )
}

export function authorizePage({ clientName, signed, error, denyHref }) {
  return layout(
    'Connect Claude to your Notes',
    `<div class="logo">N</div><h1>Connect Claude to your Notes</h1>
<p class="sub"><span class="app">${e(clientName || 'An app')}</span> wants to read and edit your notes through the Notes app on your PC.</p>${err(error)}
<form class="card" method="post" action="authorize" autocomplete="off">
<input type="hidden" name="p" value="${e(signed)}">
<label for="p">Passcode</label>
<input id="p" name="passcode" type="password" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required>
<button class="btn" type="submit">Approve</button>
</form>
<a class="link" href="${e(denyHref)}">Deny</a>`,
  )
}

export function messagePage(title, message) {
  return layout(title, `<div class="logo">N</div><h1>${e(title)}</h1><p class="sub">${e(message)}</p>`)
}
