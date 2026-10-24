import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import { useAgent } from './agent/store'
import { buildContext } from './agent/context'
import { keepDroppedStyles, runTool, TurnRecorder } from './agent/tools'
import { agentToHtml, htmlToAgent } from './agent/content'
import { buildWidgetDoc, currentTheme, fromBase64, kindOf } from './widgets/widget'
import 'katex/dist/katex.min.css'
import './styles/index.css'
import './styles/agent.css'
import './styles/voice.css'

// Handles for inspecting the app from DevTools and automated tests.
;(window as any).__notesDebug = { useStore, useAgent, buildContext, keepDroppedStyles, runTool, TurnRecorder, agentToHtml, htmlToAgent, buildWidgetDoc, currentTheme, fromBase64, kindOf }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
