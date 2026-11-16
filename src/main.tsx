import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('The page has no #root element, so the game cannot start')

// Generating the world blocks the page for a few seconds.
// Waiting two frames lets the loading screen paint before that work starts.
requestAnimationFrame(() =>
  requestAnimationFrame(async () => {
    const { App } = await import('./App')
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
)
