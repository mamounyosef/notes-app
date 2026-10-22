import React, { useEffect, useState } from 'react'
import { agentApi } from '../../agent/api'
import { useAgent } from '../../agent/store'
import { MODELS, DEFAULT_MODEL, PROVIDER_LABEL, modelInfo, fmtCtx, paramsLabel, type Provider } from '../../agent/models'

/** One service's API key, kept on this computer only. */
function KeyRow({ provider, hint }: { provider: Provider; hint: string }) {
  const [status, setStatus] = useState<{ hasKey: boolean; masked: string } | null>(null)
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const [limits, setLimits] = useState('')
  const [out, setOut] = useState('')
  const refresh = () => {
    agentApi.keyStatus(provider).then(setStatus)
    const other = PROVIDER_LABEL[provider === 'ollama' ? 'openrouter' : 'ollama']
    agentApi.creditStatus().then((list) => {
      const e = list.find((x) => x.provider === provider)
      setOut(e ? ` Out of credit: using ${other} until ${new Date(e.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '')
    })
    if (provider === 'openrouter')
      agentApi.openrouterLimits().then((l) => setLimits(l.ok && l.freeLimit ? ` Free requests today: ${l.freeUsed ?? 0} of ${l.freeLimit} used.` : ''))
  }
  useEffect(() => {
    refresh()
  }, [])

  const save = async (value: string) => {
    setBusy(true)
    setMsg('')
    const r = await agentApi.setKey(value, provider)
    setBusy(false)
    if (!r.ok) setMsg(r.error || 'Could not save the key.')
    else {
      setKey('')
      setMsg(value ? 'Key saved.' : 'Key removed.')
      refresh()
      useAgent.getState().refreshKey()
    }
  }

  return (
    <>
      <div className="set-row">
        <label>
          {PROVIDER_LABEL[provider]} API key
          <span className="sub">
            {status?.hasKey ? `Saved on this computer (${status.masked}), encrypted by Windows.${limits}${out}` : `Not set. ${hint}`}
          </span>
        </label>
        <div className="row-inline">
          <input type="password" placeholder={status?.hasKey ? 'Replace key' : 'Paste key'} value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 200 }} />
          <button className="btn" disabled={!key.trim() || busy} onClick={() => save(key.trim())}>{busy ? 'Checking...' : 'Save'}</button>
          {status?.hasKey && <button className="btn danger" disabled={busy} onClick={() => save('')}>Remove</button>}
        </div>
      </div>
      {msg && <div className="empty-hint" style={{ padding: '2px 0 8px' }}>{msg}</div>}
    </>
  )
}

/** Settings, AI: the service keys (this computer only), model and thinking. */
export default function AiSettings() {
  const prefs = useAgent((s) => s.prefs)
  const setPrefs = useAgent((s) => s.setPrefs)
  return (
    <div className="set-group ai-settings">
      <h3>Assistant</h3>
      <KeyRow provider="ollama" hint="Create one at ollama.com, Settings, Keys." />
      <KeyRow provider="openrouter" hint="For the free OpenRouter models. Create one at openrouter.ai, Keys." />
      <div className="set-row">
        <label>
          Model
          <span className="sub">{paramsLabel(modelInfo(prefs.model))}, {fmtCtx(modelInfo(prefs.model).context)} context. Default {modelInfo(DEFAULT_MODEL).name}. Also in the chat box.</span>
        </label>
        <select value={prefs.model} onChange={(e) => setPrefs({ model: e.target.value })} style={{ width: 200 }}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.name} ({PROVIDER_LABEL[m.provider]})</option>
          ))}
        </select>
      </div>
      <div className="set-row">
        <label>
          Think before answering
          <span className="sub">Slower, but better at multi step changes.</span>
        </label>
        <input type="checkbox" checked={prefs.think} onChange={(e) => setPrefs({ think: e.target.checked })} />
      </div>
      <div className="set-row">
        <label>
          Show the reasoning
          <span className="sub">A collapsed "Thought for 3s" row above each reply.</span>
        </label>
        <input type="checkbox" checked={prefs.showThinking} onChange={(e) => setPrefs({ showThinking: e.target.checked })} />
      </div>
      <div className="empty-hint" style={{ padding: '6px 0' }}>
        Ctrl+J opens the assistant, Ctrl+L sends the selection to it. Chats sync between your computers through cloud sync.
        Keys stay on each computer, so enter them on the laptop too. With both keys saved, a model whose service runs
        out of credit switches to the same model (or Gemma 4 31B) on the other service, and switches back once it has credit again.
      </div>
    </div>
  )
}
