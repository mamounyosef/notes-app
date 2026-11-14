import React from 'react'
import ReactDOM from 'react-dom/client'
import 'katex/dist/katex.min.css'
import '../../src/styles/index.css'
import './ui/mobile.css'
import { setBackend } from '../../src/lib/storage'
import { mobileBackend } from './sync/backend'
import * as assets from './sync/assets'
import { App } from './ui/App'
import ErrorBoundary from '../../src/components/ErrorBoundary'

setBackend(mobileBackend)

assets
  .init()
  .catch((e) => console.warn('assets init', e))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <ErrorBoundary label="Notes">
        <App />
      </ErrorBoundary>,
    )
  })
