import React, { useEffect, useState } from 'react'
import { agentApi, type KeyInfo } from '../../agent/api'
import { thinkSettingOf, useAgent } from '../../agent/store'
import { MODELS, DEFAULT_MODEL, PROVIDER_LABEL, canStopThinking, modelInfo, fmtCtx, paramsLabel, type Provider } from '../../agent/models'
import { ThinkLevels } from './ThinkControl'

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * One service's API keys, kept on this computer only. They are tried in
 * order: when one runs out of credit the next key of the same service is used.
 */
function KeyRow({ provider, hint }: { provider: Provider; hint: string }) {
  const [keys, setKeys] = useState<KeyInfo[] | null>(null)
  const [limits, setLimits] = useState<string[]>([])
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const s = await agentApi.keyStatus(provider)
    const list = s.keys || (s.hasKey ? [{ masked: s.masked, outUntil: null, detail: '' }] : [])
    setKeys(list)
    if (provider === 'openrouter')
      setLimits(
        await Promise.all(
          list.map((_, i) => agentApi.openrouterLimits(i).then((l) => (l.ok && l.freeLimit ? ` Free requests today: ${l.freeUsed ?? 0} of ${l.freeLimit} used.` : ''))),
        ),
      )
  }
  useEffect(() => {
    refresh()
  }, [])

  const act = async (job: () => Promise<{ ok: boolean; error?: string; info?: string }>, done: string | ((r: { info?: string }) => string)) => {
    setBusy(true)
    setMsg('')
    const r = await job()
    setBusy(false)
    if (!r.ok) {
      setMsg(r.error || 'Could not save the key.')
      refresh()
    } else {
      setMsg(typeof done === 'function' ? done(r) : done)
      refresh()
      useAgent.getState().refreshKey()
    }
  }
  const add = () => act(() => agentApi.addKey(key.trim(), provider).then((r) => (r.ok && setKey(''), r)), 'Key saved.')

  const list = keys || []
  return (
    <>
      <div className="set-row">
        <label>
          {PROVIDER_LABEL[provider]} API keys
          <span className="sub">
            {list.length
              ? `Saved on this computer, encrypted by Windows. Tried in order: when one runs out of credit, the next ${PROVIDER_LABEL[provider]} key is used.`
              : `Not set. ${hint}`}
          </span>
        </label>
        <div className="row-inline">
          <input
            type="password"
            placeholder={list.length ? 'Add another key' : 'Paste key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && !busy && add()}
            style={{ width: 200 }}
          />
          <button className="btn" disabled={!key.trim() || busy} onClick={add}>{busy ? 'Checking...' : 'Add'}</button>
        </div>
      </div>
      {list.map((k, i) => (
        <div className="set-row" key={`${k.masked}-${i}`} style={{ paddingLeft: 16 }}>
          <label>
            Key {i + 1}: {k.masked}{' '}
            <b style={{ color: k.inUse ? 'var(--ok, #3fb950)' : k.outUntil ? 'var(--danger, #f85149)' : 'inherit', fontWeight: 600 }}>
              {k.inUse ? (k.outUntil ? 'In use, but out of credit' : 'In use') : k.outUntil ? 'Out of credit' : 'Backup'}
            </b>
            <span className="sub">
              {k.outUntil ? `Skipped until ${timeOf(k.outUntil)}, then tried again. ${k.detail}` : k.inUse ? 'Requests go to this key.' : 'Used if the keys above it run out.'}
              {limits[i] || ''}
            </span>
          </label>
          <div className="row-inline">
            {!k.inUse && <button className="btn" disabled={busy} title="Use this key from now on" onClick={() => act(() => agentApi.useKey(provider, i), `Key ${i + 1} is now in use.`)}>Use</button>}
            <button className="btn" disabled={busy} title="Ask the service whether this key works now" onClick={() => act(() => agentApi.testKey(provider, i).then((r) => (r.ok ? r : { ...r, error: `Key ${i + 1}: ${r.error}` })), (r) => `Key ${i + 1}: ${r.info || 'Works.'}`)}>Test</button>
            <button className="btn danger" disabled={busy} onClick={() => act(() => agentApi.removeKey(provider, i), 'Key removed.')}>Remove</button>
          </div>
        </div>
      ))}
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
          Thinking
          <span className="sub">
            {canStopThinking(modelInfo(prefs.model).think) ? 'Deeper is slower, but better at multi step changes.' : `${modelInfo(prefs.model).name} always thinks on ${PROVIDER_LABEL[modelInfo(prefs.model).provider]}.`} Kept per model. Also in the chat box.
          </span>
        </label>
        <ThinkLevels compact spec={modelInfo(prefs.model).think} value={thinkSettingOf(prefs, prefs.model).level} onPick={(level) => useAgent.getState().setThink(prefs.model, { level })} />
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
        Keys stay on each computer, so enter them on the laptop too. Each service only uses its own keys: a model never
        moves to the other service.
      </div>
    </div>
  )
}
