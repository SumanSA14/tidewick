import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'
import './home/home.css'
import './editor/editor.css'
import './db/database.css'
import './workspace/theme.css'

// Dev-only: exposes window.__tidewick.bench() for the erosion benchmark.
if (import.meta.env.DEV) {
  void import('./dev/benchmark').then((m) => m.installDevTools())
}

// The service worker only in production builds. In development it would cache
// the dev server's modules and serve yesterday's code with great confidence.
// Not inside the desktop shell: Tauri serves the app from its own origin and
// keeps it offline by construction, so a service worker there is a second cache
// with nothing to add.
const inTauri = '__TAURI_INTERNALS__' in window
if (inTauri && 'serviceWorker' in navigator) {
  // An earlier desktop build did register one, and it intercepted the next
  // build's module requests. Clear any that survives in the WebView2 profile.
  void navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => void r.unregister()))
}
if (import.meta.env.PROD && !inTauri && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Offline is a feature, not a requirement to boot: the app runs without it.
      console.warn('[tidewick] service worker not registered', err)
    })
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
