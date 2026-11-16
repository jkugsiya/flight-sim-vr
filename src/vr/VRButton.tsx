import { useEffect, useState } from 'react'
import { useGame } from '../game/game'
import { enterVR, vrSupported } from './session'

/**
 * The Enter VR button, in the corner of the page whenever a headset can show the game. Over
 * plain HTTP it explains why VR is missing instead, since browsers allow VR only over HTTPS.
 */
export function VRButton() {
  const [supported, setSupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inVR = useGame(state => state.vr)
  useEffect(() => {
    let live = true
    void vrSupported().then(ok => {
      if (live) setSupported(ok)
    })
    return () => {
      live = false
    }
  }, [])

  if (inVR) return null
  if (!supported) {
    if (window.isSecureContext) return null
    return (
      <p className="bg-ink/80 text-marking fixed right-4 bottom-4 z-50 max-w-xs rounded-md px-3 py-2 text-sm">
        VR needs HTTPS. Open the https address the dev server prints.
      </p>
    )
  }
  const start = () => {
    setError(null)
    enterVR().catch((reason: unknown) => {
      setError(`VR did not start: ${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }
  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      {error && <p className="bg-warn max-w-xs rounded-md px-3 py-2 text-sm text-white">{error}</p>}
      <button
        type="button"
        onClick={start}
        className="bg-ink text-paper ring-paper/40 rounded-md px-5 py-3 text-lg font-bold shadow-lg ring-1 hover:brightness-125"
      >
        Enter VR
      </button>
    </div>
  )
}
