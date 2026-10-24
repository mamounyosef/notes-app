// Lists the models your saved keys can use. Usage:
//   node_modules/electron/dist/electron.exe scripts/diagram-bench/list-models.cjs
const { app } = require('electron')
const { readKeys } = require('./keys.cjs')

app.whenReady().then(async () => {
  const keys = readKeys()
  console.log(`keys: ollama ${keys.ollama.length}, openrouter ${keys.openrouter.length}`)
  try {
    const j = await (await fetch('https://ollama.com/api/tags', { headers: { Authorization: `Bearer ${keys.ollama[0]}` } })).json()
    console.log('OLLAMA:', (j.models || []).map((m) => m.name).join(', '))
  } catch (e) { console.log('ollama error', e.message) }
  try {
    const j = await (await fetch('https://openrouter.ai/api/v1/models')).json()
    const ids = (j.data || []).map((m) => `${m.id} $${(+m.pricing.prompt * 1e6).toFixed(2)}/$${(+m.pricing.completion * 1e6).toFixed(2)}`)
    console.log('OPENROUTER:', ids.length)
    console.log(ids.filter((s) => /anthropic|openai\/gpt-5|google\/gemini-3|deepseek|qwen3|moonshot|z-ai|x-ai|minimax/.test(s)).join('\n'))
    const k = await (await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${keys.openrouter[0]}` } })).json()
    console.log('OR KEY:', JSON.stringify({ limit: k.data?.limit, remaining: k.data?.limit_remaining, usage: k.data?.usage, free: k.data?.is_free_tier }))
  } catch (e) { console.log('openrouter error', e.message) }
  app.quit()
})
