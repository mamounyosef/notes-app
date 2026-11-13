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
import './styles/claude.css'

import { initClaudeBridge, useClaude, claudeSystemPrompt, claudeGuide } from './agent/claude'
import { fileToAttachment } from './agent/files'

// Handles for inspecting the app from DevTools and automated tests.
;(window as any).__notesDebug = { useStore, useAgent, useClaude, claudeSystemPrompt, claudeGuide, fileToAttachment, buildContext, keepDroppedStyles, runTool, TurnRecorder, agentToHtml, htmlToAgent, buildWidgetDoc, currentTheme, fromBase64, kindOf }

// Claude: runs note tools for chats here and for the Claude app or Claude Code outside Notes.
initClaudeBridge()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
